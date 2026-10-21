"""`python -m argentic_labs demo` (or `argentic-labs demo`): kill an agent mid-run, run it again, and watch it skip what already finished.

Uses only this package. State lives in ./.argentic-demo/ (the same folder the npm client's demo uses), so a rerun from the same folder picks up the same run.
"""
from __future__ import annotations

import json
import os
import random
import shutil
import signal
import string
import sys
import time
from datetime import datetime, timezone
from typing import Any, Callable

from .core import Argentic, ArgenticError, Ledger, Tool, ToolContext, hint_for, model_from_env, run_durable

SYSTEM = (
    "Tool calls are requests: their outcomes arrive in the next message. "
    "Call one tool per turn. When everything is done, reply with a one-line summary and no tool call."
)

TASK = (
    "Order 1182 (ticket T-77, customer dana@example.com) arrived broken. Refund the $42 order, "
    "email the customer that the refund is on its way, then close the ticket. Do one step at a time."
)

USAGE = """Usage: argentic-labs demo [--fresh] [--kill-after N]
       python -m argentic_labs demo [--fresh] [--kill-after N]

  --fresh         start a new run (forget the one in ./.argentic-demo/)
  --kill-after N  kill the process yourself after N actions, instead of pressing Ctrl-C

Needs ARGENTIC_API_KEY (from https://getargentic.com/platform) and MODEL_KEY
(your model provider's key; the default model is a free NVIDIA one, key from https://build.nvidia.com)."""

TOOL_NAMES = ("refund_order", "send_email", "close_ticket")


def _paint(code: str, enabled: bool) -> Callable[[str], str]:
    return lambda s: f"\x1b[{code}m{s}\x1b[0m" if enabled else s


def make_tools(outbox: str, work_ms: float, out: Callable[[str], None], paint: dict[str, Callable[[str], str]] | None = None) -> list[Tool]:
    """The side effects land in outbox.jsonl, keyed by the action's stable key, so a repeat is visible and harmless."""
    p = paint or {}
    dim, bold, green, yellow = (p.get(n, str) for n in ("dim", "bold", "green", "yellow"))

    def sent(key: str) -> bool:
        if not os.path.exists(outbox):
            return False
        with open(outbox) as f:
            return any(line.strip() and json.loads(line).get("key") == key for line in f)

    def act(key: str, seq: int, tool: str, what: str, data: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
        sys.stdout.write(f"  {bold('▸')} #{seq} {tool.ljust(14)} {what} {dim('…')}")
        sys.stdout.flush()
        time.sleep(work_ms / 1000)
        if sent(key):
            out(f" {yellow('already in the outbox under this key, not sent again')}")
        else:
            with open(outbox, "a") as f:
                f.write(json.dumps({"key": key, "tool": tool, **data, "at": datetime.now(timezone.utc).isoformat()}) + "\n")
            out(f" {green('done')}")
        return result

    string = {"type": "string"}

    def refund(a: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        return act(ctx.idempotency_key, ctx.seq, "refund_order", f"${a.get('amount_usd')} on order {a.get('order_id')}", a,
                   {"refunded": True, "order_id": a.get("order_id"), "amount_usd": a.get("amount_usd")})

    def email(a: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        return act(ctx.idempotency_key, ctx.seq, "send_email", f"to {a.get('to')}", a, {"sent": True, "to": a.get("to")})

    def close(a: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        return act(ctx.idempotency_key, ctx.seq, "close_ticket", f"ticket {a.get('ticket_id')}", a, {"closed": True, "ticket_id": a.get("ticket_id")})

    return [
        Tool("refund_order", "Refund an order.",
             {"type": "object", "properties": {"order_id": string, "amount_usd": {"type": "number"}}, "required": ["order_id", "amount_usd"]}, refund),
        Tool("send_email", "Send an email to a customer.",
             {"type": "object", "properties": {"to": string, "subject": string, "body": string}, "required": ["to", "subject", "body"]}, email),
        Tool("close_ticket", "Close a support ticket with a note.",
             {"type": "object", "properties": {"ticket_id": string, "note": string}, "required": ["ticket_id", "note"]}, close),
    ]


def outbox_counts(outbox: str) -> dict[str, int]:
    counts = {n: 0 for n in TOOL_NAMES}
    if os.path.exists(outbox):
        with open(outbox) as f:
            for line in f:
                if line.strip():
                    tool = json.loads(line)["tool"]
                    counts[tool] = counts.get(tool, 0) + 1
    return counts


def demo(argv: list[str], client: Argentic | None = None, env: dict[str, str] | None = None) -> int:
    e = os.environ if env is None else env
    api_key, model_key = e.get("ARGENTIC_API_KEY"), e.get("MODEL_KEY")
    if client is None and not (api_key and model_key):
        print(f"Set ARGENTIC_API_KEY and MODEL_KEY first.\n\n{USAGE}", file=sys.stderr)
        return 1
    color = sys.stdout.isatty() and not e.get("NO_COLOR")
    dim, bold, green, yellow = (_paint(c, color) for c in ("2", "1", "32", "33"))

    def out(s: str = "") -> None:
        print(s, flush=True)

    kill_after: int | None = None
    if "--kill-after" in argv:
        at = argv.index("--kill-after")
        try:
            kill_after = int(argv[at + 1]) or None
        except (IndexError, ValueError):
            kill_after = None
    d = ".argentic-demo"
    state_path, ledger_path, outbox = (os.path.join(d, n) for n in ("run.json", "ledger.json", "outbox.jsonl"))
    if "--fresh" in argv:
        shutil.rmtree(d, ignore_errors=True)
    os.makedirs(d, exist_ok=True)

    resuming = os.path.exists(state_path)
    if not resuming:
        ident = "".join(random.choices(string.ascii_lowercase + string.digits, k=6))
        with open(state_path, "w") as f:
            json.dump({"agent": f"kill-demo-{ident}", "runId": f"run-{ident}"}, f)
    with open(state_path) as f:
        state = json.load(f)
    agent, run_id = state["agent"], state["runId"]
    finished_before = len(Ledger(ledger_path).entries)

    out(bold("Argentic: kill it mid-run"))
    out(dim(f"agent {agent}, run {run_id}, state in ./{d}/"))
    out()
    if not resuming:
        out("A support agent works one ticket in three actions: refund the order, email the customer, close the ticket.")
        out(f"Press {bold('Ctrl-C')} while it works, then run the same command again.")
    else:
        out(f"Picking up {run_id}: {finished_before} action{'' if finished_before == 1 else 's'} finished before it stopped.")
        out("Same run, same keys. Finished actions are skipped, the rest carry on.")
    out()

    def interrupted(*_: Any) -> None:
        out("\n")
        out(yellow("Killed mid-run.") + " Run the same command again and it picks up where it stopped.")
        raise SystemExit(130)

    signal.signal(signal.SIGINT, interrupted)

    client = client or Argentic(api_key=api_key, model_key=model_key)
    ran = 0
    hinted = resuming or kill_after is not None

    def on_wake_start(step: int) -> None:
        if step == 0 and not resuming:
            out(dim("  The first answer can take 15 seconds and nothing runs before it, so wait for the first action before pressing Ctrl-C."))
        sys.stdout.write(dim(f"  model turn {step + 1}: asking the model… "))
        sys.stdout.flush()

    def on_wake(step: int, wake_id: str, status: str, replayed: bool) -> None:
        out(dim("answer already in the journal, sent back without calling the model again" if replayed else "answered"))

    def on_action(seq: int, tool: str, result: Any, fresh: bool) -> None:
        nonlocal ran, hinted
        if not fresh:
            out(f"  {dim('↷')} #{seq} {tool.ljust(14)} {dim('finished on an earlier run, skipped')}")
            return
        ran += 1
        if kill_after and ran >= kill_after:
            out(yellow(f"\nKilling the process now (--kill-after {kill_after}). Run the same command without it."))
        elif not hinted:
            hinted = True
            out(yellow("  Now is a good time to press Ctrl-C."))

    res = run_durable(
        client, agent=agent, run_id=run_id, task=TASK, system=SYSTEM,
        tools=make_tools(outbox, float(e.get("ARGENTIC_DEMO_WORK_MS", 1500)), out, {"dim": dim, "bold": bold, "green": green, "yellow": yellow}),
        ledger_path=ledger_path, model=model_from_env(e), max_steps=10,
        crash_after_actions=kill_after, log=lambda s: None,
        on_wake_start=on_wake_start, on_wake=on_wake, on_action=on_action,
    )

    out()
    out(f"{bold('Reply:')} {res.reply or dim('(none)')}")
    out(dim(f"status {res.status}, {res.steps} model turns, {ran} action{'' if ran == 1 else 's'} run in this process, spent ${res.spent_usd:.4f}"))

    out()
    out(bold("What happened, from the outbox") + dim(f" (./{outbox})"))
    for tool, n in outbox_counts(outbox).items():
        out(f"  {tool.ljust(14)} {green('1 time') if n == 1 else yellow(f'{n} times')}")

    out()
    out(bold("Proof of what ran") + dim(" (re-renders each prompt from the journal and compares it with what the model was sent; free)"))
    clean = True
    for wake in res.wakes:
        r = client.replay(agent, wake)
        ok = r["mismatched"] == 0 and r["unverifiable"] == 0
        clean = clean and ok
        out(f"  {wake}  {green('all match') if ok else yellow(str(r['mismatched']) + ' differ, ' + str(r['unverifiable']) + ' not checkable')}")
    if res.status != "done":
        out(yellow(f"\nThe run stopped with status {res.status}. Run the same command again to carry on."))

    dash = (e.get("ARGENTIC_DASHBOARD_URL") or "https://getargentic.com").rstrip("/")
    out()
    out(f"See it in the dashboard: {dash}/platform/ {dim('->')} Runs {dim('->')} {agent}")
    out(dim("Open the oldest run (the one you killed) and press Check under Proof of what ran."))
    out(dim("Start over with --fresh."))
    return 0 if clean else 1


def main(argv: list[str] | None = None) -> None:
    args = sys.argv[1:] if argv is None else argv
    cmd, rest = (args[0], args[1:]) if args else (None, [])
    if cmd != "demo":
        print(USAGE)
        raise SystemExit(0 if cmd in (None, "--help", "-h") else 1)
    try:
        code = demo(rest)
    except ArgenticError as err:
        hint = hint_for(err)
        if hint is None:
            raise
        print(f"\n{err}\n{hint}", file=sys.stderr)
        code = 1
    raise SystemExit(code)
