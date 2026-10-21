"""Offline test: crash after the first action, rerun, nothing finished repeats.

Uses an in-process fake Argentic server. Run: python -m unittest -v
"""
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import refund  # noqa: E402
from argentic import Argentic, ArgenticError  # noqa: E402

SCRIPT = [
    ("refund_order", {"order_id": "1182", "amount_usd": 42}),
    ("send_email", {"to": "dana@example.com", "subject": "Your refund", "body": "Your refund is on its way."}),
    ("close_ticket", {"ticket_id": "T-77", "note": "refunded and customer emailed"}),
    None,  # final reply
]


class FakeArgentic:
    """Stored answers per idempotency key, seq per agent, a scripted model,
    one 409 and one 503."""

    def __init__(self):
        self.answers = {}      # key -> (body json, response)
        self.seq = {}          # agent -> last seq
        self.keys_seen = []    # every Idempotency-Key received
        self.messages = []     # message of each new (not replayed) wake
        self.did_409 = False
        self.did_503 = False
        self.lock = threading.Lock()

    def wake(self, agent, key, body):
        """Returns (status, payload, replay_header)."""
        with self.lock:
            self.keys_seen.append(key)
            if not self.did_409:
                self.did_409 = True
                return 409, {"status": "queued", "retry_after": 0}, False
            if key in self.answers:
                old_body, resp = self.answers[key]
                if old_body != body:
                    return 422, {"error": "idempotency_key_reused"}, False
                return 200, resp, True
            if not self.did_503:
                self.did_503 = True
                return 503, {"error": "unavailable"}, False
            n = len(self.answers)
            self.messages.append(body["message"])
            step = SCRIPT[n]
            resp = {"status": "done", "spent_usd": 0, "turns": 1, "wake_id": f"wk_{n}", "reply": ""}
            if step is None:
                resp["reply"] = "Refunded, emailed and closed."
            else:
                self.seq[agent] = self.seq.get(agent, 0) + 1
                resp["actions"] = [{"id": f"a{self.seq[agent]}", "tool": step[0], "args": step[1], "seq": self.seq[agent]}]
            self.answers[key] = (body, resp)
            return 200, resp, False


def serve(fake):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
            parts = self.path.strip("/").split("/")  # v1 agents <agent> <verb>
            agent, verb = parts[2], parts[3]
            replay = False
            if verb == "wake":
                status, payload, replay = fake.wake(agent, self.headers["Idempotency-Key"], body)
            else:
                status, payload = 200, {"turns": [{"turn_seq": 1, "match": True}, {"turn_seq": 2, "match": True}]}
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            if replay:
                self.send_header("Idempotent-Replay", "true")
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class Crash(Exception):
    """Stands in for SIGKILL in tests."""


def raise_crash():
    raise Crash()


class RefundTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeArgentic()
        self.server = serve(self.fake)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.client = Argentic(
            api_key="aek_test", model_key="test",
            base_url=f"http://127.0.0.1:{self.server.server_address[1]}",
            sleep=lambda s: None, log=lambda s: None,
        )
        self.model = {"provider": "nvidia", "id": "x", "prices": {"in": 0, "out": 0}}

    def run_once(self, **kw):
        return refund.run(self.client, self.tmp.name, self.model, log=lambda s: None, **kw)

    def test_crash_then_resume_runs_each_tool_once(self):
        with self.assertRaises(Crash):
            self.run_once(crash_after=1, crash=raise_crash)
        self.assertEqual(refund.outbox_counts(os.path.join(self.tmp.name, "outbox.jsonl")),
                         {"refund_order": 1, "send_email": 0, "close_ticket": 0})

        result, counts = self.run_once()
        self.assertEqual(counts, {"refund_order": 1, "send_email": 1, "close_ticket": 1})
        self.assertEqual(result.reply, "Refunded, emailed and closed.")
        self.assertEqual(result.status, "done")
        self.assertEqual(result.wakes, ["wk_0", "wk_1", "wk_2", "wk_3"])

        # step 0 was sent again with the same key, and Argentic answered from its stored copy
        key0 = [k for k in self.fake.keys_seen if k.endswith(".0")]
        self.assertGreaterEqual(len(key0), 2)
        self.assertEqual(len(set(key0)), 1)
        # the later message is built from the ledger
        self.assertIn("refunded $42", self.fake.messages[1])

    def test_rerun_after_finish_repeats_nothing(self):
        self.run_once()
        _, counts = self.run_once()
        self.assertEqual(counts, {"refund_order": 1, "send_email": 1, "close_ticket": 1})

    def test_key_reuse_with_different_body_raises(self):
        agent = "a1"
        self.client.wake(agent, "one", model=self.model, idempotency_key="k.0")
        with self.assertRaises(ArgenticError):
            self.client.wake(agent, "two", model=self.model, idempotency_key="k.0")


if __name__ == "__main__":
    unittest.main()
