"""Tool pack tests against in-process mock providers that commit an effect and then drop the connection.
Run from adapters/python: python -m unittest discover -s tests -v"""
import base64
import json
import os
import socket
import socketserver
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from argentic_labs import RetryLater, Tool, ToolContext, run_durable  # noqa: E402
from argentic_labs.core import Argentic  # noqa: E402
from argentic_labs.tools import provider_key, tool_pack  # noqa: E402


class Mock:
    """An HTTP mock. handler(mock, method, path, headers, body) -> (code, json, headers) or None to drop the connection."""

    def __init__(self, handler):
        self.effects: list = []
        self.requests: list = []
        self.drop_next = 0
        self.store: dict = {}
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _go(self):
                n = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(n).decode() if n else ""
                outer.requests.append({"method": self.command, "path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "body": body})
                out = handler(outer, self.command, self.path, {k.lower(): v for k, v in self.headers.items()}, body)
                if out is None:
                    self.connection.shutdown(socket.SHUT_RDWR)
                    return
                code, data, hdrs = out
                raw = json.dumps(data).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                for k, v in hdrs.items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(raw)

            do_GET = do_POST = _go

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def maybe_drop(self):
        if self.drop_next > 0:
            self.drop_next -= 1
            return True
        return False

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def idempotent(mock, key, body, make, replay_header, mismatch):
    prior = mock.store.get(key) if key else None
    if prior:
        if prior["body"] != body:
            return mismatch
        return prior["code"], prior["json"], {replay_header: "true"}
    code, data = make()
    if key:
        mock.store[key] = {"body": body, "code": code, "json": data}
    if mock.maybe_drop():
        return None
    return code, data, {}


def stripe_handler(mock, method, path, h, body):
    p = {k: v[0] for k, v in parse_qs(body).items()}
    def make():
        if p.get("payment_method") == "pm_declined":
            return 402, {"error": {"code": "card_declined", "message": "Your card was declined."}}
        mock.effects.append(p)
        return 200, {"id": f"x_{len(mock.effects)}", "status": "succeeded", "amount": int(p.get("amount", 0)), "currency": p.get("currency", "usd")}
    return idempotent(mock, h.get("idempotency-key"), body, make, "Idempotent-Replayed", (400, {"error": {"message": "same key, other params"}}, {}))


def resend_handler(mock, method, path, h, body):
    def make():
        mock.effects.append(json.loads(body))
        return 200, {"id": f"em_{len(mock.effects)}"}
    return idempotent(mock, h.get("idempotency-key"), body, make, "Idempotent-Replayed", (409, {"name": "invalid_idempotent_request"}, {}))


def http_handler(mock, method, path, h, body):
    key = h.get("idempotency-key")
    if mock.honors and key in mock.store:
        return 200, mock.store[key], {"Idempotent-Replayed": "true"}
    mock.effects.append({"body": body, "key": key})
    out = {"received": True}
    mock.store[key] = out
    if mock.maybe_drop():
        return None
    return 200, out, {}


def slack_handler(mock, method, path, h, body):
    b = json.loads(body or "{}")
    if path == "/chat.postMessage":
        m = {"ts": f"1.{len(mock.effects) + 1}", "text": b["text"], "channel": b["channel"], "metadata": b.get("metadata")}
        mock.effects.append(m)
        if mock.maybe_drop():
            return None
        return 200, {"ok": True, "ts": m["ts"], "channel": b["channel"]}, {}
    if not mock.history:
        return 200, {"ok": False, "error": "missing_scope"}, {}
    return 200, {"ok": True, "messages": [m for m in reversed(mock.effects) if m["channel"] == b["channel"]]}, {}


def github_handler(mock, method, path, h, body):
    u = urlparse(path)
    if method == "POST":
        b = json.loads(body)
        issue = u.path.endswith("/issues")
        e = {"kind": "issue" if issue else "comment", "number": len(mock.effects) + 1, "id": len(mock.effects) + 100, "body": b["body"], "html_url": "https://github.example/x"}
        mock.effects.append(e)
        if mock.maybe_drop():
            return None
        return 201, e, {}
    if mock.list_broken:
        return 500, {"message": "down"}, {}
    want = "issue" if u.path.endswith("/issues") else "comment"
    return 200, [e for e in reversed(mock.effects) if e["kind"] == want], {}


def mk(handler, **attrs):
    m = Mock(handler)
    for k, v in attrs.items():
        setattr(m, k, v)
    return m


class SmtpMock:
    def __init__(self):
        self.messages: list[str] = []
        self.drop_after_data = 0
        outer = self

        class H(socketserver.StreamRequestHandler):
            def handle(self):
                w = lambda s: self.wfile.write(s.encode()) or self.wfile.flush()
                w("220 mock\r\n")
                while True:
                    line = self.rfile.readline().decode().strip()
                    if not line:
                        return
                    up = line.upper()
                    if up.startswith("EHLO"):
                        w("250-mock\r\n250 AUTH PLAIN\r\n")
                    elif up.startswith("AUTH PLAIN"):
                        w("235 ok\r\n" if b"\0user\0pass" in base64.b64decode(line.split()[2]) else "535 no\r\n")
                    elif up.startswith("MAIL FROM"):
                        w("250 ok\r\n")
                    elif up.startswith("RCPT TO:<BAD@"):
                        w("550 no such user\r\n")
                    elif up.startswith("RCPT TO"):
                        w("250 ok\r\n")
                    elif up.startswith("DATA"):
                        w("354 go\r\n")
                        data = []
                        while True:
                            l = self.rfile.readline().decode()
                            if l in (".\r\n", ""):
                                break
                            data.append(l)
                        outer.messages.append("".join(data))
                        if outer.drop_after_data > 0:
                            outer.drop_after_data -= 1
                            return
                        w("250 queued\r\n")
                    elif up.startswith("QUIT"):
                        w("221 bye\r\n")
                        return
                    else:
                        w("500 what\r\n")

        class S(socketserver.ThreadingTCPServer):
            allow_reuse_address = True
            daemon_threads = True

        self.server = S(("127.0.0.1", 0), H)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.n = 0
        self.closers = []

    def tearDown(self):
        for c in self.closers:
            c()

    def state(self):
        self.n += 1
        return os.path.join(self.dir, f"intents-{self.n}.json")

    def mock(self, handler, **attrs):
        m = mk(handler, **attrs)
        self.closers.append(m.close)
        return m

    def pack(self, state, tries=1, **opts):
        return {t.name: t for t in tool_pack(state_path=state, tries=tries, sleep=lambda s: None, **opts)}

    def run_tool(self, tools, name, args, key):
        return tools[name].execute(args, ToolContext(1, key))


class StripeTests(Base):
    def test_lost_answer_then_restart_refunds_once(self):
        m = self.mock(stripe_handler)
        o = {"stripe": {"secret_key": "sk", "base_url": m.url}}
        st = self.state()
        m.drop_next = 1
        with self.assertRaises(RetryLater):
            self.run_tool(self.pack(st, **o), "stripe_refund", {"payment_intent": "pi_1", "amount": 4200}, "agent:1")
        self.assertEqual(len(m.effects), 1)
        out = self.run_tool(self.pack(st, **o), "stripe_refund", {"payment_intent": "pi_1", "amount": 4200}, "agent:1")
        self.assertTrue(out["ok"] and out["replayed"])
        self.assertEqual(len(m.effects), 1)

    def test_provider_covers_a_lost_state_file(self):
        m = self.mock(stripe_handler)
        o = {"stripe": {"secret_key": "sk", "base_url": m.url}}
        a = {"customer": "cus_1", "payment_method": "pm_1", "amount": 1999, "currency": "USD"}
        self.run_tool(self.pack(self.state(), **o), "stripe_charge", a, "agent:2")
        self.run_tool(self.pack(self.state(), **o), "stripe_charge", a, "agent:2")
        self.assertEqual(len(m.effects), 1)
        self.assertEqual(m.effects[0]["off_session"], "true")
        self.assertEqual(m.requests[0]["headers"]["idempotency-key"], "agent:2")

    def test_decline_is_a_result_and_cap_holds(self):
        m = self.mock(stripe_handler)
        t = self.pack(self.state(), stripe={"secret_key": "sk", "base_url": m.url, "max_amount": 5000})
        d = self.run_tool(t, "stripe_charge", {"customer": "c", "payment_method": "pm_declined", "amount": 100, "currency": "usd"}, "agent:3")
        self.assertFalse(d["ok"])
        self.assertEqual(d["code"], "card_declined")
        self.assertIn("over the limit", self.run_tool(t, "stripe_refund", {"payment_intent": "pi", "amount": 5001}, "agent:4")["error"])
        self.assertIn("needs an amount", self.run_tool(t, "stripe_refund", {"payment_intent": "pi"}, "agent:5")["error"])
        self.assertEqual(len(m.requests), 1)

    def test_long_key_is_hashed(self):
        self.assertLessEqual(len(provider_key("a" * 400)), 255)
        self.assertEqual(provider_key("agent:1"), "agent:1")


class ResendAndHttpTests(Base):
    def test_resend_lost_answer_sends_one_email(self):
        m = self.mock(resend_handler)
        o = {"resend": {"api_key": "k", "from": "A <a@b.co>", "base_url": m.url}}
        st = self.state()
        m.drop_next = 1
        a = {"to": "d@e.co", "subject": "s", "body": "b"}
        with self.assertRaises(RetryLater):
            self.run_tool(self.pack(st, **o), "send_email", a, "agent:7")
        self.assertTrue(self.run_tool(self.pack(st, **o), "send_email", a, "agent:7")["ok"])
        self.assertEqual(len(m.effects), 1)

    def test_in_process_retries_reuse_the_key(self):
        m = self.mock(resend_handler)
        m.drop_next = 1
        t = self.pack(self.state(), tries=4, resend={"api_key": "k", "from": "a@b.co", "base_url": m.url})
        self.assertTrue(self.run_tool(t, "send_email", {"to": "x@y.co", "subject": "s", "body": "b"}, "agent:8")["ok"])
        self.assertEqual(len(m.effects), 1)
        self.assertEqual(len({r["headers"]["idempotency-key"] for r in m.requests}), 1)

    def test_http_post_key_allow_list_and_dedupe(self):
        m = self.mock(http_handler, honors=True)
        host = m.url.split("//")[1]
        o = {"http": {"allow_hosts": [host], "allow_http": True, "headers": {"Authorization": "Bearer hook"}}}
        st = self.state()
        m.drop_next = 1
        with self.assertRaises(RetryLater):
            self.run_tool(self.pack(st, **o), "http_post", {"url": m.url + "/deploy", "body": "{}"}, "agent:9")
        out = self.run_tool(self.pack(st, **o), "http_post", {"url": m.url + "/deploy", "body": "{}"}, "agent:9")
        self.assertTrue(out["ok"] and out["replayed"])
        self.assertEqual(len(m.effects), 1)
        self.assertEqual(m.requests[0]["headers"]["authorization"], "Bearer hook")
        t = self.pack(self.state(), **o)
        self.assertIn("not allowed", self.run_tool(t, "http_post", {"url": "http://evil.example/x", "body": "{}"}, "agent:10")["error"])
        self.assertIn("only https", self.run_tool(self.pack(self.state(), http={"allow_hosts": [host]}), "http_post", {"url": m.url, "body": "{}"}, "agent:11")["error"])

    def test_receiver_that_ignores_the_key_sees_it_twice(self):
        m = self.mock(http_handler, honors=False)
        m.drop_next = 1
        t = self.pack(self.state(), tries=3, http={"allow_hosts": [m.url.split("//")[1]], "allow_http": True})
        self.assertTrue(self.run_tool(t, "http_post", {"url": m.url + "/x", "body": "{}"}, "agent:12")["ok"])
        self.assertEqual(len(m.effects), 2)


class SlackGithubTests(Base):
    def test_slack_found_by_marker(self):
        m = self.mock(slack_handler, history=True)
        o = {"slack": {"token": "t", "base_url": m.url, "channels": ["C1"]}}
        st = self.state()
        m.drop_next = 1
        with self.assertRaises(RetryLater):
            self.run_tool(self.pack(st, **o), "slack_post_message", {"channel": "C1", "text": "Deployed."}, "agent:13")
        out = self.run_tool(self.pack(st, **o), "slack_post_message", {"channel": "C1", "text": "Deployed."}, "agent:13")
        self.assertTrue(out["ok"] and out["found"])
        self.assertEqual(len(m.effects), 1)
        self.assertEqual(m.effects[0]["metadata"], {"event_type": "argentic_action", "event_payload": {"key": "agent:13"}})

    def test_slack_without_history_holds_or_retries(self):
        for policy, expect in (("hold", 1), ("retry", 2)):
            m = self.mock(slack_handler, history=False)
            o = {"slack": {"token": "t", "base_url": m.url, "on_ambiguous": policy}}
            st = self.state()
            m.drop_next = 1
            with self.assertRaises(RetryLater):
                self.run_tool(self.pack(st, **o), "slack_post_message", {"channel": "C1", "text": "Hi"}, "agent:14")
            out = self.run_tool(self.pack(st, **o), "slack_post_message", {"channel": "C1", "text": "Hi"}, "agent:14")
            if policy == "hold":
                self.assertEqual(out["outcome"], "unknown")
            self.assertEqual(len(m.effects), expect, policy)

    def test_slack_channel_allow_list(self):
        m = self.mock(slack_handler, history=True)
        t = self.pack(self.state(), slack={"token": "t", "base_url": m.url, "channels": ["C1"]})
        self.assertIn("not allowed", self.run_tool(t, "slack_post_message", {"channel": "C9", "text": "x"}, "agent:16")["error"])
        self.assertEqual(len(m.requests), 0)

    def test_github_issue_and_comment_found_by_marker(self):
        m = self.mock(github_handler, list_broken=False)
        o = {"github": {"token": "t", "base_url": m.url, "repos": ["acme/app"]}}
        st = self.state()
        m.drop_next = 1
        a = {"repo": "acme/app", "title": "Refund failed", "body": "Order 1182"}
        with self.assertRaises(RetryLater):
            self.run_tool(self.pack(st, **o), "github_create_issue", a, "agent:17")
        out = self.run_tool(self.pack(st, **o), "github_create_issue", a, "agent:17")
        self.assertTrue(out["ok"] and out["found"])
        self.assertEqual(len(m.effects), 1)
        self.assertIn("<!-- argentic-key:agent:17 -->", m.effects[0]["body"])

        st2 = self.state()
        c = {"repo": "acme/app", "issue_number": 7, "body": "Fixed."}
        m.drop_next = 1
        with self.assertRaises(RetryLater):
            self.run_tool(self.pack(st2, **o), "github_create_comment", c, "agent:18")
        m.list_broken = True
        held = self.run_tool(self.pack(st2, **o), "github_create_comment", c, "agent:18")
        self.assertEqual(held["outcome"], "unknown")
        self.assertEqual(len(m.effects), 2)

    def test_github_repo_allow_list(self):
        m = self.mock(github_handler, list_broken=False)
        t = self.pack(self.state(), github={"token": "t", "base_url": m.url, "repos": ["acme/app"]})
        self.assertIn("not allowed", self.run_tool(t, "github_create_issue", {"repo": "other/app", "title": "t"}, "agent:20")["error"])
        self.assertEqual(len(m.requests), 0)


class SmtpTests(Base):
    def setUp(self):
        super().setUp()
        self.smtp = SmtpMock()
        self.closers.append(self.smtp.close)

    def opts(self, **extra):
        return {"smtp": {"host": "127.0.0.1", "port": self.smtp.port, "user": "user", "password": "pass", "from": "Argentic <account@getargentic.com>", **extra}}

    def test_sends_once_with_message_id_and_key_header(self):
        t = self.pack(self.state(), **self.opts())
        a = {"to": "dana@example.com", "subject": "Refund", "body": "Line one"}
        r1 = self.run_tool(t, "send_email", a, "agent:21")
        r2 = self.run_tool(t, "send_email", a, "agent:21")
        self.assertTrue(r1["ok"])
        self.assertEqual(r1, r2)
        self.assertEqual(len(self.smtp.messages), 1)
        self.assertIn(f"Message-ID: {r1['messageId']}", self.smtp.messages[0])
        self.assertIn("X-Argentic-Idempotency-Key: agent:21", self.smtp.messages[0])

    def test_cut_off_after_data_is_held(self):
        st = self.state()
        self.smtp.drop_after_data = 1
        a = {"to": "a@b.co", "subject": "s", "body": "b"}
        out = self.run_tool(self.pack(st, **self.opts()), "send_email", a, "agent:22")
        self.assertEqual(out["outcome"], "unknown")
        self.assertEqual(self.run_tool(self.pack(st, **self.opts()), "send_email", a, "agent:22")["outcome"], "unknown")
        self.assertEqual(len(self.smtp.messages), 1)

    def test_retry_policy_sends_again_with_the_same_message_id(self):
        self.smtp.drop_after_data = 1
        out = self.run_tool(self.pack(self.state(), tries=3, **self.opts(on_ambiguous="retry")), "send_email", {"to": "a@b.co", "subject": "s", "body": "b"}, "agent:23")
        self.assertTrue(out["ok"])
        self.assertEqual(len(self.smtp.messages), 2)
        ids = [l for m in self.smtp.messages for l in m.splitlines() if l.startswith("Message-ID:")]
        self.assertEqual(ids[0], ids[1])

    def test_started_intent_with_no_result_holds(self):
        st = self.state()
        with open(st, "w") as f:
            json.dump({"entries": {"agent:24": {"state": "started", "tool": "send_email", "at": "2026-10-21T00:00:00Z"}}}, f)
        out = self.run_tool(self.pack(st, **self.opts()), "send_email", {"to": "a@b.co", "subject": "s", "body": "b"}, "agent:24")
        self.assertEqual(out["outcome"], "unknown")
        self.assertEqual(self.smtp.messages, [])

    def test_refused_recipient_is_a_result(self):
        out = self.run_tool(self.pack(self.state(), **self.opts()), "send_email", {"to": "bad@example.com", "subject": "s", "body": "b"}, "agent:25")
        self.assertFalse(out["ok"])
        self.assertIn("550", out["error"])


class PackShapeTests(Base):
    def test_names(self):
        names = lambda **o: [t.name for t in tool_pack(state_path=self.state(), **o)]
        self.assertEqual(names(), [])
        self.assertEqual(names(smtp={"host": "h", "from": "a@b.co"}, resend={"api_key": "k", "from": "a@b.co"}), ["send_email", "send_email_smtp"])
        self.assertEqual(names(stripe={"secret_key": "k"}, github={"token": "t"}), ["stripe_refund", "stripe_charge", "github_create_issue", "github_create_comment"])


class RunDurableRetryLaterTests(Base):
    def test_retry_later_is_not_written_to_the_ledger(self):
        calls = []

        class Fake(Argentic):
            def wake(self, agent, message, **kw):
                from argentic_labs.core import WakeResponse
                calls.append(kw["idempotency_key"])
                if kw["idempotency_key"].endswith(".0"):
                    return WakeResponse("done", "", 0.0, 1, "wk_0", [{"id": "a", "tool": "boom", "args": {}, "seq": 1}])
                return WakeResponse("done", "finished", 0.0, 1, "wk_1")

        attempts = {"n": 0}

        def boom(args, ctx):
            attempts["n"] += 1
            if attempts["n"] == 1:
                raise RetryLater("no answer")
            return {"ok": True}

        ledger = os.path.join(self.dir, "ledger.json")
        run = lambda: run_durable(Fake("k", "mk", "http://x"), agent="a", run_id="r", task="t", tools=[Tool("boom", "", {"type": "object", "properties": {}}, boom)],
                                  ledger_path=ledger, model={}, log=lambda s: None)
        with self.assertRaises(RetryLater):
            run()
        self.assertFalse(os.path.exists(ledger))
        out = run()
        self.assertEqual(out.reply, "finished")
        self.assertEqual(attempts["n"], 2)


if __name__ == "__main__":
    unittest.main()
