# ClawMem Collaboration

Use this reference when memory should live in a shared repo instead of one agent's private default repo, or when multiple agents or teammates need to read and write the same memory space. Use it for both `collaboration` and `collabration` requests.

## Contents

- When to use
- Default operating style
- Repo routing and shared spaces
- Collaboration model
- Choose the right mechanism
- Pre-mutation checklist
- Prompt-to-tool mapping
- Team memory quality bar
- Collaboration rule of thumb
- Manual org-owned shared repo creation
- Fallback mode

## When to use

Use this reference when the user asks to:

- invite someone into an organization and optionally assign them to a team
- inspect, accept, or decline an invitation sent to the current user
- add, remove, or change a repo collaborator's role
- grant a team access to a repo
- inspect teams, team members, or team-repo mappings
- inspect the effective access state of a repo
- create a shared team memory repo (requires admin; see `collaboration_admin_invoke`)
- debug why a user can or cannot access a repo

Do not use this workflow for ordinary memory recall or save actions unless the user is specifically asking to change who can access a memory repo.

## Default operating style

- Prefer the built-in ClawMem collaboration tools first.
- Inspect current state before mutating anything.
- Every `collaboration_*` write tool requires `confirmed=true`. Preview the exact org, team, repo, invitation, or permission change to the user first and only call again with `confirmed=true` after explicit agreement.
- Fall back to `gh api` or `curl` only when plugin tools are unavailable or when debugging backend behavior directly.
- Reuse the main `clawmem` skill's route-resolution helper when raw shell access is required.
- Think in canonical runtime permissions: `read`, `write`, `admin`.
- Treat GitHub-compatible aliases such as `pull`, `triage`, `push`, and `maintain` as transport compatibility only.

Tool-first rule:

- Read-only inspection:
  - `collaboration_teams`
  - `collaboration_team`
  - `collaboration_team_members`
  - `collaboration_team_repos`
  - `collaboration_repo_collaborators`
  - `collaboration_repo_invitations`
  - `collaboration_user_repo_invitations`
  - `collaboration_user_org_invitations`
  - `collaboration_repo_access_inspect`

- Direct-action mutations:
  - `collaboration_org_invitation_create` (supports pre-assigning `teamIds`)
  - `collaboration_team_membership_set`
  - `collaboration_team_membership_remove`
  - `collaboration_team_repo_set`
  - `collaboration_team_repo_remove`
  - `collaboration_repo_collaborator_set`
  - `collaboration_repo_collaborator_remove`
  - `collaboration_user_repo_invitation_accept`
  - `collaboration_user_repo_invitation_decline`
  - `collaboration_user_org_invitation_accept`
  - `collaboration_user_org_invitation_decline`

- Meta dispatcher for rarely-used admin actions:
  - `collaboration_admin_invoke` — single entry point for team CRUD (`team_create`, `team_update`, `team_delete`), org invitation revoke, org member removal, outside collaborator listing, and repo transfer / rename. Reach for it only when the dedicated tools above do not cover the request.

## Repo routing and shared spaces

Before explicit memory operations, choose the right repo:
- Private personal memory: usually the current agent's `defaultRepo`
- Project memory: the relevant project repo
- Shared or team knowledge: the shared repo for that team or project
- Unclear: inspect `memory_repos`, then choose deliberately

Do not treat `defaultRepo` as the only space. It is only the fallback.

Default tool path:
- Use `memory_repos` to inspect accessible spaces
- Use `memory_repo_create` when a new repo should be owned by the current agent identity
- Use `collaboration_admin_invoke` with a team-CRUD or repo-transfer action when the memory space must be governed by an organization team
- Use `memory_repo_set_default` when a repo move or routing change should update the current agent's automatic default
- Pass `repo` explicitly to `memory_recall`, `memory_list`, `memory_get`, `memory_store`, `memory_update`, and `memory_forget` when the target is not the current `defaultRepo`

This keeps private memory, project memory, and shared memory separate without forcing extra plugin configuration changes.

## Collaboration model

Reason with these rules before every collaboration action:

- An organization is an explicit governance boundary.
- Org membership is explicit and separate from team membership.
- Teams are org-scoped authorization groups, not social groups.
- Effective repo access is `max(org base permission, direct collaborator grant, team grant)` after owner or admin shortcuts.
- Runtime permissions are only `none`, `read`, `write`, and `admin`.
- Organization invitation roles are `member` and `owner`.
- `memory_repos` only shows repos that are already accessible now; it does not prove there are no pending invitations.
- The repo collaborators API includes the repository owner row; reason about direct collaborators as explicit non-owner shares.
- A repo collaborator grant may create a pending repository invitation instead of immediate access when the target user is not already a collaborator.
- Accepting a repository invitation is what turns a pending share into visible repo access for the invitee.
- Outside collaborators are non-members who still have direct collaborator access to at least one org-owned repo — list them via `collaboration_admin_invoke` with the outside-collaborator action.
- Accepting an org invitation creates org membership, joins invited teams as `member`, and removes the pending invitation.
- Org default repository permission can still grant repo access to active org members even after direct collaborator or team grants are removed.
- If a user becomes an org member, any outside-collaborator row for that org should disappear.

## Choose the right mechanism

Use this decision map:

| Goal | Use |
|---|---|
| Give one user access to one repo without org membership | `collaboration_repo_collaborator_set` |
| Bring one user into the org (optionally pre-assign teams) | `collaboration_org_invitation_create` (pass `teamIds`) |
| Grant a group access to selected repos | `collaboration_team_repo_set` |
| Create or rename a team | `collaboration_admin_invoke` (team CRUD) |
| Move an existing memory repo under org governance | `collaboration_admin_invoke` (repo transfer) |
| Create another memory space under the current agent identity | `memory_repo_create` |
| Inspect non-members who still have repo access | `collaboration_admin_invoke` (outside collaborators) |
| Debug why someone can still see a repo | `collaboration_repo_access_inspect` |

Hard rules:
- Never assume team membership creates org membership.
- Never use team membership as a side-door org bootstrap.
- Never assume a repo share should become org membership; choose intentionally.
- If the task is org-scoped, ensure the org already exists first.

## Pre-mutation checklist

Before any write action:

1. Identify the acting identity, target org, target repo, target user, target team, and desired permission.
2. Normalize the user's requested permission mentally to `read`, `write`, or `admin` before reasoning.
3. Inspect current state first when the request is ambiguous.
4. If the action changes governance, permissions, membership, or invitations, require explicit user intent or confirmation — every `collaboration_*` write needs `confirmed=true`.
5. Never paste raw tokens into chat or files.

Read-only checks can run without confirmation.

## Prompt-to-tool mapping

Translate user intent like this:

- `Give Alice access to this one memory repo`
  - inspect direct collaborators first with `collaboration_repo_collaborators`
  - preview and then call `collaboration_repo_collaborator_set` with `confirmed=true`
  - if the user was not already a collaborator, expect a pending repo invitation and verify with `collaboration_repo_invitations`
- `Bring Alice into the org and platform team`
  - inspect teams first with `collaboration_teams`
  - preview and then call `collaboration_org_invitation_create` with `teamIds` and `confirmed=true`
- `Rename or delete this team`
  - inspect the team with `collaboration_team`
  - preview and then call `collaboration_admin_invoke` with the `team_update` or `team_delete` action and `confirmed=true`
- `Who is in team platform?`
  - use `collaboration_team_members`
- `Grant the platform team access to this repo`
  - inspect existing team-repo mapping with `collaboration_team_repos`
  - preview and then call `collaboration_team_repo_set` with `confirmed=true`
- `Move this repo into org acme so team access can govern it`
  - ensure the target org already exists and the actor has org admin rights
  - preview and then call `collaboration_admin_invoke` with the repo-transfer action and `confirmed=true`
  - if the moved repo was the current agent's `defaultRepo`, the plugin may retarget `defaultRepo` automatically after a successful transfer; otherwise call `memory_repo_set_default` explicitly
- `Someone shared a memory repo with me; can you see it and accept it?`
  - start with `collaboration_user_repo_invitations`
  - do not treat a `memory_repos` miss as proof that no share exists
  - preview and then call `collaboration_user_repo_invitation_accept` with `confirmed=true`
- `I still cannot see the shared memory repo`
  - inspect `collaboration_user_repo_invitations` first
  - if needed, have the repo owner inspect `collaboration_repo_invitations`
- `Why can Bob still see this repo?`
  - start with `collaboration_repo_access_inspect`
  - if you know the username, pass it so the tool can check membership and base access explicitly
  - then drill into `collaboration_repo_collaborators`, `collaboration_repo_invitations`, `collaboration_team_repos`, and — via `collaboration_admin_invoke` — outside collaborator listings as needed
- `Remove Carol from the org`
  - inspect current access with `collaboration_repo_access_inspect`
  - preview and then call `collaboration_admin_invoke` with the org-member-removal action and `confirmed=true`
- `Revoke the pending org invite for Alice`
  - inspect with `collaboration_user_org_invitations` (if Alice is the current actor) or ask the org admin to inspect their side
  - preview and then call `collaboration_admin_invoke` with the org-invitation-revoke action and `confirmed=true`

## Team memory quality bar

- Private memories can start rough and become cleaner over time
- Shared memories should be conclusions, not speculation
- When access is governed by teams or org policy, prefer org-owned repos over one user's private space
- Use stable `kind:*` and `topic:*` labels so different agents can retrieve the same schema
- Prefer updating a canonical shared fact in place instead of creating competing duplicates

## Collaboration rule of thumb

If knowledge should stay personal, keep it in the agent's default repo. If it should shape multiple agents or people, put it in a shared repo and target that repo explicitly on retrieval and save.

## Manual org-owned shared repo creation

Use the plugin tool path first:

- Prefer `collaboration_admin_invoke` with the appropriate org-repo-create or repo-transfer action for org-owned repo creation.
- Use raw `gh api` or `curl` only when plugin tools are unavailable or when debugging backend behavior directly.
- `memory_repo_create` still only creates repos under the current agent identity.

### With `gh api`

```sh
GH_HOST="$CLAWMEM_HOST" GH_ENTERPRISE_TOKEN="$CLAWMEM_TOKEN" \
  gh api -X POST "/orgs/<org>/repos" \
    -f name='team-memory' \
    -F private=true \
    -F has_issues=true
```

### With `curl`

```sh
curl -sf -X POST "$CLAWMEM_BASE_URL/orgs/<org>/repos" \
  -H "Authorization: token $CLAWMEM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "team-memory", "private": true, "has_issues": true}'
```

After the repo exists:
- grant the team access with `collaboration_team_repo_set`
- use the main memory tools with explicit `repo` targeting for read and write flows
- reuse [manual-ops.md](manual-ops.md) only if you need raw memory issue control after the repo already exists

If the repo already exists under a personal owner and should become org-governed instead of creating a fresh repo:
- use `collaboration_admin_invoke` with the repo-transfer action
- if that repo was the acting agent's `defaultRepo`, the plugin retargets `defaultRepo` automatically after a successful transfer
- then continue with team grants and explicit `repo` targeting against the new org-owned full name

## Fallback mode

If the collaboration tools are unavailable, use `gh api` against the ClawMem host; fall back to `curl` only when `gh` is unavailable or broken.

Command pattern:

```sh
GH_HOST="$CLAWMEM_HOST" GH_ENTERPRISE_TOKEN="$CLAWMEM_TOKEN" \
  gh api "/user"
```

If `gh` cannot be used:

```sh
curl -sf -H "Authorization: token $CLAWMEM_TOKEN" \
  "$CLAWMEM_BASE_URL/user"
```
