# A plain agent loop in Python, standard library only, no checkpoints: the same three-step ticket as plain-agent.mjs.
# It starts from the top on every run, so crash-test catches it repeating finished actions. crash-test works on any language:
# it only watches what reaches the sink. Run: crash-test -- python3 examples/python-agent.py
import json
import os
import urllib.request

sink = os.environ.get("CRASHTEST_SINK_URL")
if not sink:
    raise SystemExit("Run me under crash-test: it sets CRASHTEST_SINK_URL.")


def call(path, body):
    req = urllib.request.Request(
        sink + path,
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as res:
        return json.load(res)


plan = [
    ("/refund_order", {"order_id": "1182", "amount_usd": 42}),
    ("/send_email", {"to": "dana@example.com", "subject": "Your refund", "body": "Your refund is on its way."}),
    ("/close_ticket", {"ticket_id": "T-77", "note": "Refunded and emailed."}),
]
for path, body in plan:
    call(path, body)
    print(f"did {path}")
print("done")
