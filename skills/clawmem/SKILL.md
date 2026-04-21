---
name: clawmem
description: Durable memory workflows for the ClawMem Claude Code plugin. Use when recalling prior preferences, project history, decisions, lessons, or active tasks; saving or updating durable memories; or repairing ClawMem route state.
---

# ClawMem For Claude Code

ClawMem is the durable memory system for this Claude Code installation.

## What the plugin already does

The plugin automatically:

- provisions an agent identity on first use
- stores the token and default repo in plugin-local storage
- recalls active `type:memory` issues before relevant prompts
- mirrors turns into a `type:conversation` issue

## Runtime expectations

- Use `memory_recall` before answering questions about prior preferences, prior decisions, or historical project context.
- Use `memory_store` for important durable facts that should survive this session.
- Use `memory_update` when a canonical fact evolves.
- Use `memory_forget` when a memory is no longer true.
- Use `memory_console` when the user asks where to view, browse, or visualize their memories in a browser. Return the URL directly.
- Treat the current route's `defaultRepo` as the private default memory space unless the user explicitly chooses a shared repo.

## Collaboration tools

- Use `collaboration_repo_access_inspect` when the user asks why someone can or cannot see a memory repo.
- Use `collaboration_org_invitation_create` when the user wants to invite an outside user and pre-assign them to a team in one step (the web console cannot do this).
- Use `collaboration_team_membership_set` to promote or demote a team member's role.
- Use `collaboration_user_repo_invitations` / `collaboration_user_org_invitations` to surface pending invitations addressed to the current agent identity.
- Any `collaboration_*` tool that writes requires `confirmed=true`. Preview the intended change to the user first; only call with `confirmed=true` after they agree.
- For team/repo access management, prefer the dedicated `collaboration_team_*` / `collaboration_repo_*` tools. Use `collaboration_admin_invoke` only for the rarely-needed admin actions it explicitly supports (team CRUD, org invitation revoke, org member removal, outside-collaborator listing, repo transfer/rename).

## Communication

- When you recall something important, say so briefly.
- When you save or update a durable memory, tell the user.
- Do not expose raw tokens in output, logs, or memories.

## Repair

- If memory tools fail with auth errors, inspect the plugin-local state and reprovision by deleting stale route state.
- If recall is unavailable, continue the task and treat it as a backend outage rather than a memory miss.
