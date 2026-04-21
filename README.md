# ClawMem Claude Code Plugin

ClawMem for Claude Code is a repo-backed durable memory plugin that provisions a per-agent route, recalls relevant memory before prompts, mirrors turns into conversation issues, and exposes manual memory tools over MCP.

> **Using Codex instead?** Install [clawmem-codex-plugin](https://github.com/clawmem-ai/clawmem-codex-plugin) via the Codex Plugins UI — bundles the ClawMem behavior skill and a `hooks.json` template (auto-recall + conversation mirroring, behind the `codex_hooks` feature flag). Same ClawMem backend.

## Install And Use

Install from the GitHub-hosted marketplace:

```sh
claude plugin marketplace add https://github.com/clawmem-ai/clawmem-claude-code-plugin
claude plugin install clawmem-claude-code-plugin@clawmem
```

After installation, start Claude Code normally:

```sh
claude
```

Upgrade the marketplace metadata and the installed plugin:

```sh
claude plugin marketplace update clawmem
claude plugin update clawmem-claude-code-plugin@clawmem
```

The plugin auto-bootstraps on first use by calling `POST /api/v3/agents` against `https://git.clawmem.ai/api/v3`, then stores the provisioned route in Claude's plugin data directory.

## What is implemented

- first-run bootstrap with `POST /api/v3/agents`, with automatic fallback to `POST /api/v3/anonymous/session` on older backends
- plugin-local route persistence via `CLAUDE_PLUGIN_DATA`, with `0o700` dir / `0o600` file permissions on POSIX
- `UserPromptSubmit` hook runs recall query sanitization (envelope / URL / prior injection stripping, 1500-char cap) and injects `hookSpecificOutput.additionalContext`
- `Stop` hook mirrors turns into a `type:conversation` issue incrementally using a `lastMirroredCount` cursor; each turn becomes a dedicated comment
- `SessionEnd` hook flips `status:active` → `status:closed` via `syncManagedLabels` before closing the issue, preserving any unmanaged labels
- plugin manifest ships `configSchema` + `uiHints` for `baseUrl` / `defaultRepo` / `token` / `consoleBaseUrl` / `memoryRecallLimit` / `memoryAutoRecallLimit`
- MCP tools (38 total):
  - **Memory (10):** `memory_recall`, `memory_list`, `memory_get`, `memory_store`, `memory_update`, `memory_forget`, `memory_labels`, `memory_repos`, `memory_repo_create`, `memory_repo_set_default`
  - **Console (1):** `memory_console` — returns a browsable Console URL
  - **Generic issues (6):** `issue_create`, `issue_list`, `issue_get`, `issue_update`, `issue_comment_add`, `issue_comments_list`
  - **Collaboration F1 (9):** `collaboration_org_invitation_create` (supports `teamIds`), `collaboration_team_membership_set`, `collaboration_user_repo_invitations` / `_accept` / `_decline`, `collaboration_user_org_invitations` / `_accept` / `_decline`, `collaboration_repo_access_inspect`
  - **Collaboration F2 (11):** `collaboration_teams`, `collaboration_team`, `collaboration_team_members`, `collaboration_team_repos`, `collaboration_team_repo_set` / `_remove`, `collaboration_team_membership_remove`, `collaboration_repo_collaborators`, `collaboration_repo_invitations`, `collaboration_repo_collaborator_set` / `_remove`
  - **Collaboration F3 (1):** `collaboration_admin_invoke` — single meta tool dispatching the rarely-used admin actions (team CRUD, org invitation revoke, org member management, outside collaborators, repo transfer/rename)

All `collaboration_*` write operations require `confirmed=true`. Preview the intended change first and re-call with `confirmed=true` only after the user agrees.

Memory writes are idempotent: `memory_store` computes `sha256(detail)` and, when the hash matches an active memory, merges `kind` and `topics` into the existing issue instead of creating a duplicate.

## Local development

Clone the plugin and start Claude Code with it loaded by absolute path (session-only):

```sh
git clone https://github.com/clawmem-ai/clawmem-claude-code-plugin.git
claude --plugin-dir /path/to/clawmem-claude-code-plugin
```

`--plugin-dir` enables the plugin only for that session. For a persistent local install, add the plugin directory as a marketplace instead:

```sh
claude plugin marketplace add /path/to/clawmem-claude-code-plugin
claude plugin install clawmem-claude-code-plugin@clawmem
```

The plugin reads these environment variables when present:

- `CLAWMEM_GIT_BASE_URL`
- `CLAWMEM_BASE_URL`
- `CLAWMEM_CONSOLE_BASE_URL` (overrides console URL used by `memory_console`; defaults to `console.<host>` derived from the API base)
- `CLAWMEM_AGENT_PREFIX`
- `CLAWMEM_DEFAULT_REPO_NAME`
- `CLAWMEM_MEMORY_RECALL_LIMIT` (default limit for manual `memory_recall`; defaults to 5)
- `CLAWMEM_MEMORY_AUTO_RECALL_LIMIT` (max memories auto-injected before each prompt; defaults to 3)
- `CLAWMEM_TOKEN` (overrides the bootstrapped token; usually unnecessary)
- `CLAWMEM_DEFAULT_REPO` (overrides the default repo for tool calls)

Claude Code also passes any `configSchema` field as `CLAUDE_PLUGIN_OPTION_<key>`; the plugin reads both forms so configuration through the plugin UI works identically to environment variables.

If both `CLAWMEM_BASE_URL` and `CLAWMEM_GIT_BASE_URL` are unset, the plugin defaults to `https://git.clawmem.ai/api/v3`.

For local backend development, override the API URL explicitly:

```sh
CLAWMEM_BASE_URL=http://127.0.0.1:4003/api/v3 claude --plugin-dir /path/to/clawmem-claude-code-plugin
```

To print the current route as shell exports (useful for manual `gh`/`curl` debugging), run:

```sh
/path/to/clawmem-claude-code-plugin/scripts/clawmem-exports.sh
```

## Testing

Run unit tests:

```sh
cd plugin/clawmem-claude-code-plugin
npm test
```

Run the Claude CLI smoke test. It targets a local backend by default (`http://127.0.0.1:4003/api/v3`):

```sh
cd plugin/clawmem-claude-code-plugin
./e2e/claude-cli-smoke.sh
```

Run it against staging (`https://git.staging.clawmem.ai/api/v3`):

```sh
./e2e/claude-cli-smoke.sh --target=staging
# or
npm run test:e2e:staging
```

Explicit override still wins:

```sh
CLAWMEM_BASE_URL=http://127.0.0.1:4003/api/v3 ./e2e/claude-cli-smoke.sh
```

The smoke test exercises a real Claude CLI session and verifies:

- plugin manifest validation
- first-run bootstrap via `POST /api/v3/agents`
- route persistence in the plugin data directory
- conversation issue mirroring through the `Stop` hook (reads `transcript_path` to recover the assistant turn)
- recall hook execution through the `UserPromptSubmit` hook

The smoke test requires a working local Claude Code installation with valid authentication and region access. If `claude -p` itself fails, the script stops with the captured CLI error.

## Current e2e limitation

The automated smoke test intentionally verifies hook-driven integration, not deterministic model-driven MCP tool invocation.

Reason:

- Claude deciding to call a specific MCP tool from a natural-language prompt is model behavior, not a stable CLI contract.
- That makes a pure prompt-level assertion for `memory_store` or `memory_update` too flaky for an automated smoke test.

What is still covered automatically:

- the MCP server starts with the plugin
- hook-driven bootstrap, recall, and mirroring work through the real `claude` CLI

Recommended manual MCP verification:

1. Start Claude with `claude --plugin-dir /path/to/clawmem-claude-code-plugin`
2. Ask Claude to use `memory_store` to save a short fact
3. Ask Claude to use `memory_recall` for that fact
4. Confirm the memory issue exists in the provisioned repo
