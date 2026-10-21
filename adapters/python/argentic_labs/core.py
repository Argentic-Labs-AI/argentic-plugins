"""Argentic client and run_durable. Standard library only, Python 3.10+.

Argentic runs the agent loop. Your code declares tools and carries out the
actions Argentic hands back. run_durable keeps a small local ledger so a run
that is started again resumes without repeating a finished action.
"""
from __future__ import annotations

import json
import os
import re
import signal
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable

DEFAULT_BASE_URL = "https://api.getargentic.com"
BACKOFF = (1, 2, 4, 8)  # waits between the 5 tries on 5xx or network errors


class ArgenticError(Exception):
    """A request failed in a way retrying will not fix."""

    def __init__(self, message: str, status: int | None = None, body: Any = None):
        super().__init__(message)
        self.status = status
        self.body = body


def hint_for(e: BaseException) -> str | None:
    """A next step for an error a first run tends to hit, or None. Examples print it instead of a traceback."""
    if not isinstance(e, ArgenticError):
        return None
    code = e.body.get("error") if isinstance(e.body, dict) else None
    if e.status == 401:
        return "Check ARGENTIC_API_KEY. A key only works on the API it was made for, so if you set ARGENTIC_BASE_URL, make the key in that dashboard."
    if code == "model_key_rejected":
        return "Your model provider refused MODEL_KEY. Check it is a key for the provider in the error (a free NVIDIA key starts with nvapi-)."
    if code == "bad_model":
        return "Your provider does not know this model id. Set ARGENTIC_MODEL_ID to one it serves, or unset it for the free default."
    if e.status == 402:
        return "This account hit its usage limit. Argentic is free in beta, so there is nothing to buy: email hi@getargentic.com and we will raise it."
    if e.status == 429:
        return "Too many requests a minute for this key. Wait for the time in the error and run the same command again."
    if e.status is None or e.status >= 500:
        return "The API did not answer. Run the same command again in a minute: it picks up where it stopped."
    return None


@dataclass
class WakeResponse:
    status: str
    reply: str
    spent_usd: float
    turns: int
    wake_id: str
    actions: list[dict[str, Any]] = field(default_factory=list)
    replayed: bool = False  # True when the Idempotent-Replay header was set
    raw: dict[str, Any] = field(default_factory=dict)


def model_from_env(env: dict[str, str] | None = None) -> dict[str, Any]:
    """Model preset from ARGENTIC_MODEL_* variables; defaults to the free NVIDIA one."""
    e = os.environ if env is None else env
    return {
        "provider": e.get("ARGENTIC_MODEL_PROVIDER", "nvidia"),
        "id": e.get("ARGENTIC_MODEL_ID", "nvidia/nemotron-3.5-lightning-30b-a3b"),
        "prices": {
            "in": float(e.get("ARGENTIC_PRICE_IN", "0")),
            "out": float(e.get("ARGENTIC_PRICE_OUT", "0")),
        },
    }


class Argentic:
    def __init__(
        self,
        api_key: str | None = None,
        model_key: str | None = None,
        base_url: str | None = None,
        timeout: float = 120.0,
        sleep: Callable[[float], None] = time.sleep,
        log: Callable[[str], None] = print,
    ):
        self.api_key = api_key or os.environ.get("ARGENTIC_API_KEY", "")
        self.model_key = model_key or os.environ.get("MODEL_KEY", "")
        self.base_url = (base_url or os.environ.get("ARGENTIC_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
        self.timeout = timeout
        self._sleep = sleep
        self._log = log

    # One HTTP call. Returns (status, headers, parsed body). Never raises on HTTP errors.
    def _post(self, path: str, body: dict[str, Any], headers: dict[str, str]) -> tuple[int, Any, Any]:
        req = urllib.request.Request(
            self.base_url + path,
            data=json.dumps(body).encode(),
            method="POST",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.api_key}", **headers},
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                status, hdrs, raw = r.status, r.headers, r.read()
        except urllib.error.HTTPError as e:
            status, hdrs, raw = e.code, e.headers, e.read()
        try:
            data = json.loads(raw) if raw else {}
        except ValueError:
            data = {"error": raw.decode(errors="replace")[:200]}
        return status, hdrs, data

    def wake(
        self,
        agent: str,
        message: str,
        *,
        model: dict[str, Any],
        idempotency_key: str,
        system: str | None = None,
        tools: list[dict[str, Any]] | None = None,
        limits: dict[str, Any] | None = None,
    ) -> WakeResponse:
        body: dict[str, Any] = {"message": message, "model": model}
        if system:
            body["system"] = system
        if tools:
            body["tools"] = tools
        if limits:
            body["limits"] = limits
        headers = {"Idempotency-Key": idempotency_key}
        if self.model_key:
            headers["X-Model-Key"] = self.model_key

        failures = 0
        queued = 0
        while True:
            try:
                status, hdrs, data = self._post(f"/v1/agents/{agent}/wake", body, headers)
            except (urllib.error.URLError, OSError, TimeoutError) as e:
                status, hdrs, data = 599, {}, {"error": str(e)}
            if status == 200:
                return WakeResponse(
                    status=data.get("status", ""),
                    reply=data.get("reply") or "",
                    spent_usd=float(data.get("spent_usd") or 0),
                    turns=int(data.get("turns") or 0),
                    wake_id=data.get("wake_id") or "",
                    actions=data.get("actions") or [],
                    replayed=str(hdrs.get("Idempotent-Replay", "")).lower() == "true",
                    raw=data,
                )
            if status == 409:  # queued: wait, then send the SAME request with the SAME key
                queued += 1
                if queued > 60:
                    raise ArgenticError("wake stayed queued", status, data)
                self._sleep(min(float(data.get("retry_after") or 1), 5))
                continue
            if status == 422 and data.get("error") == "idempotency_key_reused":
                raise ArgenticError("idempotency key reused with a different body (a bug)", status, data)
            if status >= 500:  # 5xx or network: retry the same key with backoff
                if failures >= len(BACKOFF):
                    raise ArgenticError(f"wake failed after {failures + 1} tries (HTTP {status})", status, data)
                self._log(f"  wake got HTTP {status}, retrying in {BACKOFF[failures]}s with the same key")
                self._sleep(BACKOFF[failures])
                failures += 1
                continue
            detail = data.get("detail")
            more = f": {detail if isinstance(detail, str) else json.dumps(detail)}" if detail is not None else ""
            raise ArgenticError(f"wake failed: HTTP {status} {data.get('error', '')}{more}".strip(), status, data)

    def replay(self, agent: str, wake: str) -> dict[str, Any]:
        """Re-render a wake's prompts from the journal and compare them to what was recorded."""
        status, _, data = self._post(f"/v1/agents/{agent}/replay", {"wake": wake}, {})
        if status != 200:
            raise ArgenticError(f"replay failed: HTTP {status} {data.get('error', '')}".strip(), status, data)
        return data


def summarize_replay(result: dict[str, Any]) -> str:
    """One line: how many turns, and whether they match the recorded fingerprints."""
    turns = result.get("turns") or []
    differ = [str(t.get("turn_seq")) for t in turns if t.get("match") is False]
    unchecked = sum(1 for t in turns if t.get("match") is None)
    if differ:
        return f"{len(turns)} turns, differ at turn {', '.join(differ)}"
    if unchecked:
        return f"{len(turns)} turns, {len(turns) - unchecked} match, {unchecked} could not be checked"
    return f"{len(turns)} turn{'' if len(turns) == 1 else 's'}, all match"


# ---- durable runs ---------------------------------------------------------

@dataclass
class Tool:
    name: str
    description: str
    parameters: dict[str, Any]
    execute: Callable[[dict[str, Any], "ToolContext"], Any]


@dataclass
class ToolContext:
    seq: int
    idempotency_key: str  # f"{agent}:{seq}": use it to make a handler safe to repeat


@dataclass
class RunResult:
    reply: str
    wakes: list[str]
    steps: int
    status: str
    spent_usd: float


_WAKES = "_wakes"  # no colon, so never an action key


class Ledger:
    """Results of finished actions, keyed by f"{agent}:{seq}". Saved atomically.
    Under "_wakes", wakes that stopped at their turn or time limit with actions to run."""

    def __init__(self, path: str):
        self.path = path
        self.entries: dict[str, Any] = {}
        if os.path.exists(path):
            with open(path) as f:
                self.entries = json.load(f)

    def get(self, key: str) -> Any | None:
        return self.entries.get(key)

    def get_wake(self, key: str) -> dict[str, Any] | None:
        return self.entries.get(_WAKES, {}).get(key)

    def put_wake(self, key: str, wake: dict[str, Any]) -> None:
        self.put(_WAKES, {**self.entries.get(_WAKES, {}), key: wake})

    def put(self, key: str, entry: dict[str, Any]) -> None:
        self.entries[key] = entry
        d = os.path.dirname(os.path.abspath(self.path))
        fd, tmp = tempfile.mkstemp(dir=d, prefix=".argentic-ledger-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(self.entries, f, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise


def _kill_self() -> None:
    os.kill(os.getpid(), signal.SIGKILL)


def _key_part(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.:-]", "-", s)


# A wake stopped by its turn or time limit leaves the agent mid-task. Its actions have not been
# answered, so the next wake sends their results and the agent carries on from there with them,
# instead of the same key resuming it blind.
_CARRIES_ON = ("turn_cap", "time_cap")


def to_argentic_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Trim a JSON schema to the subset Argentic accepts: an object of string, number,
    integer, boolean or array-of-those properties, with description, enum and required.
    Framework extras ($schema, additionalProperties, title, defaults) are dropped."""
    props: dict[str, Any] = {}
    for name, prop in (schema or {}).get("properties", {}).items():
        out = {k: prop[k] for k in ("type", "description", "enum") if k in prop}
        if prop.get("type") == "array" and isinstance(prop.get("items"), dict) and "type" in prop["items"]:
            out["items"] = {"type": prop["items"]["type"]}
        props[name] = out
    result: dict[str, Any] = {"type": "object", "properties": props}
    if schema and schema.get("required"):
        result["required"] = list(schema["required"])
    return result


def run_durable(
    client: Argentic,
    *,
    agent: str,
    run_id: str,
    task: str,
    tools: list[Tool],
    ledger_path: str,
    model: dict[str, Any],
    system: str | None = None,
    max_steps: int = 8,
    limits: dict[str, Any] | None = None,
    on_action: Callable[[int, str, Any, bool], None] | None = None,
    crash_after_actions: int | None = None,
    crash: Callable[[], None] = _kill_self,
    log: Callable[[str], None] = print,
) -> RunResult:
    """Run a task to the end. Start it again after a crash and it resumes
    without repeating a finished action. Actions cut off mid-run run again,
    so handlers should use ctx.idempotency_key (at-least-once)."""
    ledger = Ledger(ledger_path)
    by_name = {t.name: t for t in tools}
    declared = [{"name": t.name, "description": t.description or t.name,
                 "parameters": to_argentic_schema(t.parameters)} for t in tools]
    wakes: list[str] = []
    spent = 0.0
    reply, status, steps = "", "done", 0
    previous: list[dict[str, Any]] = []  # [{tool, seq, result}] from the ledger
    fresh = 0  # actions newly executed in this process

    for step in range(max_steps):
        if step == 0:
            message = task
        else:
            message = "Results of the tools you asked for:\n" + json.dumps(previous)
        key = _key_part(f"{run_id}.{step}")[:128]
        # A stopped wake kept in the ledger is not asked again: its actions get their results under the next key.
        kept = ledger.get_wake(key)
        if kept is not None:
            resp = WakeResponse(**{**kept, "replayed": True})
        else:
            resp = client.wake(
                agent, message, model=model, idempotency_key=key,
                system=system, tools=declared, limits=limits,
            )
            if resp.status in _CARRIES_ON and resp.actions:
                ledger.put_wake(key, {k: v for k, v in vars(resp).items() if k != "replayed"})
        steps = step + 1
        wakes.append(resp.wake_id)
        spent += resp.spent_usd
        reply, status = resp.reply, resp.status
        note = " (stopped answer kept in the ledger)" if kept is not None else " (answer replayed)" if resp.replayed else ""
        log(f"step {step}: wake {resp.wake_id} status={resp.status}{note}")

        previous = []
        for action in resp.actions:
            seq, name = int(action["seq"]), action["tool"]
            lkey = f"{agent}:{seq}"
            entry = ledger.get(lkey)
            if entry is not None:
                log(f"  skip seq {seq} {name}: already done before")
                if on_action:
                    on_action(seq, name, entry["result"], False)
            else:
                tool = by_name.get(name)
                args = action.get("args") or {}
                if tool is None:
                    result: Any = {"error": "unknown tool"}
                else:
                    try:
                        result = tool.execute(args, ToolContext(seq, lkey))
                    except Exception as e:  # recorded, the agent hears about it
                        result = {"error": str(e)}
                result = json.loads(json.dumps(result, default=str))
                entry = {"tool": name, "args": args, "result": result,
                         "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
                ledger.put(lkey, entry)  # written before the next action
                log(f"  ran seq {seq} {name}")
                if on_action:
                    on_action(seq, name, result, True)
                fresh += 1
                if crash_after_actions and fresh >= crash_after_actions:
                    log(f"  simulated crash after {fresh} new action(s)")
                    crash()
            previous.append({"tool": name, "seq": seq, "result": entry["result"]})

        if not resp.actions or not (resp.status == "done" or resp.status in _CARRIES_ON):
            break

    return RunResult(reply=reply, wakes=wakes, steps=steps, status=status, spent_usd=spent)
