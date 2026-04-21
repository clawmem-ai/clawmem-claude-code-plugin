#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="$ROOT"

TARGET="${CLAWMEM_E2E_TARGET:-local}"
if [ $# -gt 0 ]; then
  case "$1" in
    --target=*) TARGET="${1#--target=}"; shift ;;
    --target)   TARGET="${2:-}"; shift 2 ;;
  esac
fi

case "$TARGET" in
  local)
    DEFAULT_API_BASE="http://127.0.0.1:4003/api/v3"
    ;;
  staging)
    DEFAULT_API_BASE="https://git.staging.clawmem.ai/api/v3"
    ;;
  *)
    echo "unknown --target: $TARGET (expected: local|staging)" >&2
    exit 2
    ;;
esac

API_BASE="${CLAWMEM_BASE_URL:-$DEFAULT_API_BASE}"
PROMPT_ONE="${CLAWMEM_E2E_PROMPT_ONE:-Reply with exactly: CLAWMEM-E2E-OK}"
PROMPT_TWO="${CLAWMEM_E2E_PROMPT_TWO:-jq shell e2e}"
PLUGIN_DATA_BASE="${CLAUDE_PLUGIN_DATA_BASE:-$HOME/.claude/plugins/data}"
PLUGIN_DATA_GLOB="${PLUGIN_DATA_BASE}/clawmem-claude-code-plugin*"
STATE_DIR=""
STATE_FILE=""
EVENT_LOG=""

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

need claude
need node
need jq
need curl
need python3

export CLAWMEM_BASE_URL="$API_BASE"
echo "== target: $TARGET ($API_BASE) =="

resolve_state_dir() {
  python3 - <<'PY' "$PLUGIN_DATA_BASE"
import glob
import os
import sys
base = sys.argv[1]
matches = sorted(glob.glob(os.path.join(base, "clawmem-claude-code-plugin*")))
print(matches[-1] if matches else "")
PY
}

run_claude_prompt() {
  local prompt="$1"
  local output_file="$2"
  local error_file="$3"
  if ! claude -p --plugin-dir "$PLUGIN_DIR" "$prompt" >"$output_file" 2>"$error_file"; then
    echo "claude CLI run failed for prompt: $prompt" >&2
    cat "$error_file" >&2 || true
    cat <<'EOF' >&2

Common causes:
- Claude Code is not authenticated on this machine
- Anthropic account access is unavailable in the current region
- Local Claude Code installation is unhealthy
EOF
    exit 1
  fi
}

rm -rf $PLUGIN_DATA_GLOB 2>/dev/null || true

echo "== validate plugin manifest =="
claude plugin validate "$PLUGIN_DIR"

echo "== run Claude prompt to trigger bootstrap + mirroring =="
run_claude_prompt "$PROMPT_ONE" /tmp/clawmem-claude-e2e.out /tmp/clawmem-claude-e2e.err
cat /tmp/clawmem-claude-e2e.out

STATE_DIR="$(resolve_state_dir)"
STATE_FILE="${STATE_DIR}/state.json"
EVENT_LOG="${STATE_DIR}/debug/events.jsonl"

test -n "$STATE_DIR" || {
  echo "plugin data directory not found under $PLUGIN_DATA_BASE" >&2
  exit 1
}

test -f "$STATE_FILE" || {
  echo "state file not created at $STATE_FILE" >&2
  exit 1
}

TOKEN="$(jq -r '.route.token // empty' "$STATE_FILE")"
REPO="$(jq -r '.route.defaultRepo // empty' "$STATE_FILE")"

test -n "$TOKEN" || {
  echo "token missing in state file" >&2
  exit 1
}
test -n "$REPO" || {
  echo "defaultRepo missing in state file" >&2
  exit 1
}

echo "== verify mirrored conversation issue exists =="
SEARCH_Q="$(python3 - <<'PY' "$REPO"
import sys, urllib.parse
repo = sys.argv[1]
print(urllib.parse.quote(f'repo:{repo} label:type:conversation'))
PY
)"
curl -sf -H "Authorization: token $TOKEN" "$API_BASE/search/issues?q=$SEARCH_Q&per_page=20" | jq '.items | length' | grep -Eq '^[1-9][0-9]*$'

echo "== seed one memory directly via backend =="
for label in "type:memory" "kind:convention" "topic:testing"; do
  curl -sf -X POST \
    -H "Authorization: token $TOKEN" \
    -H "Content-Type: application/json" \
    "$API_BASE/repos/$REPO/labels" \
    -d "{\"name\":\"$label\",\"color\":\"1d76db\",\"description\":\"$label\"}" >/dev/null || true
done

curl -sf -X POST \
  -H "Authorization: token $TOKEN" \
  -H "Content-Type: application/json" \
  "$API_BASE/repos/$REPO/issues" \
  -d @- >/tmp/clawmem-claude-e2e-memory.json <<'JSON'
{
  "title": "Memory: jq is preferred in shell e2e",
  "body": "type: memory\ndetail: |-\n  Use jq for JSON assertions in shell e2e tests.\n",
  "labels": ["type:memory", "kind:convention", "topic:testing"]
}
JSON
cat /tmp/clawmem-claude-e2e-memory.json | jq '.number'

echo "== run Claude prompt to trigger recall hook =="
run_claude_prompt "$PROMPT_TWO" /tmp/clawmem-claude-e2e-recall.out /tmp/clawmem-claude-e2e-recall.err
cat /tmp/clawmem-claude-e2e-recall.out

test -f "$EVENT_LOG" || {
  echo "event log missing at $EVENT_LOG" >&2
  exit 1
}

grep -q '"type":"recall_complete"' "$EVENT_LOG" || {
  echo "recall_complete event not found in $EVENT_LOG" >&2
  exit 1
}

grep -q '"type":"mirror_complete"' "$EVENT_LOG" || {
  echo "mirror_complete event not found in $EVENT_LOG" >&2
  exit 1
}

grep -Eq '"type":"recall_complete".*"count":[1-9][0-9]*' "$EVENT_LOG" || {
  echo "recall_complete event with count > 0 not found in $EVENT_LOG" >&2
  exit 1
}

echo "== smoke test passed =="
