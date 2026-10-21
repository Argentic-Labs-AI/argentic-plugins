"""The Python client and the TypeScript client must say and default to the same things.

Reads adapters/typescript/argentic.ts and package.json when this runs inside the repo; skipped otherwise.

Run from adapters/python: python -m unittest discover -s tests -v
"""
import inspect
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
sys.path.insert(0, PKG)

import argentic_labs  # noqa: E402
from argentic_labs import core  # noqa: E402

TS_DIR = os.path.join(PKG, "..", "typescript")
TS = os.path.join(TS_DIR, "argentic.ts")


def ts_source():
    with open(TS) as f:
        return f.read()


def py_version():
    with open(os.path.join(PKG, "pyproject.toml")) as f:
        return re.search(r'^version = "([^"]+)"', f.read(), re.M).group(1)


class VersionTest(unittest.TestCase):
    def test_dunder_version_is_the_pyproject_version(self):
        self.assertEqual(argentic_labs.__version__, py_version())


@unittest.skipUnless(os.path.exists(TS), "TypeScript client not alongside")
class ParityTest(unittest.TestCase):
    def setUp(self):
        self.ts = ts_source()

    def test_the_default_url(self):
        self.assertIn(f"defaultBaseUrl = '{core.DEFAULT_BASE_URL}'", self.ts)

    def test_the_free_model(self):
        self.assertIn(f"provider: '{core.FREE_MODEL['provider']}'", self.ts)
        self.assertIn(f"id: '{core.FREE_MODEL['id']}'", self.ts)

    def test_every_hint_the_typescript_client_gives_the_python_client_gives_word_for_word(self):
        hints = re.findall(r"return '((?:[^'\\]|\\.)*)'", self.ts[self.ts.index("export function hintFor"):self.ts.index("export interface ClientOptions")])
        self.assertEqual(len(hints), 6)
        py = open(core.__file__).read()
        for hint in hints:
            self.assertIn(hint.replace("\\'", "'"), py)

    def test_the_retry_numbers(self):
        self.assertEqual(core.BACKOFF, (1, 2, 4, 8))
        self.assertIn("[1000, 2000, 4000, 8000]", self.ts)
        self.assertEqual(core.MAX_QUEUED_WAITS, 60)
        self.assertIn("maxQueuedWaits ?? 60", self.ts)
        self.assertIn("Math.min(Math.max(info.retry_after ?? 1, 0), 5)", self.ts)

    def test_the_same_environment_variables(self):
        for name in ("ARGENTIC_API_KEY", "ARGENTIC_BASE_URL"):
            self.assertIn(name, self.ts)
            self.assertIn(name, open(core.__file__).read())

    def test_the_same_run_options(self):
        # camelCase option in TypeScript, snake_case here
        for ts_name, py_name in [("runId", "run_id"), ("ledgerPath", "ledger_path"), ("maxSteps", "max_steps"), ("limits", "limits"),
                                 ("onWakeStart", "on_wake_start"), ("onWake", "on_wake"), ("crashAfterActions", "crash_after_actions")]:
            self.assertIn(ts_name, self.ts)
            self.assertIn(py_name, inspect.signature(core.run_durable).parameters)

    def test_the_same_statuses_and_the_same_message_to_carry_on(self):
        for status in ("done", "spend_cap", "budget_cap", "turn_cap", "time_cap", "error", "approval_required"):
            self.assertIn(f"'{status}'", self.ts)
        self.assertIn("'Results of the tools you asked for:\\n'", self.ts)
        self.assertIn("Results of the tools you asked for:", open(core.__file__).read())


if __name__ == "__main__":
    unittest.main()
