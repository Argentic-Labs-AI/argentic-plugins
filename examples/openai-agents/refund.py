"""Refund demo: Argentic runs the loop, OpenAI Agents SDK @function_tool functions are the tools.

Run once with ARGENTIC_CRASH_AFTER=1 (the process dies after the refund), then
run again: it skips the refund and finishes the rest.
"""
import json
import os
import random
import string
import sys
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "adapters", "python"))

from agents import Agent, function_tool  # noqa: E402
from agents.tool_context import ToolContext  # noqa: E402

from argentic import Argentic, model_from_env, run_durable, summarize_replay  # noqa: E402
from argentic_openai_agents import from_openai_agents_tools, instructions  # noqa: E402

TASK = ("Order 1182 (ticket T-77, customer dana@example.com) arrived broken. Refund the $42 order, "
        "email the customer that the refund is on its way, then close the ticket. Do one step at a time.")
SYSTEM = ("Your tool calls are requests; their outcomes arrive in the next message. Call one tool per turn. "
          "When everything is done, reply with a one-line summary and no tool call.")
TOOL_NAMES = ("refund_order", "send_email", "close_ticket")


def make_agent(outbox_path):
    """An OpenAI Agents SDK Agent. Each side effect is appended to the outbox file, once per tool call id."""
    def record(ctx, tool_name, **fields):
        key = ctx.tool_call_id  # "<agent>:<seq>", stable across a resume
        if os.path.exists(outbox_path):
            with open(outbox_path) as f:
                if any(line.strip() and json.loads(line)["key"] == key for line in f):
                    return
        with open(outbox_path, "a") as f:
            f.write(json.dumps({"key": key, "tool": tool_name, **fields}) + "\n")

    @function_tool
    def refund_order(ctx: ToolContext[Any], order_id: str, amount_usd: float) -> str:
        """Refund an order."""
        record(ctx, "refund_order", order_id=order_id, amount_usd=amount_usd)
        return f"refunded ${amount_usd} on order {order_id}"

    @function_tool
    def send_email(ctx: ToolContext[Any], to: str, subject: str, body: str) -> str:
        """Send an email to a customer."""
        record(ctx, "send_email", to=to, subject=subject, body=body)
        return f"email sent to {to}"

    @function_tool
    def close_ticket(ctx: ToolContext[Any], ticket_id: str, note: str) -> str:
        """Close a support ticket with a note."""
        record(ctx, "close_ticket", ticket_id=ticket_id, note=note)
        return f"ticket {ticket_id} closed"

    return Agent(name="support", instructions=SYSTEM, tools=[refund_order, send_email, close_ticket])


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

    agent = make_agent(outbox_path)
    extra = {"crash": crash} if crash else {}
    result = run_durable(
        client, agent=state["agent"], run_id=state["run_id"], task=TASK, system=instructions(agent),
        tools=from_openai_agents_tools(agent.tools),
        ledger_path=ledger_path, model=model, crash_after_actions=crash_after, log=log, **extra,
    )
    log(f"reply: {result.reply}")
    for wake_id in result.wakes:
        log(f"replay {wake_id}: {summarize_replay(client.replay(state['agent'], wake_id))}")
    dash = os.environ.get("ARGENTIC_DASHBOARD_URL", "https://argentic-labs.vercel.app").rstrip("/")
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
    main()
