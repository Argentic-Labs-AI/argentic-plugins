#!/usr/bin/env bash
# Synthetic monitor for Argentic prod. Public URLs only.
#   tools/ops/watch.sh            core checks (no database touched, so a frequent cron cannot keep Neon awake)
#   DEEP=1 ARGENTIC_PROBE_KEY=aek_... PROBE_MODEL_KEY=... tools/ops/watch.sh
#                                       also reads /v1/usage and runs one tiny real wake on a dedicated probe tenant
# Writes $OUT_DIR/core and $OUT_DIR/deep ("up" or "down", deep only when it ran) and $OUT_DIR/report.txt. Exit 0 always; the workflow decides what a change means.
set -uo pipefail
SITE_URL="${SITE_URL:-https://getargentic.com}"
API_URL="${API_URL:-https://api.getargentic.com}"
OUT_DIR="${OUT_DIR:-.}"
ATTEMPTS="${ATTEMPTS:-3}"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
core_fails=0 deep_fails=0 deep_ran=0
: > "$OUT_DIR/report.txt"
say() { printf '%s\n' "$*" | tee -a "$OUT_DIR/report.txt"; }

# probe <core|deep> <name> <status regex> <grep or ""> <curl args...>: up to ATTEMPTS tries, 10 s apart, so one blip is not an outage
probe() {
  local tier="$1" name="$2" want="$3" grep_for="$4"; shift 4
  local code="" i
  for i in $(seq 1 "$ATTEMPTS"); do
    code=$(curl -sS -m 25 -D "$tmp/h" -o "$tmp/b" -w '%{http_code}' "$@" 2> "$tmp/e") || code="curl:$(head -c 80 "$tmp/e")"
    if [[ "$code" =~ ^($want)$ ]] && { [ -z "$grep_for" ] || grep -qi -- "$grep_for" "$tmp/h" "$tmp/b"; }; then
      say "ok    $name ($code)"; return 0
    fi
    [ "$i" -lt "$ATTEMPTS" ] && sleep 10
  done
  say "FAIL  $name: got $code, wanted $want${grep_for:+ containing \"$grep_for\"}"
  if [ "$tier" = core ]; then core_fails=$((core_fails + 1)); else deep_fails=$((deep_fails + 1)); fi
  return 1
}

JSON='content-type: application/json'
probe core "site home"             200 '<html'                  "$SITE_URL/"
probe core "site docs"             200 '<html'                  "$SITE_URL/docs/"
probe core "site sign-in"          '200|307|308' ''             "$SITE_URL/platform/"
probe core "site /ingest"          200 ''                       "$SITE_URL/ingest/static/array.js"
probe core "site /mcp"             401 ''                       -X POST -H "$JSON" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$SITE_URL/mcp"
probe core "api /health"           200 '"ok":true'              "$API_URL/health"
probe core "api refuses no key"    401 '"unauthorized"'         "$API_URL/v1/usage"
probe core "api /mcp"              401 ''                       -X POST -H "$JSON" -d '{}' "$API_URL/mcp"

if [ "${DEEP:-}" = 1 ]; then
  if [ -z "${ARGENTIC_PROBE_KEY:-}" ] || [ -z "${PROBE_MODEL_KEY:-}" ]; then
    say "skip  deep checks (no probe key or model key set)"
  else
    deep_ran=1
    # Both touch the database, so they run a few times a day, not every cron tick.
    probe deep "api usage with key" 200 '"days"' -H "Authorization: Bearer $ARGENTIC_PROBE_KEY" "$API_URL/v1/usage"
    # One wake on a free model. The same Idempotency-Key within the hour continues the same wake instead of adding one.
    probe deep "api wake round trip" 200 '"status":"done"' -X POST -H "$JSON" \
      -H "Authorization: Bearer $ARGENTIC_PROBE_KEY" -H "X-Model-Key: $PROBE_MODEL_KEY" -H "Idempotency-Key: watch-$(date -u +%Y%m%d%H)" \
      -d '{"message":"What is 17 * 23? Answer in one short sentence.","model":{"provider":"nvidia","id":"nvidia/nemotron-3.5-super-vl-120b-a12b","prices":{"in":0.1,"out":0.4}}}' \
      "$API_URL/v1/agents/watch/wake"
  fi
fi

[ "$core_fails" -eq 0 ] && echo up > "$OUT_DIR/core" || echo down > "$OUT_DIR/core"
rm -f "$OUT_DIR/deep"
if [ "$deep_ran" -eq 1 ]; then [ "$deep_fails" -eq 0 ] && echo up > "$OUT_DIR/deep" || echo down > "$OUT_DIR/deep"; fi
say "core: $(cat "$OUT_DIR/core"), deep: $(cat "$OUT_DIR/deep" 2>/dev/null || echo not run)"
exit 0
