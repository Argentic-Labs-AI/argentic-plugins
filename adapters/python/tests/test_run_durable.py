"""run_durable and the ledger: hooks, async tools, the shared ledger file, defaults.

Run from adapters/python: python -m unittest discover -s tests -v
"""
import asyncio
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from argentic_labs import FREE_MODEL, Argentic, Ledger, Tool, model_from_env, run_durable  # noqa: E402
from fake_server import REFUND_SCRIPT, refund_handler, serve  # noqa: E402

SCHEMA = {"type": "object", "properties": {}}


class Crash(Exception):
    pass


def raise_crash():
    raise Crash()


class RunTest(unittest.TestCase):
    def setUp(self):
        self.server = serve(refund_handler())
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.client = Argentic(api_key="aek_test", base_url=self.server.url, sleep=lambda s: None, log=lambda s: None)
        self.ran = []

    def ledger_path(self, *parts):
        return os.path.join(self.tmp.name, *(parts or ("ledger.json",)))

    def saved(self):
        with open(self.ledger_path()) as f:
            return json.load(f)

    def tools(self, asynchronous=False):
        def make(name):
            def sync(args, ctx):
                self.ran.append((name, ctx.seq, ctx.idempotency_key))
                return {"ok": name}

            async def asynchronous_(args, ctx):
                await asyncio.sleep(0)
                return sync(args, ctx)

            return Tool(name, name, SCHEMA, asynchronous_ if asynchronous else sync)

        return [make(n) for n in ("refund_order", "send_email", "close_ticket")]

    def run_it(self, **kw):
        kw.setdefault("ledger_path", self.ledger_path())
        return run_durable(self.client, agent="a1", run_id="r", task="go", tools=kw.pop("tools", None) or self.tools(),
                           log=lambda s: None, **kw)

    # ---- hooks and defaults ----

    def test_hooks_fire_in_order_with_the_step_and_what_was_skipped(self):
        events = []
        kw = dict(on_wake_start=lambda step: events.append(("start", step)),
                  on_wake=lambda step, wake, status, replayed: events.append(("wake", step, wake, status, replayed)),
                  on_action=lambda seq, tool, result, fresh: events.append(("action", seq, tool, fresh)))
        with self.assertRaises(Crash):
            self.run_it(crash_after_actions=1, crash=raise_crash, **kw)
        self.assertEqual(events, [("start", 0), ("wake", 0, "wk_0", "done", False), ("action", 1, "refund_order", True)])
        events.clear()
        out = self.run_it(**kw)
        self.assertEqual(out.status, "done")
        self.assertEqual(events[:4], [("start", 0), ("wake", 0, "wk_0", "done", True), ("action", 1, "refund_order", False), ("start", 1)])
        self.assertEqual([e for e in events if e[0] == "action" and e[3]], [("action", 2, "send_email", True), ("action", 3, "close_ticket", True)])
        self.assertEqual([r[0] for r in self.ran], ["refund_order", "send_email", "close_ticket"])  # the refund once

    def test_the_free_model_is_the_default(self):
        self.run_it()
        self.assertEqual(self.server.requests[0][2]["model"], FREE_MODEL)

    def test_no_wake_means_max_steps(self):
        out = self.run_it(max_steps=0)
        self.assertEqual((out.status, out.steps, out.wakes, out.reply), ("max_steps", 0, [], ""))
        self.assertEqual(self.server.requests, [])

    def test_the_action_key_is_agent_and_seq(self):
        self.run_it()
        self.assertEqual([r[2] for r in self.ran], ["a1:1", "a1:2", "a1:3"])

    def test_an_unknown_tool_and_a_raising_tool_are_told_to_the_agent(self):
        def boom(args, ctx):
            raise RuntimeError("card declined")

        server = serve(refund_handler([("nope", {}), ("refund_order", {}), None]))
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        client = Argentic(api_key="k", base_url=server.url, sleep=lambda s: None, log=lambda s: None)
        run_durable(client, agent="a2", run_id="r", task="go", ledger_path=self.ledger_path("x.json"), log=lambda s: None,
                    tools=[Tool("refund_order", "", SCHEMA, boom)])
        results = json.loads(server.requests[-1][2]["message"].split("\n", 1)[1])
        self.assertEqual(results, [{"tool": "refund_order", "seq": 2, "result": {"error": "card declined"}}])
        self.assertEqual(json.loads(server.requests[1][2]["message"].split("\n", 1)[1])[0]["result"], {"error": "unknown tool"})

    # ---- async tools ----

    def test_an_async_tool_runs_to_its_result(self):
        out = self.run_it(tools=self.tools(asynchronous=True))
        self.assertEqual(out.status, "done")
        ledger = Ledger(self.ledger_path())
        self.assertEqual(ledger.get("a1:1")["result"], {"ok": "refund_order"})

    def test_an_async_tool_runs_even_when_called_inside_an_event_loop(self):
        async def inside():
            return self.run_it(tools=self.tools(asynchronous=True))

        self.assertEqual(asyncio.run(inside()).status, "done")
        self.assertEqual(len(self.ran), 3)

    # ---- the ledger ----

    def test_the_ledger_directory_is_made_for_you(self):
        path = self.ledger_path("state", "deeper", "ledger.json")
        self.run_it(ledger_path=path)
        self.assertTrue(os.path.exists(path))

    def test_the_ledger_file_has_the_shape_the_typescript_client_writes(self):
        self.run_it()
        saved = self.saved()
        self.assertEqual(list(saved), ["entries"])  # wakes appear only when a turn_cap wake was kept
        self.assertEqual(sorted(saved["entries"]), ["a1:1", "a1:2", "a1:3"])
        self.assertEqual(sorted(saved["entries"]["a1:1"]), ["args", "at", "result", "tool"])

    def test_a_ledger_the_typescript_client_wrote_is_resumed(self):
        with open(self.ledger_path(), "w") as f:
            json.dump({"entries": {"a1:1": {"tool": "refund_order", "args": {}, "result": {"refunded": True}, "at": "2026-10-22T00:00:00.000Z"}}}, f)
        # the first wake is asked again under the same key and answers the refund again; the ledger skips it
        self.run_it()
        self.assertEqual([r[0] for r in self.ran], ["send_email", "close_ticket"])

    def test_a_flat_ledger_from_before_0_1_4_is_still_read_and_is_rewritten_in_the_new_shape(self):
        with open(self.ledger_path(), "w") as f:
            json.dump({"a1:1": {"tool": "refund_order", "args": {}, "result": {"refunded": True}, "at": "x"},
                       "_wakes": {"r.0": {"status": "turn_cap", "reply": "", "spent_usd": 0, "turns": 1, "wake_id": "wk_9",
                                          "actions": [{"id": 1, "tool": "refund_order", "args": {}, "seq": 1}]}}}, f)
        ledger = Ledger(self.ledger_path())
        self.assertEqual(sorted(ledger.entries), ["a1:1"])
        self.assertEqual(sorted(ledger.wakes), ["r.0"])
        ledger.put("a1:2", {"tool": "send_email", "args": {}, "result": None, "at": "y"})
        saved = self.saved()
        self.assertEqual((sorted(saved["entries"]), sorted(saved["wakes"])), (["a1:1", "a1:2"], ["r.0"]))

    def test_a_kept_turn_cap_wake_is_stored_under_wakes(self):
        wakes = {"r.0": {"status": "turn_cap", "reply": "", "spent_usd": 0, "turns": 1, "wake_id": "wk_c", "resumed": None, "error": None,
                         "raw": {}, "actions": [{"id": 1, "tool": "refund_order", "args": {}, "seq": 1}]}}
        with open(self.ledger_path(), "w") as f:
            json.dump({"entries": {}, "wakes": wakes}, f)
        seen = []
        self.run_it(on_wake=lambda step, wake, status, replayed: seen.append((step, wake, status, replayed)))
        self.assertEqual(seen[0], (0, "wk_c", "turn_cap", True))  # not sent to the API again
        self.assertNotIn("r.0", [r[1]["idempotency-key"] for r in self.server.requests][:1])


class CorruptLedgerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "ledger.json")

    def test_a_missing_file_starts_empty_without_a_warning(self):
        warnings = []
        self.assertIsNone(Ledger(self.path, warnings.append).get("a:1"))
        self.assertEqual(warnings, [])

    def test_a_corrupt_file_warns_starts_empty_and_is_kept_aside(self):
        with open(self.path, "w") as f:
            f.write('{"entries": {"a:1": ')
        warnings = []
        ledger = Ledger(self.path, warnings.append)
        self.assertIsNone(ledger.get("a:1"))
        self.assertEqual(len(warnings), 1)
        for word in ("not valid", "finished actions may run again", "ledger.json.corrupt"):
            self.assertIn(word, warnings[0])
        with open(self.path + ".corrupt") as f:
            self.assertEqual(f.read(), '{"entries": {"a:1": ')
        self.assertFalse(os.path.exists(self.path))
        ledger.put("a:2", {"tool": "t", "args": {}, "result": 1, "at": "now"})  # and it works again
        self.assertEqual(Ledger(self.path).get("a:2")["result"], 1)

    def test_json_that_is_not_an_object_is_corrupt_too_and_a_good_file_is_silent(self):
        warnings = []
        with open(self.path, "w") as f:
            f.write("[1, 2]")
        Ledger(self.path, warnings.append)
        self.assertEqual(len(warnings), 1)
        with open(self.path, "w") as f:
            json.dump({"entries": {"a:1": {"tool": "t", "args": {}, "result": 5, "at": "x"}}}, f)
        self.assertEqual(Ledger(self.path, warnings.append).get("a:1")["result"], 5)
        self.assertEqual(len(warnings), 1)

    def test_the_default_warning_goes_to_stderr(self):
        import contextlib
        import io
        with open(self.path, "w") as f:
            f.write("nope")
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            Ledger(self.path)
        self.assertIn("argentic: the ledger", err.getvalue())


class ModelFromEnvTest(unittest.TestCase):
    def test_unset_is_the_free_model_whatever_else_is_set(self):
        self.assertEqual(model_from_env({}), FREE_MODEL)
        self.assertEqual(model_from_env({"ARGENTIC_MODEL_PROVIDER": "openai", "ARGENTIC_PRICE_IN": "9"}), FREE_MODEL)

    def test_a_chosen_model_takes_its_provider_and_prices(self):
        env = {"ARGENTIC_MODEL_ID": "gpt-x", "ARGENTIC_MODEL_PROVIDER": "openai", "ARGENTIC_PRICE_IN": "0.25", "ARGENTIC_PRICE_OUT": "2"}
        self.assertEqual(model_from_env(env), {"provider": "openai", "id": "gpt-x", "prices": {"in": 0.25, "out": 2.0}})
        self.assertEqual(model_from_env({"ARGENTIC_MODEL_ID": "m"}), {"provider": "nvidia", "id": "m", "prices": {"in": 0.0, "out": 0.0}})

    def test_the_free_model_is_a_copy(self):
        m = model_from_env({})
        m["prices"]["in"] = 5
        self.assertEqual(FREE_MODEL["prices"]["in"], 0)


if __name__ == "__main__":
    unittest.main()
