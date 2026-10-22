"""Offline test: a wake that stops at its turn limit after asking for an action gets
that action's result in the next wake, and a crash in between neither repeats the
action nor asks the stopped wake again.

Run from adapters/python: python -m unittest discover -s tests -v
"""
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from argentic_labs.core import Argentic, Tool, run_durable  # noqa: E402

MODEL = {"provider": "nvidia", "id": "x", "prices": {"in": 0, "out": 0}}


class FakeArgentic:
    """The API's turn limit. The first wake stops (turn_cap, still open) right after
    the agent asks to read a source. Asking that key again continues the same wake
    without the result, so the agent notes the source does not exist. A new wake
    whose message carries the result lets the agent finish with it."""

    def __init__(self):
        self.answers = {}
        self.log = []  # (key, message)
        self.seq = 0
        self.lock = threading.Lock()

    def wake(self, key, body):
        with self.lock:
            self.log.append((key, body["message"]))
            prior = self.answers.get(key)
            if prior and prior["status"] == "done":
                return prior, True
            if prior:  # the same key on an open wake carries on blind
                self.seq += 1
                resp = {"status": "done", "reply": "No such source.", "spent_usd": 0, "turns": 2, "wake_id": "wk_0",
                        "resumed": True, "actions": [prior["actions"][0],
                                                     {"id": 2, "tool": "save_note", "args": {"text": "no such source"}, "seq": self.seq}]}
            elif "SRC-7" in body["message"]:
                resp = {"status": "done", "reply": "Summary: SRC-7", "spent_usd": 0, "turns": 1,
                        "wake_id": f"wk_{len(self.answers)}", "actions": []}
            else:
                self.seq += 1
                resp = {"status": "turn_cap", "reply": None, "spent_usd": 0, "turns": 1, "wake_id": f"wk_{len(self.answers)}",
                        "actions": [{"id": 1, "tool": "read_source", "args": {"id": "a"}, "seq": self.seq}]}
            self.answers[key] = resp
            return resp, False


def serve(fake):
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            resp, replayed = fake.wake(self.headers["Idempotency-Key"], body)
            raw = json.dumps(resp).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            if replayed:
                self.send_header("Idempotent-Replay", "true")
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, *a):
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


class Crash(Exception):
    pass


class TurnCapTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeArgentic()
        self.httpd = serve(self.fake)
        self.dir = tempfile.mkdtemp()
        self.ran = []
        self.client = Argentic(api_key="test-key", model_key="m", base_url=f"http://127.0.0.1:{self.httpd.server_port}",
                               sleep=lambda s: None, log=lambda s: None)

    def tearDown(self):
        self.httpd.shutdown()
        shutil.rmtree(self.dir, ignore_errors=True)

    def run_it(self, crash=False):
        def read(args, ctx):
            self.ran.append("read_source")
            return "SRC-7"

        def note(args, ctx):
            self.ran.append("save_note")
            return "ok"

        def crash_now():
            raise Crash()

        tools = [Tool("read_source", "Read a source", {"type": "object", "properties": {"id": {"type": "string"}}}, read),
                 Tool("save_note", "Save a note", {"type": "object", "properties": {"text": {"type": "string"}}}, note)]
        return run_durable(self.client, agent="turncap-test", run_id="r", task="Read source a and sum it up.", tools=tools,
                           ledger_path=os.path.join(self.dir, "ledger.json"), model=MODEL, log=lambda s: None,
                           crash_after_actions=1 if crash else None, crash=crash_now)

    def keys(self):
        return [k for k, _ in self.fake.log]

    def test_results_go_in_the_next_wake(self):
        out = self.run_it()
        self.assertEqual(out.status, "done")
        self.assertEqual(out.reply, "Summary: SRC-7")
        self.assertEqual(self.ran, ["read_source"])
        self.assertEqual(self.keys(), ["r.0", "r.1"])
        self.assertEqual(self.fake.log[1][1], 'Results of the tools you asked for:\n[{"tool": "read_source", "seq": 1, "result": "SRC-7"}]')

    def test_crash_resumes_by_sending_the_result(self):
        with self.assertRaises(Crash):
            self.run_it(crash=True)
        out = self.run_it()
        self.assertEqual(out.reply, "Summary: SRC-7")
        self.assertEqual(self.ran, ["read_source"])
        self.assertEqual(self.keys(), ["r.0", "r.1"])
        # a rerun of the finished run asks nothing new and repeats nothing
        again = self.run_it()
        self.assertEqual(again.reply, "Summary: SRC-7")
        self.assertEqual(self.ran, ["read_source"])
        self.assertEqual(self.keys(), ["r.0", "r.1", "r.1"])


if __name__ == "__main__":
    unittest.main()
