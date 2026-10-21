"""The client's HTTP behaviour against an in-process server: headers, errors and hints, retries, timeouts, replay.

Run from adapters/python: python -m unittest discover -s tests -v
"""
import os
import socket
import sys
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from argentic_labs import DEFAULT_BASE_URL, FREE_MODEL, Argentic, ArgenticError, hint_for  # noqa: E402
from fake_server import serve  # noqa: E402

MODEL = {"provider": "nvidia", "id": "x", "prices": {"in": 0, "out": 0}}
OK = {"status": "done", "reply": "hi", "spent_usd": 0.5, "turns": 2, "wake_id": "wk_1"}


class ClientTest(unittest.TestCase):
    def client(self, server, **kw):
        sleeps = []
        kw.setdefault("api_key", "aek_test")
        c = Argentic(base_url=server.url, sleep=sleeps.append, log=lambda s: None, **kw)
        c.sleeps = sleeps
        return c

    def serve(self, handler):
        server = serve(handler)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    def wake(self, c, key="k.0"):
        return c.wake("a1", "hello", model=MODEL, idempotency_key=key)

    # ---- configuration ----

    def test_defaults_come_from_the_environment(self):
        env = {"ARGENTIC_API_KEY": "aek_env", "MODEL_KEY": "mk_env", "ARGENTIC_BASE_URL": "http://example.test/"}
        with mock.patch.dict(os.environ, env, clear=True):
            c = Argentic()
        self.assertEqual((c.api_key, c.model_key, c.base_url), ("aek_env", "mk_env", "http://example.test"))

    def test_the_production_api_is_the_default(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            c = Argentic()
        self.assertEqual(c.base_url, "https://api.getargentic.com")
        self.assertEqual(c.base_url, DEFAULT_BASE_URL)

    def test_arguments_beat_the_environment(self):
        with mock.patch.dict(os.environ, {"ARGENTIC_API_KEY": "aek_env", "ARGENTIC_BASE_URL": "http://env.test"}, clear=True):
            c = Argentic(api_key="aek_arg", base_url="http://arg.test")
        self.assertEqual((c.api_key, c.base_url), ("aek_arg", "http://arg.test"))

    def test_the_request_carries_the_key_the_model_key_and_a_user_agent(self):
        server = self.serve(lambda *a: (200, OK, None))
        c = self.client(server, model_key="mk")
        r = self.wake(c)
        path, headers, body = server.requests[0]
        self.assertEqual(path, "/v1/agents/a1/wake")
        self.assertEqual(headers["authorization"], "Bearer aek_test")
        self.assertEqual(headers["x-model-key"], "mk")
        self.assertEqual(headers["idempotency-key"], "k.0")
        self.assertRegex(headers["user-agent"], r"^argentic-labs-python/\d+\.\d+\.\d+")
        self.assertEqual(body, {"message": "hello", "model": MODEL})
        self.assertEqual((r.status, r.reply, r.spent_usd, r.turns, r.wake_id, r.replayed), ("done", "hi", 0.5, 2, "wk_1", False))

    def test_no_model_key_means_no_header(self):
        server = self.serve(lambda *a: (200, OK, None))
        with mock.patch.dict(os.environ, {}, clear=True):
            self.wake(self.client(server))
        self.assertNotIn("x-model-key", server.requests[0][1])

    def test_system_tools_and_limits_are_sent_only_when_given(self):
        server = self.serve(lambda *a: (200, OK, None))
        c = self.client(server)
        tools = [{"name": "t", "description": "d", "parameters": {"type": "object", "properties": {}}}]
        c.wake("a1", "m", model=MODEL, idempotency_key="k", system="s", tools=tools, limits={"max_turns": 3})
        self.assertEqual(server.requests[0][2], {"message": "m", "model": MODEL, "system": "s", "tools": tools, "limits": {"max_turns": 3}})

    def test_an_agent_id_is_escaped_in_the_path(self):
        server = self.serve(lambda *a: (200, {**OK, "turns": []}, None))
        c = self.client(server)
        c.wake("my agent/../x", "m", model=MODEL, idempotency_key="k")
        c.replay("my agent/../x", "wk_1")
        self.assertEqual([r[0] for r in server.requests], ["/v1/agents/my%20agent%2F..%2Fx/wake", "/v1/agents/my%20agent%2F..%2Fx/replay"])

    def test_the_free_model_is_the_nvidia_one(self):
        self.assertEqual((FREE_MODEL["provider"], FREE_MODEL["id"], FREE_MODEL["prices"]),
                         ("nvidia", "nvidia/nemotron-3.5-lightning-30b-a3b", {"in": 0, "out": 0}))

    # ---- answers ----

    def test_a_stored_answer_is_marked_replayed(self):
        server = self.serve(lambda *a: (200, OK, {"Idempotent-Replay": "true"}))
        self.assertTrue(self.wake(self.client(server)).replayed)

    def test_resumed_and_error_are_kept(self):
        server = self.serve(lambda *a: (200, {**OK, "status": "error", "error": "provider_rate_limited", "resumed": True}, None))
        r = self.wake(self.client(server))
        self.assertEqual((r.status, r.error, r.resumed), ("error", "provider_rate_limited", True))
        self.assertEqual(r.raw["error"], "provider_rate_limited")

    def test_any_2xx_is_an_answer(self):
        server = self.serve(lambda *a: (202, OK, None))
        self.assertEqual(self.wake(self.client(server)).wake_id, "wk_1")

    # ---- errors and hints ----

    def test_a_4xx_raises_with_status_body_and_detail(self):
        server = self.serve(lambda *a: (400, {"error": "bad_model", "detail": "no such model"}, None))
        with self.assertRaises(ArgenticError) as cm:
            self.wake(self.client(server))
        e = cm.exception
        self.assertEqual((e.status, str(e)), (400, "wake failed: HTTP 400 bad_model: no such model"))
        self.assertEqual(e.body["error"], "bad_model")
        self.assertIn("ARGENTIC_MODEL_ID", hint_for(e))
        self.assertEqual(len(server.requests), 1)  # not retried

    def test_the_402_hint_says_the_beta_is_free(self):
        server = self.serve(lambda *a: (402, {"error": "usage_limit"}, None))
        with self.assertRaises(ArgenticError) as cm:
            self.wake(self.client(server))
        hint = hint_for(cm.exception)
        self.assertIn("free in beta", hint)
        self.assertIn("hi@getargentic.com", hint)

    def test_hints_for_401_429_and_a_provider_refusing_the_key(self):
        for status, body, word in [(401, {"error": "unauthorized"}, "ARGENTIC_API_KEY"), (429, {"error": "rate_limited"}, "Too many"),
                                   (403, {"error": "model_key_rejected"}, "MODEL_KEY")]:
            server = self.serve(lambda *a, s=status, b=body: (s, b, None))
            with self.assertRaises(ArgenticError) as cm:
                self.wake(self.client(server))
            self.assertIn(word, hint_for(cm.exception))
        self.assertIsNone(hint_for(ValueError("not ours")))
        self.assertIsNone(hint_for(ArgenticError("x", 404, {"error": "not_found"})))

    def test_a_reused_key_raises_422(self):
        server = self.serve(lambda *a: (422, {"error": "idempotency_key_reused"}, None))
        with self.assertRaises(ArgenticError) as cm:
            self.wake(self.client(server))
        self.assertEqual(cm.exception.status, 422)

    def test_a_json_list_body_is_not_a_crash(self):
        server = self.serve(lambda *a: (404, ["nope"], None))
        with self.assertRaises(ArgenticError) as cm:
            self.wake(self.client(server))
        self.assertEqual(cm.exception.status, 404)

    # ---- retries ----

    def test_a_5xx_is_retried_with_backoff_on_the_same_key(self):
        answers = iter([(503, {"error": "unavailable"}, None), (500, {"error": "boom"}, None), (200, OK, None)])
        server = self.serve(lambda *a: next(answers))
        c = self.client(server)
        self.assertEqual(self.wake(c).status, "done")
        self.assertEqual(c.sleeps, [1, 2])
        self.assertEqual({r[1]["idempotency-key"] for r in server.requests}, {"k.0"})

    def test_it_gives_up_after_the_backoff_runs_out(self):
        server = self.serve(lambda *a: (503, {"error": "unavailable"}, None))
        c = self.client(server)
        with self.assertRaises(ArgenticError) as cm:
            self.wake(c)
        self.assertEqual((cm.exception.status, str(cm.exception)), (503, "wake failed after 5 tries (HTTP 503)"))
        self.assertEqual(c.sleeps, [1, 2, 4, 8])
        self.assertEqual(len(server.requests), 5)
        self.assertIn("did not answer", hint_for(cm.exception))

    def test_backoff_is_configurable(self):
        server = self.serve(lambda *a: (503, {}, None))
        c = self.client(server, backoff=(0.5, 0.5))
        with self.assertRaises(ArgenticError):
            self.wake(c)
        self.assertEqual((c.sleeps, len(server.requests)), ([0.5, 0.5], 3))

    def test_a_network_error_is_retried_and_has_no_status(self):
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        sock.close()  # nothing listens here now
        sleeps = []
        c = Argentic(api_key="aek_test", base_url=f"http://127.0.0.1:{port}", sleep=sleeps.append, log=lambda s: None, backoff=(1, 2))
        with self.assertRaises(ArgenticError) as cm:
            self.wake(c)
        self.assertIsNone(cm.exception.status)
        self.assertIn("no answer", str(cm.exception))
        self.assertEqual(sleeps, [1, 2])
        self.assertIn("did not answer", hint_for(cm.exception))

    def test_a_silent_server_hits_the_timeout(self):
        def slow(*a):
            time.sleep(0.6)
            return 200, OK, None

        server = self.serve(slow)
        c = self.client(server, timeout=0.2, backoff=())
        with self.assertRaises(ArgenticError) as cm:
            self.wake(c)
        self.assertIsNone(cm.exception.status)

    def test_the_default_timeout_outlasts_a_long_wake(self):
        self.assertGreaterEqual(Argentic().timeout, 300)

    def test_a_queued_answer_waits_the_time_it_names_then_resends(self):
        answers = iter([(409, {"status": "queued", "retry_after": 0}, None), (409, {"status": "queued", "retry_after": 2.5}, None),
                        (409, {"status": "queued", "retry_after": 99}, None), (409, {"status": "queued"}, None), (200, OK, None)])
        server = self.serve(lambda *a: next(answers))
        c = self.client(server)
        self.wake(c)
        self.assertEqual(c.sleeps, [0, 2.5, 5, 1])  # zero means now, the wait is capped at 5, none named means 1

    def test_it_stops_waiting_on_a_queue_that_never_clears(self):
        server = self.serve(lambda *a: (409, {"status": "queued", "retry_after": 0}, None))
        c = self.client(server, max_queued_waits=3)
        with self.assertRaises(ArgenticError) as cm:
            self.wake(c)
        self.assertEqual((cm.exception.status, len(server.requests)), (409, 4))

    # ---- replay ----

    def test_replay_adds_the_counts(self):
        turns = [{"turn_seq": 1, "match": True}, {"turn_seq": 2, "match": False}, {"turn_seq": 3, "match": None}, {"turn_seq": 4, "match": True}]
        server = self.serve(lambda *a: (200, {"turns": turns}, None))
        r = self.client(server).replay("a1", "wk_1")
        self.assertEqual((r["matched"], r["mismatched"], r["unverifiable"], len(r["turns"])), (2, 1, 1, 4))
        self.assertEqual(server.requests[0][2], {"wake": "wk_1"})

    def test_replay_keeps_the_counts_the_api_sends(self):
        server = self.serve(lambda *a: (200, {"turns": [], "matched": 7, "mismatched": 0, "unverifiable": 0, "rerun": {"status": "identical"}}, None))
        r = self.client(server).replay("a1", "wk_1")
        self.assertEqual((r["matched"], r["rerun"]["status"]), (7, "identical"))

    def test_replay_survives_a_blip_and_a_queue(self):
        answers = iter([(503, {}, None), (409, {"retry_after": 0}, None), (200, {"turns": [{"match": True}]}, None)])
        server = self.serve(lambda *a: next(answers))
        c = self.client(server)
        self.assertEqual(c.replay("a1", "wk_1")["matched"], 1)

    def test_replay_errors_name_the_call(self):
        server = self.serve(lambda *a: (404, {"error": "no_such_wake"}, None))
        with self.assertRaises(ArgenticError) as cm:
            self.client(server).replay("a1", "wk_x")
        self.assertEqual((cm.exception.status, str(cm.exception)), (404, "replay failed: HTTP 404 no_such_wake"))


if __name__ == "__main__":
    unittest.main()
