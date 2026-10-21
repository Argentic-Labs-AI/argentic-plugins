"""An in-process stand-in for the Argentic API, for tests that need no network.

`serve(handler)` listens on a free local port. The handler gets `(path, headers, body)` for each POST and
returns `(status, json, extra_headers)`. `refund_handler()` is a scripted agent with the API's real
idempotency rules: one stored answer per key, a stable `seq` per agent, 422 on a reused key.
"""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REFUND_SCRIPT = [
    ("refund_order", {"order_id": "1182", "amount_usd": 42}),
    ("send_email", {"to": "dana@example.com", "subject": "Refund", "body": "Your refund is on its way."}),
    ("close_ticket", {"ticket_id": "T-77", "note": "Refunded and emailed."}),
    None,  # the final reply
]


def serve(handler):
    requests = []  # (path, headers dict with lower-case keys, body)

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            raw = self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}"
            body = json.loads(raw)
            headers = {k.lower(): v for k, v in self.headers.items()}
            requests.append((self.path, headers, body))
            status, payload, extra = handler(self.path, headers, body)
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            try:
                self.wfile.write(data)
            except BrokenPipeError:  # the client timed out and left
                pass

        def log_message(self, *a):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
    server.requests = requests
    server.url = f"http://127.0.0.1:{server.server_address[1]}"
    return server


def refund_handler(script=REFUND_SCRIPT):
    answers = {}  # key -> (body, response)
    seqs = {}  # agent -> last seq
    counts = {}  # agent -> wakes answered, which is where its script has got to
    lock = threading.Lock()

    def handle(path, headers, body):
        parts = path.strip("/").split("/")  # v1 agents <agent> <verb>
        agent, verb = parts[2], parts[3]
        if verb == "replay":
            return 200, {"turns": [{"turn_seq": 1, "match": True}]}, None
        with lock:
            key = headers["idempotency-key"]
            if key in answers:
                old, resp = answers[key]
                if old != body:
                    return 422, {"error": "idempotency_key_reused"}, None
                return 200, resp, {"Idempotent-Replay": "true"}
            n = counts.get(agent, 0)
            counts[agent] = n + 1
            step = script[n]
            resp = {"status": "done", "reply": "", "spent_usd": 0, "turns": 1, "wake_id": f"wk_{n}"}
            if step is None:
                resp["reply"] = "Refunded, emailed and closed."
            else:
                seqs[agent] = seqs.get(agent, 0) + 1
                resp["actions"] = [{"id": f"a{seqs[agent]}", "tool": step[0], "args": step[1], "seq": seqs[agent]}]
            answers[key] = (body, resp)
            return 200, resp, None

    return handle
