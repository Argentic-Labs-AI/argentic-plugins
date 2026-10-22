# LangChain refund demo

A small support agent with three LangChain `@tool` functions: refund an order, email the customer, close the ticket. Argentic runs the agent loop. The run is stopped on purpose after the refund, then started again to show it resumes without repeating a finished action.

You need Python 3.10+. About 10 minutes.

Get the code first. The example imports the adapter from `../../adapters`, so clone the whole repo:

```bash
git clone https://github.com/Argentic-Labs-AI/argentic-plugins
cd argentic-plugins/examples/langchain
```

## 1. Get two keys

- Argentic API key: https://getargentic.com/platform
- A free NVIDIA NIM key: build.nvidia.com

## 2. Set up

bash / zsh:

```bash
export ARGENTIC_API_KEY=aek_...
export MODEL_KEY=nvapi-...
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

fish:

```fish
set -x ARGENTIC_API_KEY aek_...
set -x MODEL_KEY nvapi-...
python3 -m venv .venv; and source .venv/bin/activate.fish
pip install -r requirements.txt
```

## 3. Run, stop, run again

```
ARGENTIC_CRASH_AFTER=1 python refund.py
python refund.py
```

In fish, use `env ARGENTIC_CRASH_AFTER=1 python refund.py` for the first command.

The first run stops itself right after the refund. The second prints `skip seq 7 refund_order: already done before` (your number may differ), sends the email, closes the ticket and finishes. It then re-checks each wake with `replay` and prints how many outbox lines each tool wrote (1 each).

Use `python refund.py --fresh` to start over with a new agent.

## 4. See the proof of what ran

Open the link the second run prints (`https://getargentic.com/platform/runs/<agent>/<run>/`). It is the run that crashed, in your dashboard. Under **Proof of what ran**, press **Check**: it rebuilds every prompt from the journal and compares it with what the model was sent. **Re-run** does the same for the engine's own decisions. Both are free.

## Tests

No keys needed. They use a fake server in the same process:

```
python -m unittest -v
```

## Notes

Side effects land in `./outbox.jsonl`, so you can see for yourself that nothing finished ran twice. This is at-least-once: an action cut off while it was running runs again on resume, so real handlers should be safe to repeat.
