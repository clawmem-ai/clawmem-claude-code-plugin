# ClawMem Repair And Verification

Use this reference when ClawMem is already installed in Claude Code but the tools are not available, the per-agent route is missing or broken, or you need to verify the install after setup.

The plugin README is the primary setup guide. This reference is for post-install repair, diagnostics, and compatibility reminders.

## Contents

- Verify install and provisioning
- Verify read access from the current route
- Verify the MCP tool path
- Compatibility mode for CLAUDE.md
- Definition of done
- If ClawMem is still broken

## Step 1: Verify install and provisioning

First verify that the ClawMem plugin is installed and its MCP server is reachable:

```sh
claude plugin list
```

Expected: `clawmem-claude-code-plugin@clawmem` appears in the list as installed.

Then verify the current agent route. The plugin persists state under `CLAUDE_PLUGIN_DATA` (defaults to `.data-dev/` in local dev, `~/.claude/plugins/data/clawmem-claude-code-plugin@clawmem/` when installed from the marketplace). Use the bundled helper:

```sh
eval "$(/path/to/clawmem-claude-code-plugin/scripts/clawmem-exports.sh)"
printf 'login=%s\nbase=%s\ndefaultRepo=%s\ntoken=%s\n' \
  "${CLAWMEM_LOGIN}" "${CLAWMEM_BASE_URL}" "${CLAWMEM_DEFAULT_REPO}" \
  "$(test -n "${CLAWMEM_TOKEN}" && printf SET || printf MISSING)"
```

If `CLAWMEM_DEFAULT_REPO` or `CLAWMEM_TOKEN` is missing, the current agent has not been provisioned yet. Start a fresh Claude Code session; the plugin bootstraps on first use by calling `POST /api/v3/agents` (with automatic fallback to `POST /api/v3/anonymous/session` on older backends) and persists the route.

## Step 2: Verify read access from the current route

This proves that a fresh session can query ClawMem using the current agent's provisioned route.

```sh
eval "$(/path/to/clawmem-claude-code-plugin/scripts/clawmem-exports.sh)"

test -n "$CLAWMEM_REPO" || { echo "Current agent route has no repo yet"; exit 1; }
test -n "$CLAWMEM_TOKEN" || { echo "Current agent route has no token yet"; exit 1; }

GH_HOST="$CLAWMEM_HOST" GH_ENTERPRISE_TOKEN="$CLAWMEM_TOKEN" \
  gh issue list --repo "$CLAWMEM_REPO" --limit 1 --json number,title
```

If `gh` is unavailable or not the official GitHub CLI, use the fallback probe:

```sh
curl -sf -H "Authorization: token $CLAWMEM_TOKEN" \
  "$CLAWMEM_BASE_URL/repos/$CLAWMEM_REPO/issues?state=open&per_page=1&type=issues" | \
  jq 'map({number,title})'
```

If either command returns JSON, even `[]`, the route is usable.

## Step 3: Verify the MCP tool path

From a normal Claude Code session with the plugin enabled, verify that:

- `memory_repos` lists accessible repos and marks the default repo
- `memory_list` returns the active memory index
- `memory_get` fetches one exact memory by id or ref
- `memory_labels` returns the current reusable schema labels
- `memory_recall` returns either a hit list or a clean miss
- `memory_store` is available for immediate durable saves
- `memory_update` updates an existing memory in place
- `memory_forget` retires a stale memory
- `memory_repo_create` creates a new repo when a new memory space is needed
- `memory_console` returns a browsable Console URL

If a tool is missing, check that the MCP server was launched (`.mcp.json` starts `npx -y clawmem-mcp-server` on session start). Auto-recall context injected via the `UserPromptSubmit` hook may appear at the start of the next real turn, not immediately after a memory write.

## Compatibility mode for CLAUDE.md

If your project or user-level `CLAUDE.md` still relies on file-injected identity or behavior reminders, use these compact compatibility snippets. Do not duplicate the entire skill body into `CLAUDE.md`.

### Optional identity block

```markdown
## Memory System — ClawMem
I use ClawMem as my long-term memory system.
When prior context may help, I search ClawMem before answering.
```

### Optional per-turn reminder

```markdown
Before ending every response, ask: "Did I learn anything durable this turn?"
If yes or unsure, save new memory content to ClawMem in the user's current language.
When updating an existing memory, keep that node in its current language unless the user asks to rewrite it.
```

### Optional tool-pointer reminder

```markdown
ClawMem is the primary long-term memory system.
Use the bundled `clawmem` skill for retrieval, saving, routing, schema, and troubleshooting.
```

These snippets are compatibility aids, not the primary runtime source of truth — Claude Code auto-activates the `clawmem` skill when relevant.

## Definition of done

- The plugin is installed (`claude plugin list` shows it)
- `.mcp.json` launches `clawmem-mcp-server` and tools appear in the session
- The current agent route has a `defaultRepo`
- The current agent route has a `token`
- Read-only probe from Step 2 works without manual `gh auth login`
- Plugin memory tools work from a normal session
- The bundled `clawmem` skill is available after installation

## If ClawMem is still broken

- If the plugin is missing from `claude plugin list`, re-run the marketplace install (`claude plugin install clawmem-claude-code-plugin@clawmem`) and restart Claude Code.
- If the plugin is installed but MCP tools do not appear, confirm `.mcp.json` is valid JSON and that `npx -y clawmem-mcp-server` runs without error from a shell (network reachable, npm cache usable).
- If the route is missing a repo or token, start a fresh session so bootstrap runs, and re-check with Step 1.
- If a new session returns `401 Unauthorized`, re-read the current route from plugin state instead of assuming the old repo or token is still valid. Stale route state in `CLAUDE_PLUGIN_DATA/state.json` can be removed; the plugin re-provisions on next session.
- If your environment still depends on `CLAUDE.md`, add the compatibility snippets above rather than pasting large sections of this skill into that file.
