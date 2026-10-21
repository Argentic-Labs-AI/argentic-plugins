"""Argentic client and run_durable. Standard library only, Python 3.10+.

Argentic runs the agent loop. Your code declares tools and carries out the
actions Argentic hands back. run_durable keeps a small local ledger so a run
that is started again resumes without repeating a finished action.
"""
from __future__ import annotations

import asyncio
import http.client
import inspect
import json
import os
import re
import signal
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, TypedDict

__version__ = "0.1.5"

DEFAULT_BASE_URL = "https://api.getargentic.com"
BACKOFF = (1, 2, 4, 8)  # waits between the 5 tries on 5xx or network errors
MAX_QUEUED_WAITS = 60  # 409 "queued" answers waited out before giving up
TIMEOUT = 300.0  # seconds a socket may stay silent: a wake can run a long time, as with Node's fetch (300 s)


class ModelSpec(TypedDict):
    """The model a wake runs on. `prices` are dollars per million tokens, under `in` and `out`."""

    provider: str
    id: str
    prices: dict[str, float]


class Action(TypedDict, total=False):
    """One tool call the agent asked for. `seq` never changes, so it is safe to key on."""

    id: str | int
    tool: str
    args: dict[str, Any]
    seq: int


# The free default model (a free NVIDIA key from https://build.nvidia.com works with it).
FREE_MODEL: ModelSpec = {"provider": "nvidia", "id": "nvidia/nemotron-3.5-lightning-30b-a3b", "prices": {"in": 0.0, "out": 0.0}}


class ArgenticError(Exception):
    """A request failed in a way retrying will not fix.

    `status` is the HTTP status, or None when no answer came back. `body` is the parsed JSON error, if any.
    """

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
    """What a wake answered. `raw` is the whole JSON body, for fields this class does not name."""

    status: str  # done, turn_cap, time_cap, spend_cap, budget_cap, approval_required or error
    reply: str
    spent_usd: float
    turns: int
    wake_id: str
    actions: list[Action] = field(default_factory=list)
    replayed: bool = False  # True when the Idempotent-Replay header was set: this key was already answered
    raw: dict[str, Any] = field(default_factory=dict)
    resumed: bool | None = None  # True when the wake picked up a message the API had already recorded
    error: str | None = None  # why the model call failed, when status is "error"


def model_from_env(env: Mapping[str, str] | None = None) -> ModelSpec:
    """Model preset from ARGENTIC_MODEL_* variables. With ARGENTIC_MODEL_ID unset, the free default (FREE_MODEL)."""
    e = os.environ if env is None else env
    if not e.get("ARGENTIC_MODEL_ID"):
        return {**FREE_MODEL, "prices": dict(FREE_MODEL["prices"])}
    return {
        "provider": e.get("ARGENTIC_MODEL_PROVIDER", FREE_MODEL["provider"]),
        "id": e["ARGENTIC_MODEL_ID"],
        "prices": {
            "in": float(e.get("ARGENTIC_PRICE_IN", "0")),
            "out": float(e.get("ARGENTIC_PRICE_OUT", "0")),
        },
    }


class Argentic:
    """A small client for the Argentic API.

    `api_key` defaults to ARGENTIC_API_KEY, `model_key` (sent as X-Model-Key) to MODEL_KEY and `base_url` to
    ARGENTIC_BASE_URL, then to the production API. `timeout` is how long a socket may stay silent, in seconds.
    `backoff` lists the waits between retries of a 5xx or network failure, and `max_queued_waits` bounds
    the 409 "queued" retries.
    """

    def __init__(
        self,
        api_key: str | None = None,
        model_key: str | None = None,
        base_url: str | None = None,
        timeout: float = TIMEOUT,
        sleep: Callable[[float], None] = time.sleep,
        log: Callable[[str], None] = print,
        backoff: tuple[float, ...] = BACKOFF,
        max_queued_waits: int = MAX_QUEUED_WAITS,
    ):
        self.api_key = api_key or os.environ.get("ARGENTIC_API_KEY", "")
        self.model_key = model_key or os.environ.get("MODEL_KEY", "")
        self.base_url = (base_url or os.environ.get("ARGENTIC_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
        self.timeout = timeout
        self.backoff = tuple(backoff)
        self.max_queued_waits = max_queued_waits
        self._sleep = sleep
        self._log = log

    # One HTTP call. Returns (status, headers, parsed body). Never raises on HTTP errors.
    def _post(self, path: str, body: dict[str, Any], headers: dict[str, str]) -> tuple[int, Any, dict[str, Any]]:
        req = urllib.request.Request(
            self.base_url + path,
            data=json.dumps(body).encode(),
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
                "User-Agent": f"argentic-labs-python/{__version__}",
                **headers,
            },
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
        if not isinstance(data, dict):
            data = {"error": str(data)[:200]}
        return status, hdrs, data

    def _send(self, what: str, path: str, body: dict[str, Any], headers: dict[str, str]) -> tuple[Any, dict[str, Any]]:
        """POST until it answers 2xx, then return (headers, body). A queued (409) answer waits and resends, a 5xx or
        network error retries with backoff, and anything else raises ArgenticError."""
        failures = 0
        queued = 0
        while True:
            net: BaseException | None = None
            try:
                status, hdrs, data = self._post(path, body, headers)
            except (urllib.error.URLError, http.client.HTTPException, OSError) as e:  # TimeoutError is an OSError
                net = e
                status, hdrs, data = None, {}, {"error": str(e)}
            if status is not None and 200 <= status < 300:
                return hdrs, data
            if status == 409:  # queued: wait, then send the SAME request with the SAME key
                queued += 1
                if queued > self.max_queued_waits:
                    raise ArgenticError(f"{what} stayed queued", status, data)
                retry_after = data.get("retry_after")
                wait = min(max(float(retry_after), 0.0), 5.0) if isinstance(retry_after, (int, float)) else 1.0
                self._sleep(wait)
                continue
            if status == 422 and data.get("error") == "idempotency_key_reused":
                raise ArgenticError("idempotency key reused with a different body (a bug)", status, data)
            if status is None or status >= 500:  # 5xx or network: retry the same key with backoff
                said = f"HTTP {status}" if status is not None else f"no answer: {net}"
                if failures >= len(self.backoff):
                    raise ArgenticError(f"{what} failed after {failures + 1} tries ({said})", status, data)
                self._log(f"  {what} got {said}, retrying in {self.backoff[failures]}s with the same key")
                self._sleep(self.backoff[failures])
                failures += 1
                continue
            detail = data.get("detail")
            more = f": {detail if isinstance(detail, str) else json.dumps(detail)}" if detail is not None else ""
            raise ArgenticError(f"{what} failed: HTTP {status} {data.get('error', '')}{more}".strip(), status, data)

    def wake(
        self,
        agent: str,
        message: str,
        *,
        model: Mapping[str, Any],
        idempotency_key: str,
        system: str | None = None,
        tools: list[dict[str, Any]] | None = None,
        limits: Mapping[str, Any] | None = None,
    ) -> WakeResponse:
        """Wake an agent with a message. Safe to call again with the same key: a queued (409) answer waits and
        resends, a 5xx or network error retries with backoff, and a reused key with a different body raises."""
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
        hdrs, data = self._send("wake", f"/v1/agents/{urllib.parse.quote(agent, safe='')}/wake", body, headers)
        return WakeResponse(
            status=data.get("status", ""),
            reply=data.get("reply") or "",
            spent_usd=float(data.get("spent_usd") or 0),
            turns=int(data.get("turns") or 0),
            wake_id=data.get("wake_id") or "",
            actions=data.get("actions") or [],
            replayed=str(hdrs.get("Idempotent-Replay", "")).lower() == "true",
            raw=data,
            resumed=data.get("resumed"),
            error=data.get("error"),
        )

    def replay(self, agent: str, wake: str) -> dict[str, Any]:
        """Re-render a wake's prompts from the journal and compare them to what the model was shown. Spends nothing.

        The answer always has `turns`, `matched`, `mismatched` and `unverifiable` (turns with no recorded fingerprint)."""
        _, data = self._send("replay", f"/v1/agents/{urllib.parse.quote(agent, safe='')}/replay", {"wake": wake}, {})
        turns = data.get("turns") or []

        def count(match: bool | None) -> int:
            return sum(1 for t in turns if t.get("match") is match)

        return {
            **data,
            "turns": turns,
            "matched": data.get("matched", count(True)),
            "mismatched": data.get("mismatched", count(False)),
            "unverifiable": data.get("unverifiable", count(None)),
        }


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
    """A tool the agent may call. `parameters` is a JSON schema. `execute` may be a plain function or an async one."""

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
    status: str  # the last wake's status, or "max_steps" when no wake ran
    spent_usd: float


class Ledger:
    """Results of finished actions, keyed by f"{agent}:{seq}", in a local JSON file saved atomically.
    Also wakes that stopped at their turn or time limit with actions to run. The file has the same shape
    as the TypeScript client's, so either client can resume a run the other started."""

    def __init__(self, path: str):
        self.path = path
        self.entries: dict[str, Any] = {}
        self.wakes: dict[str, Any] = {}
        if os.path.exists(path):
            with open(path) as f:
                saved = json.load(f)
            if isinstance(saved, dict) and isinstance(saved.get("entries"), dict):
                self.entries = saved["entries"]
                self.wakes = saved.get("wakes") or {}
            elif isinstance(saved, dict):  # a flat file, as this package wrote it before 0.1.4
                self.wakes = saved.pop("_wakes", None) or {}
                self.entries = saved

    def get(self, key: str) -> Any | None:
        return self.entries.get(key)

    def get_wake(self, key: str) -> dict[str, Any] | None:
        return self.wakes.get(key)

    def put_wake(self, key: str, wake: dict[str, Any]) -> None:
        self.wakes[key] = wake
        self._save()

    def put(self, key: str, entry: dict[str, Any]) -> None:
        self.entries[key] = entry
        self._save()

    def _save(self) -> None:
        d = os.path.dirname(os.path.abspath(self.path))
        os.makedirs(d, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=d, prefix=".argentic-ledger-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as f:
                json.dump({"entries": self.entries, "wakes": self.wakes} if self.wakes else {"entries": self.entries}, f, indent=2)
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


def _settle(value: Any) -> Any:
    """A handler may be async: run it to its result, on a thread of its own if an event loop is already running."""
    if not inspect.isawaitable(value):
        return value

    async def wait() -> Any:
        return await value

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(wait())
    with ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, wait()).result()


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
    model: Mapping[str, Any] | None = None,
    system: str | None = None,
    max_steps: int = 8,
    limits: Mapping[str, Any] | None = None,
    on_wake_start: Callable[[int], None] | None = None,
    on_wake: Callable[[int, str, str, bool], None] | None = None,
    on_action: Callable[[int, str, Any, bool], None] | None = None,
    crash_after_actions: int | None = None,
    crash: Callable[[], None] = _kill_self,
    log: Callable[[str], None] = print,
) -> RunResult:
    """Run a task to the end. Start it again after a crash and it resumes
    without repeating a finished action. Actions cut off mid-run run again,
    so handlers should use ctx.idempotency_key (at-least-once).

    `model` defaults to FREE_MODEL. Hooks: `on_wake_start(step)` just before each wake is sent (the first answer can
    take several seconds), `on_wake(step, wake_id, status, replayed)` after each answer, where `replayed` means the
    API sent back its stored answer or the ledger kept a stopped one, and `on_action(seq, tool, result, fresh)` for
    every action, `fresh` being False for one the ledger says already finished, which is not run again."""
    ledger = Ledger(ledger_path)
    by_name = {t.name: t for t in tools}
    declared = [{"name": t.name, "description": t.description or t.name,
                 "parameters": to_argentic_schema(t.parameters)} for t in tools]
    wakes: list[str] = []
    spent = 0.0
    reply, status, steps = "", "max_steps", 0
    previous: list[dict[str, Any]] = []  # [{tool, seq, result}] from the ledger
    fresh = 0  # actions newly executed in this process

    for step in range(max_steps):
        if step == 0:
            message = task
        else:
            message = "Results of the tools you asked for:\n" + json.dumps(previous)
        key = _key_part(f"{run_id}.{step}")[:128]
        if on_wake_start:
            on_wake_start(step)
        # A stopped wake kept in the ledger is not asked again: its actions get their results under the next key.
        kept = ledger.get_wake(key)
        if kept is not None:
            resp = WakeResponse(**{**kept, "replayed": True})
        else:
            resp = client.wake(
                agent, message, model=model or FREE_MODEL, idempotency_key=key,
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
        if on_wake:
            on_wake(step, resp.wake_id, resp.status, resp.replayed)

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
                        result = _settle(tool.execute(args, ToolContext(seq, lkey)))
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
