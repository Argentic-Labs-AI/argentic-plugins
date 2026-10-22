"""handle_due / verify_due: the signed due notice, checked and then woken on. No network beyond an in-process server.

Run from adapters/python: python -m unittest discover -s tests -v
"""
import base64
import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from argentic_labs import Argentic, WebhookVerificationError, handle_due, sign_notice, verify_due  # noqa: E402
from fake_server import serve  # noqa: E402

# One fixed vector, asserted in TypeScript too (test/due.test.ts) and checked against the hosted engine's signer.
SECRET = "whsec_YXJnZW50aWMtdGVzdC12ZWN0b3Itc2VjcmV0LTMyYnk="
ID = "due_t1_support-bot_inbox_1792659600"
TS = 1792659660
BODY = '{"type":"agent.due","agent":"support-bot","memory":"inbox","reasons":["plan wake_at"],"since":"2026-10-22T09:00:00.000Z"}'
SIG = "v1,iM71zq14eEYiwx4iyGblF5PjAh2S7FVivBkCxqGCavY="
MODEL = {"provider": "p", "id": "m", "prices": {"in": 0, "out": 0}}
OK = {"status": "done", "reply": "ok", "spent_usd": 0, "turns": 1, "wake_id": "wk_1"}


def headers(**over):
    h = {"Webhook-Id": ID, "Webhook-Timestamp": str(TS), "Webhook-Signature": SIG, **over}
    return {k: v for k, v in h.items() if v is not None}


def now():
    return float(TS)


class DueTest(unittest.TestCase):
    def setUp(self):
        self.server = serve(lambda path, hdrs, body: (200, OK, None))
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.client = Argentic(api_key="aek_test", model_key="mk_customer", base_url=self.server.url, log=lambda s: None)

    def handle(self, body=BODY, hdrs=None, **kw):
        kw = {"client": self.client, "model": MODEL, "secret": SECRET, "now": now, **kw}
        return handle_due(body, headers() if hdrs is None else hdrs, **kw)

    def refuses(self, code, body=BODY, hdrs=None, **kw):
        with self.assertRaises(WebhookVerificationError) as cm:
            self.handle(body, hdrs, **kw)
        self.assertEqual(cm.exception.code, code)
        self.assertEqual(self.server.requests, [], "no wake on a failure")

    def test_the_shared_vector(self):
        self.assertEqual(sign_notice(SECRET, ID, TS, BODY), SIG)
        self.assertEqual(sign_notice(SECRET, ID, TS, BODY.encode()), SIG)

    def test_a_valid_notice_wakes_with_fire_due_the_model_key_the_path_and_the_memory(self):
        notice, wake = self.handle()
        self.assertEqual((notice.agent, notice.memory, notice.reasons), ("support-bot", "inbox", ["plan wake_at"]))
        self.assertEqual(wake.wake_id, "wk_1")
        (path, hdrs, body), = self.server.requests
        self.assertEqual(path, "/v1/agents/support-bot/wake")
        self.assertEqual(hdrs["x-model-key"], "mk_customer")
        self.assertEqual(hdrs["authorization"], "Bearer aek_test")
        self.assertEqual(hdrs["idempotency-key"], ID)
        self.assertEqual(body, {"fire_due": True, "memory": "inbox", "model": MODEL})

    def test_a_null_memory_is_left_out(self):
        body = BODY.replace('"memory":"inbox"', '"memory":null')
        self.handle(body, headers(**{"Webhook-Signature": sign_notice(SECRET, ID, TS, body)}))
        self.assertNotIn("memory", self.server.requests[0][2])

    def test_bytes_and_lower_case_headers(self):
        lower = {k.lower(): v for k, v in headers().items()}
        self.handle(BODY.encode(), lower)
        self.assertEqual(len(self.server.requests), 1)

    def test_several_signatures_one_valid_and_non_v1_ignored(self):
        junk = "v1," + base64.b64encode(b"nope").decode()
        self.handle(hdrs=headers(**{"Webhook-Signature": f"{junk} v2,{SIG[3:]} not-a-sig {SIG}"}))
        self.assertEqual(len(self.server.requests), 1)

    def test_verification_failures_raise_and_never_wake(self):
        self.refuses("bad_signature", secret="whsec_" + base64.b64encode(b"another-secret-another-secret-12").decode())
        self.refuses("bad_signature", body=BODY.replace("support-bot", "other-bot"))
        self.refuses("bad_signature", hdrs=headers(**{"Webhook-Signature": "v2," + SIG[3:]}))
        self.refuses("stale", now=lambda: float(TS + 301))
        self.refuses("stale", now=lambda: float(TS - 301))
        self.refuses("bad_timestamp", hdrs=headers(**{"Webhook-Timestamp": "soon"}))
        for h in ("Webhook-Id", "Webhook-Timestamp", "Webhook-Signature"):
            self.refuses("missing_header", hdrs=headers(**{h: None}))
        self.refuses("bad_secret", secret="whsec_not base64!")
        self.refuses("bad_secret", secret="whsec_")

    def test_the_window_is_adjustable_and_the_edge_is_allowed(self):
        verify_due(BODY, headers(), secret=SECRET, now=lambda: float(TS + 300))
        with self.assertRaises(WebhookVerificationError):
            verify_due(BODY, headers(), secret=SECRET, now=lambda: float(TS + 301))
        verify_due(BODY, headers(), secret=SECRET, now=lambda: float(TS + 3000), tolerance_seconds=3600)

    def test_the_secret_falls_back_to_the_environment(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(WebhookVerificationError) as cm:
                verify_due(BODY, headers(), now=now)
            self.assertEqual(cm.exception.code, "bad_secret")
        with mock.patch.dict(os.environ, {"ARGENTIC_WEBHOOK_SECRET": SECRET}, clear=True):
            self.assertEqual(verify_due(BODY, headers(), now=now)[1], ID)

    def test_a_signed_notice_of_another_type_or_without_an_agent_is_refused(self):
        for body in ('{"type":"agent.other","agent":"a"}', '{"type":"agent.due"}', '{"type":"agent.due","agent":""}', "not json", "[]"):
            self.refuses("bad_body", body, headers(**{"Webhook-Signature": sign_notice(SECRET, ID, TS, body)}))


if __name__ == "__main__":
    unittest.main()
