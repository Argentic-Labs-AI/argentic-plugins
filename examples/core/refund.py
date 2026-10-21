"""Refund demo with no framework: plain tools (a JSON schema and a handler) carry out the actions Argentic asks for.

Run once with ARGENTIC_CRASH_AFTER=1 to die after the refund, then run again.
"""
import json
import os
import random
import string
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "adapters", "python"))

from argentic_labs import Argentic, Tool, hint_for, model_from_env, run_durable, summarize_replay  # noqa: E402

TASK = ("Order 1182 (ticket T-77, customer dana@example.com) arrived broken. Refund the $42 order, "
        "email the customer that the refund is on its way, then close the ticket. Do one step at a time.")
SYSTEM = ("Tool calls are requests: their outcomes arrive in the next message. Call one tool per turn. "
          "When everything is done, reply with a one-line summary and no tool call.")
TOOL_NAMES = ("refund_order", "send_email", "close_ticket")


def make_tools(outbox_path):
    """Side effects land in a file so you can see nothing finished twice."""
    def record(key, name, **data):
        # Safe to repeat: the same idempotency key (agent:seq) is recorded once.
        if os.path.exists(outbox_path):
            with open(outbox_path) as f:
                if any(line.strip() and json.loads(line).get("key") == key for line in f):
                    return
        with open(outbox_path, "a") as f:
            f.write(json.dumps({"key": key, "tool": name, **data}) + "\n")

    def refund_order(args, ctx):
        record(ctx.idempotency_key, "refund_order", **args)
        return {"refunded": True, "order_id": args["order_id"], "amount_usd": args["amount_usd"]}

    def send_email(args, ctx):
        record(ctx.idempotency_key, "send_email", **args)
        return {"sent": True, "to": args["to"]}

    def close_ticket(args, ctx):
        record(ctx.idempotency_key, "close_ticket", **args)
        return {"closed": True, "ticket_id": args["ticket_id"]}

    string_ = {"type": "string"}
    return [
        Tool("refund_order", "Refund an order.",
             {"type": "object", "properties": {"order_id": string_, "amount_usd": {"type": "number"}}, "required": ["order_id", "amount_usd"]},
             refund_order),
        Tool("send_email", "Send an email to a customer.",
             {"type": "object", "properties": {"to": string_, "subject": string_, "body": string_}, "required": ["to", "subject", "body"]},
             send_email),
        Tool("close_ticket", "Close a support ticket with a note.",
             {"type": "object", "properties": {"ticket_id": string_, "note": string_}, "required": ["ticket_id", "note"]},
             close_ticket),
    ]


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
        tools=make_tools(outbox_path), ledger_path=ledger_path, model=model, crash_after_actions=crash_after, log=log, **extra,
    )
    log(f"reply: {result.reply}")
    for wake_id in result.wakes:
        log(f"replay {wake_id}: {summarize_replay(client.replay(state['agent'], wake_id))}")
    dash = os.environ.get("ARGENTIC_DASHBOARD_URL", "https://getargentic.com").rstrip("/")
    log(f"Open {dash}/platform -> Runs -> {state['agent']} to see the run timeline, then open the oldest run and press Check under Proof of what ran.")
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
