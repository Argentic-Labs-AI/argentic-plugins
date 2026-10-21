"""The client against a real hosted engine, with a scripted model in place of the provider. Not part of discover (no test_ prefix).

Start the engine from an agent-lab checkout, with a clean environment so no real key can leak in (it prints the keys' files):

    createdb loadtest_hosted        # a scratch Postgres, e.g. from tools/cloud-setup.sh
    env -i PATH=$PATH HOME=$HOME DATABASE_URL=postgres://ctx:ctx@127.0.0.1:5432/loadtest_hosted PORT=37100 \\
        NV_LATENCY_MS=80 NV_SIGMA=0.1 NV_RPM=10000 TENANT_RPM=600 \\
        KEY_FILE=/tmp/demo-key BETA_KEY_FILE=/tmp/beta-key node hosted/scripts/loadtest-engine.ts

Then, from adapters/python:

    ARGENTIC_BASE_URL=http://127.0.0.1:37100 ARGENTIC_API_KEY=$(cat /tmp/beta-key) MODEL_KEY=nvapi-localtest \\
        python -m unittest tests.e2e_local -v

The scripted model answers the refund, email, close-ticket task and nothing else.
"""
import asyncio
import os
import sys
import tempfile
import unittest
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from argentic_labs import Argentic, ArgenticError, Ledger, Tool, hint_for, run_durable  # noqa: E402

BASE, KEY = os.environ.get("ARGENTIC_BASE_URL"), os.environ.get("ARGENTIC_API_KEY")
TASK = ("Order 1182 (ticket T-77, customer dana@example.com) arrived broken. Refund the $42 order, "
        "email the customer that the refund is on its way, then close the ticket. Do one step at a time.")
SCHEMA = {"type": "object", "properties": {"x": {"type": "string"}}}


class Crash(Exception):
    pass


def raise_crash():
    raise Crash()


@unittest.skipUnless(BASE and KEY and os.environ.get("MODEL_KEY"), "set ARGENTIC_BASE_URL, ARGENTIC_API_KEY and MODEL_KEY (see the docstring)")
class EngineTest(unittest.TestCase):
    def setUp(self):
        self.client = Argentic(log=lambda s: None)
        self.agent = f"e2e-{uuid.uuid4().hex[:10]}"
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ran = []

    def tools(self, asynchronous=False):
        def make(name):
            def sync(args, ctx):
                self.ran.append(name)
                return {"done": name, "key": ctx.idempotency_key}

            async def later(args, ctx):
                await asyncio.sleep(0)
                return sync(args, ctx)

            return Tool(name, name, SCHEMA, later if asynchronous else sync)

        return [make(n) for n in ("refund_order", "send_email", "close_ticket")]

    def run_it(self, **kw):
        return run_durable(self.client, agent=self.agent, run_id="r1", task=TASK, tools=self.tools(kw.pop("asynchronous", False)),
                           ledger_path=os.path.join(self.tmp.name, "state", "ledger.json"), log=lambda s: None, **kw)

    def test_kill_then_resume_runs_each_action_once_and_every_wake_checks_out(self):
        with self.assertRaises(Crash):
            self.run_it(crash_after_actions=1, crash=raise_crash)
        self.assertEqual(self.ran, ["refund_order"])
        out = self.run_it()
        self.assertEqual((out.status, out.steps), ("done", 4))
        self.assertEqual(self.ran, ["refund_order", "send_email", "close_ticket"])
        for wake in out.wakes:
            r = self.client.replay(self.agent, wake)
            self.assertEqual((r["mismatched"], r["unverifiable"]), (0, 0), r)
            self.assertGreater(r["matched"], 0)
        again = self.run_it()  # a finished run run again repeats nothing
        self.assertEqual((again.reply, len(self.ran)), (out.reply, 3))

    def test_async_tools(self):
        self.assertEqual(self.run_it(asynchronous=True).status, "done")
        self.assertEqual(len(Ledger(os.path.join(self.tmp.name, "state", "ledger.json")).entries), 3)
        self.assertEqual(self.ran, ["refund_order", "send_email", "close_ticket"])

    def test_the_same_key_gives_the_stored_answer(self):
        model = {"provider": "nvidia", "id": "x", "prices": {"in": 0, "out": 0}}
        first = self.client.wake(self.agent, TASK, model=model, idempotency_key="k.0")
        second = self.client.wake(self.agent, TASK, model=model, idempotency_key="k.0")
        self.assertEqual((first.replayed, second.replayed), (False, True))
        self.assertEqual((second.wake_id, [a["seq"] for a in second.actions]), (first.wake_id, [a["seq"] for a in first.actions]))
        with self.assertRaises(ArgenticError) as cm:
            self.client.wake(self.agent, "something else", model=model, idempotency_key="k.0")
        self.assertEqual(cm.exception.status, 422)

    def test_a_bad_key_is_a_401_with_a_hint(self):
        bad = Argentic(api_key="aek_" + "x" * 43, log=lambda s: None)
        with self.assertRaises(ArgenticError) as cm:
            bad.wake(self.agent, "hi", model={"provider": "nvidia", "id": "x", "prices": {"in": 0, "out": 0}}, idempotency_key="k")
        self.assertEqual(cm.exception.status, 401)
        self.assertIn("ARGENTIC_API_KEY", hint_for(cm.exception))

    def test_an_agent_id_the_api_refuses_is_a_clean_400(self):
        with self.assertRaises(ArgenticError) as cm:
            self.client.wake("not an agent/id", "hi", model={"provider": "nvidia", "id": "x", "prices": {"in": 0, "out": 0}}, idempotency_key="k")
        self.assertIn(cm.exception.status, (400, 404))

    def test_a_wake_sent_while_the_api_is_down_goes_through_when_it_comes_back(self):
        # The client starts at a closed port and finds the engine on its retry: same key, same body.
        sleeps = []
        c = Argentic(base_url="http://127.0.0.1:1", log=lambda s: None, backoff=(0, 0, 0))

        def sleep(s):
            sleeps.append(s)
            c.base_url = BASE.rstrip("/")  # the API is back

        c._sleep = sleep
        r = c.wake(self.agent, TASK, model={"provider": "nvidia", "id": "x", "prices": {"in": 0, "out": 0}}, idempotency_key="k.blip")
        self.assertEqual((r.status, len(sleeps)), ("done", 1))


if __name__ == "__main__":
    unittest.main()
