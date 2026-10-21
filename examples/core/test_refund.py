"""Offline test for refund.py: crash after the first action, rerun, nothing finished repeats.

Uses the in-process fake API in adapters/python/tests. Run from this folder: python -m unittest -v
"""
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "..", "adapters", "python", "tests"))

import refund  # noqa: E402
from argentic_labs import Argentic  # noqa: E402
from fake_server import refund_handler, serve  # noqa: E402

MODEL = {"provider": "nvidia", "id": "x", "prices": {"in": 0, "out": 0}}


class Crash(Exception):
    """Stands in for SIGKILL in tests."""


def raise_crash():
    raise Crash()


class RefundTest(unittest.TestCase):
    def setUp(self):
        self.server = serve(refund_handler())
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.client = Argentic(api_key="aek_test", model_key="test", base_url=self.server.url, sleep=lambda s: None, log=lambda s: None)

    def run_once(self, **kw):
        return refund.run(self.client, self.tmp.name, MODEL, log=lambda s: None, **kw)

    def test_crash_then_resume_runs_each_tool_once(self):
        with self.assertRaises(Crash):
            self.run_once(crash_after=1, crash=raise_crash)
        self.assertEqual(refund.outbox_counts(os.path.join(self.tmp.name, "outbox.jsonl")),
                         {"refund_order": 1, "send_email": 0, "close_ticket": 0})
        result, counts = self.run_once()
        self.assertEqual(counts, {"refund_order": 1, "send_email": 1, "close_ticket": 1})
        self.assertEqual((result.reply, result.status, result.wakes), ("Refunded, emailed and closed.", "done", ["wk_0", "wk_1", "wk_2", "wk_3"]))
        # step 0 was sent again with the same key, and the API answered from its stored copy
        keys = [h["idempotency-key"] for path, h, _ in self.server.requests if path.endswith("/wake")]
        self.assertEqual(sum(k.endswith(".0") for k in keys), 2)

    def test_the_outbox_dedupes_on_the_action_key(self):
        outbox = os.path.join(self.tmp.name, "outbox.jsonl")
        tools = {t.name: t for t in refund.make_tools(outbox)}
        from argentic_labs import ToolContext
        for _ in range(2):  # the same action twice, as after a crash before the ledger was written
            tools["refund_order"].execute({"order_id": "1182", "amount_usd": 42}, ToolContext(1, "a:1"))
        self.assertEqual(refund.outbox_counts(outbox)["refund_order"], 1)

    def test_rerun_after_finish_repeats_nothing(self):
        self.run_once()
        _, counts = self.run_once()
        self.assertEqual(counts, {"refund_order": 1, "send_email": 1, "close_ticket": 1})


if __name__ == "__main__":
    unittest.main()
