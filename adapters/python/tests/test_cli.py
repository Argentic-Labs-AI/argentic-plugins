"""`python -m argentic_labs demo`, as a real process: killed after the first action, then run again.

Run from adapters/python: python -m unittest discover -s tests -v
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
sys.path.insert(0, PKG)
sys.path.insert(0, HERE)

from fake_server import refund_handler, serve  # noqa: E402


class DemoTest(unittest.TestCase):
    def setUp(self):
        self.server = serve(refund_handler())
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = {**os.environ, "PYTHONPATH": PKG, "ARGENTIC_API_KEY": "aek_test", "MODEL_KEY": "mk_test",
                    "ARGENTIC_BASE_URL": self.server.url, "ARGENTIC_DEMO_WORK_MS": "0", "NO_COLOR": "1"}
        self.env.pop("ARGENTIC_MODEL_ID", None)

    def demo(self, *args, env=None):
        return subprocess.run([sys.executable, "-m", "argentic_labs", "demo", *args], cwd=self.tmp.name, env=env or self.env,
                              capture_output=True, text=True, timeout=60)

    def outbox(self):
        with open(os.path.join(self.tmp.name, ".argentic-demo", "outbox.jsonl")) as f:
            return [json.loads(line)["tool"] for line in f if line.strip()]

    def test_kill_then_run_again_finishes_without_repeating_the_refund(self):
        first = self.demo("--kill-after", "1")
        self.assertEqual(first.returncode, -9, first.stdout + first.stderr)  # SIGKILL, mid-run
        self.assertIn("Killing the process now", first.stdout)
        self.assertEqual(self.outbox(), ["refund_order"])

        second = self.demo()
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assertIn("Picking up run-", second.stdout)
        self.assertIn("1 action finished before it stopped", second.stdout)
        self.assertRegex(second.stdout, r"#1 refund_order\s+finished on an earlier run, skipped")
        self.assertIn("answer already in the journal", second.stdout)
        self.assertIn("Reply: Refunded, emailed and closed.", second.stdout)
        for tool in ("refund_order", "send_email", "close_ticket"):
            self.assertRegex(second.stdout, rf"{tool}\s+1 time\n")
        self.assertEqual(sorted(self.outbox()), ["close_ticket", "refund_order", "send_email"])
        self.assertEqual(second.stdout.count("all match"), 4)
        self.assertIn("/platform/ -> Runs -> kill-demo-", second.stdout)

        # a finished run run again repeats nothing
        third = self.demo()
        self.assertEqual(third.returncode, 0, third.stdout + third.stderr)
        self.assertEqual(sorted(self.outbox()), ["close_ticket", "refund_order", "send_email"])

    def test_the_state_folder_is_the_one_the_npm_demo_uses(self):
        self.demo("--kill-after", "1")
        names = sorted(os.listdir(os.path.join(self.tmp.name, ".argentic-demo")))
        self.assertEqual(names, ["ledger.json", "outbox.jsonl", "run.json"])
        with open(os.path.join(self.tmp.name, ".argentic-demo", "ledger.json")) as f:
            self.assertEqual(list(json.load(f)), ["entries"])
        with open(os.path.join(self.tmp.name, ".argentic-demo", "run.json")) as f:
            self.assertEqual(sorted(json.load(f)), ["agent", "runId"])

    def test_fresh_starts_a_new_run(self):
        self.demo("--kill-after", "1")
        with open(os.path.join(self.tmp.name, ".argentic-demo", "run.json")) as f:
            before = json.load(f)["agent"]
        self.demo("--fresh", "--kill-after", "1")
        with open(os.path.join(self.tmp.name, ".argentic-demo", "run.json")) as f:
            self.assertNotEqual(json.load(f)["agent"], before)
        self.assertEqual(self.outbox(), ["refund_order"])

    def test_it_asks_for_the_keys_first(self):
        env = {k: v for k, v in self.env.items() if k not in ("ARGENTIC_API_KEY", "MODEL_KEY")}
        r = self.demo(env=env)
        self.assertEqual(r.returncode, 1)
        self.assertIn("Set ARGENTIC_API_KEY and MODEL_KEY first.", r.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, ".argentic-demo")))

    def test_usage_and_unknown_commands(self):
        ok = subprocess.run([sys.executable, "-m", "argentic_labs", "--help"], env=self.env, capture_output=True, text=True)
        self.assertEqual(ok.returncode, 0)
        self.assertIn("Usage: argentic-labs demo", ok.stdout)
        bad = subprocess.run([sys.executable, "-m", "argentic_labs", "nope"], env=self.env, capture_output=True, text=True)
        self.assertEqual(bad.returncode, 1)

    def test_a_401_prints_the_hint_not_a_traceback(self):
        server = serve(lambda *a: (401, {"error": "unauthorized"}, None))
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        r = self.demo(env={**self.env, "ARGENTIC_BASE_URL": server.url})
        self.assertEqual(r.returncode, 1)
        self.assertIn("Check ARGENTIC_API_KEY", r.stderr)
        self.assertNotIn("Traceback", r.stderr)


if __name__ == "__main__":
    unittest.main()
