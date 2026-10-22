"""Refund demo: Argentic runs the loop, LangChain @tool functions are the tools.

Run once with ARGENTIC_CRASH_AFTER=1 (the process dies after the refund), then
run again: it skips the refund and finishes the rest.
"""
import json
import os
import random
import string
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "adapters", "python"))

from langchain_core.tools import tool  # noqa: E402

from argentic_labs import Argentic, hint_for, model_from_env, run_durable, summarize_replay  # noqa: E402
from argentic_labs.langchain import from_langchain_tools  # noqa: E402

TASK = ("Order 1182 (ticket T-77, customer dana@example.com) arrived broken. Refund the $42 order, "
        "email the customer that the refund is on its way, then close the ticket. Do one step at a time.")
SYSTEM = ("Your tool calls are requests; their outcomes arrive in the next message. Call one tool per turn. "
          "When everything is done, reply with a one-line summary and no tool call.")
TOOL_NAMES = ("refund_order", "send_email", "close_ticket")


def make_tools(outbox_path):
    """LangChain tools. Each side effect is appended to the outbox file."""
    def record(tool_name, **fields):
        with open(outbox_path, "a") as f:
            f.write(json.dumps({"tool": tool_name, **fields}) + "\n")

    @tool
    def refund_order(order_id: str, amount_usd: float) -> str:
        """Refund an order."""
        record("refund_order", order_id=order_id, amount_usd=amount_usd)
        return f"refunded ${amount_usd} on order {order_id}"

    @tool
    def send_email(to: str, subject: str, body: str) -> str:
        """Send an email to a customer."""
        record("send_email", to=to, subject=subject, body=body)
        return f"email sent to {to}"

    @tool
    def close_ticket(ticket_id: str, note: str) -> str:
        """Close a support ticket."""
        record("close_ticket", ticket_id=ticket_id, note=note)
        return f"ticket {ticket_id} closed"

    return [refund_order, send_email, close_ticket]


def load_state(path, fresh):
    """Agent id and run id, kept in a file so a rerun reuses them."""
    if not fresh and os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    suffix = "".join(random.choices(string.ascii_lowercase + string.digits, k=6))
    state = {"agent": f"refund-demo-{suffix}", "run_id": f"refund-{suffix}"}
    with open(path, "w") as f:
        json.dump(state, f)
    return state


def outbox_counts(path):
    counts = {n: 0 for n in TOOL_NAMES}
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                if line.strip():
                    counts[json.loads(line)["tool"]] += 1
    return counts


def run(client, workdir, model, fresh=False, crash_after=None, crash=None, log=print):
    state_path = os.path.join(workdir, ".argentic-refund-state.json")
    ledger_path = os.path.join(workdir, ".argentic-refund-ledger.json")
    outbox_path = os.path.join(workdir, "outbox.jsonl")
    if fresh:
        for p in (state_path, ledger_path, outbox_path):
            if os.path.exists(p):
                os.remove(p)
    state = load_state(state_path, fresh)
    log(f"agent {state['agent']}, run {state['run_id']}")

    extra = {"crash": crash} if crash else {}
    result = run_durable(
        client, agent=state["agent"], run_id=state["run_id"], task=TASK, system=SYSTEM,
        tools=from_langchain_tools(make_tools(outbox_path)),
        ledger_path=ledger_path, model=model, crash_after_actions=crash_after, log=log, **extra,
    )
    log(f"reply: {result.reply}")
    for wake_id in result.wakes:
        log(f"replay {wake_id}: {summarize_replay(client.replay(state['agent'], wake_id))}")
    dash = os.environ.get("ARGENTIC_DASHBOARD_URL", "https://getargentic.com").rstrip("/")
    # the first wake is the run that was cut off: a rerun gets its stored answer back under the same id
    if result.wakes:
        log(f"See every step, then press Check prompts under Proof of what ran: {dash}/platform/runs/{state['agent']}/{result.wakes[0]}/")
    counts = outbox_counts(outbox_path)
    log("outbox: " + ", ".join(f"{n} x{c}" for n, c in counts.items()))
    return result, counts


def main():
    crash_after = int(os.environ.get("ARGENTIC_CRASH_AFTER", "0")) or None
    client = Argentic()
    if not client.api_key or not client.model_key:
        sys.exit("Set ARGENTIC_API_KEY and MODEL_KEY first (see README.md).")
    run(client, os.getcwd(), model_from_env(), fresh="--fresh" in sys.argv, crash_after=crash_after)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        hint = hint_for(e)
        if hint is None:
            raise
        sys.exit(f"\n{e}\n{hint}")
