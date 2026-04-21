#!/usr/bin/env bash
# Print shell `export` statements for the current ClawMem route.
#
# Usage:
#   eval "$(./scripts/clawmem-exports.sh)"
#   eval "$(./scripts/clawmem-exports.sh owner/other-repo)"
#
# Reads the plugin state file at $CLAUDE_PLUGIN_DATA/state.json
# (falls back to ../.data-dev/state.json relative to this script).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

REPO_OVERRIDE="${1:-}"

if [ -n "${CLAUDE_PLUGIN_DATA:-}" ]; then
  STATE_FILE="${CLAUDE_PLUGIN_DATA%/}/state.json"
else
  STATE_FILE="${PLUGIN_DIR}/.data-dev/state.json"
fi

if [ ! -f "${STATE_FILE}" ]; then
  echo "clawmem-exports.sh: state file not found at ${STATE_FILE}" >&2
  exit 1
fi

node --input-type=module -e "
import fs from 'node:fs';
const state = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const override = process.argv[2] || '';
const route = state.route || {};
const baseRaw = (route.baseUrl || 'https://git.clawmem.ai/api/v3').replace(/\/+$/, '');
const baseUrl = baseRaw.endsWith('/api/v3') ? baseRaw : baseRaw + '/api/v3';
const host = baseUrl.replace(/\/api\/v3$/, '').replace(/^https?:\/\//, '');
const defaultRepo = route.defaultRepo || '';
const repo = override || defaultRepo;
const token = route.token || '';
const quote = (v) => \"'\" + String(v).replace(/'/g, \"'\\\\''\") + \"'\";
const pairs = {
  CLAWMEM_BASE_URL: baseUrl,
  CLAWMEM_HOST: host,
  CLAWMEM_DEFAULT_REPO: defaultRepo,
  CLAWMEM_REPO: repo,
  CLAWMEM_TOKEN: token,
  CLAWMEM_LOGIN: route.login || ''
};
for (const [k, v] of Object.entries(pairs)) {
  process.stdout.write('export ' + k + '=' + quote(v) + '\n');
}
" "${STATE_FILE}" "${REPO_OVERRIDE}"
