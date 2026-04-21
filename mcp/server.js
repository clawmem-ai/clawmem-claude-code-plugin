#!/usr/bin/env node
const { appendEvent, loadState, mutateState } = require("../lib/state");
const { resolveMemoryRecallLimit } = require("../lib/config");
const github = require("../lib/github");
const { buildConsoleUrl, ensureRoute, recall, summarizeMemory } = require("../lib/runtime");
const collab = require("../lib/collaboration");

const TOOL_DEFS = [
  {
    name: "memory_recall",
    description: "Search active ClawMem memories in the current default repo.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 20 }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "memory_list",
    description: "List ClawMem memories in the current default repo. Filter by status, kind, and topic.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["open", "closed", "all"] },
        status: {
          type: "string",
          enum: ["active", "stale", "all"],
          description: "Alias for state: active → open, stale → closed, all → all."
        },
        kind: { type: "string", description: "Filter by a single kind label value (without the `kind:` prefix)." },
        topic: { type: "string", description: "Filter by a single topic label value (without the `topic:` prefix)." },
        limit: { type: "integer", minimum: 1, maximum: 100 }
      },
      additionalProperties: false
    }
  },
  {
    name: "memory_get",
    description: "Fetch one ClawMem memory. Accepts an issue number or a memory ref string.",
    inputSchema: {
      type: "object",
      properties: {
        memoryId: { type: "integer", minimum: 1 },
        ref: {
          type: "string",
          description: "Memory reference string (falls back to search if numeric GET misses)."
        },
        status: { type: "string", enum: ["active", "stale", "all"] }
      },
      additionalProperties: false
    }
  },
  {
    name: "memory_store",
    description: "Store one atomic durable memory immediately.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        detail: { type: "string", minLength: 1 },
        kind: { type: "string" },
        topics: { type: "array", items: { type: "string" }, maxItems: 10 }
      },
      required: ["detail"],
      additionalProperties: false
    }
  },
  {
    name: "memory_update",
    description: "Update an existing ClawMem memory in place.",
    inputSchema: {
      type: "object",
      properties: {
        memoryId: { type: "integer", minimum: 1 },
        title: { type: "string" },
        detail: { type: "string" },
        kind: { type: "string" },
        topics: { type: "array", items: { type: "string" }, maxItems: 10 }
      },
      required: ["memoryId"],
      additionalProperties: false
    }
  },
  {
    name: "memory_forget",
    description: "Mark a ClawMem memory as closed.",
    inputSchema: {
      type: "object",
      properties: {
        memoryId: { type: "integer", minimum: 1 }
      },
      required: ["memoryId"],
      additionalProperties: false
    }
  },
  {
    name: "memory_labels",
    description: "List the schema of active memory labels in the current default repo. Returns {kinds, topics}. Use this before inventing a new kind or topic, to reuse existing labels instead of creating near-duplicates.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "memory_repos",
    description: "List memory repositories the current agent can access. Returns owner/name, description, private, and whether the repo is the current default.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "memory_repo_create",
    description: "Create a new memory repository. Defaults to private. Owner defaults to the current agent; pass `org` to create under an organization instead.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1 },
        org: { type: "string", description: "Organization login to create the repo under. Omit to create under the current user." },
        description: { type: "string" },
        private: { type: "boolean" },
        autoInit: { type: "boolean" },
        setDefault: { type: "boolean", description: "Also make this the plugin default repo." }
      },
      required: ["name"],
      additionalProperties: false
    }
  },
  {
    name: "memory_repo_set_default",
    description: "Set the plugin's default memory repo. Persists across sessions but only within this plugin install (writes to state.json).",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", pattern: "^[^/\\s]+/[^/\\s]+$", description: "Full repo name, e.g. owner/memory." }
      },
      required: ["repo"],
      additionalProperties: false
    }
  },
  {
    name: "issue_create",
    description: "Create a generic issue in a target repo for queueing work, coordination, or shared tracking outside the structured memory schema.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1 },
        body: { type: "string" },
        labels: { type: "array", items: { type: "string" }, maxItems: 50 },
        assignees: { type: "array", items: { type: "string" }, maxItems: 20 },
        state: { type: "string", enum: ["open", "closed"] },
        stateReason: { type: "string" },
        repo: { type: "string", description: "Target repo in owner/name form. Defaults to the plugin default." }
      },
      required: ["title"],
      additionalProperties: false
    }
  },
  {
    name: "issue_list",
    description: "List generic issues in a target repo with optional label and assignment filters.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["open", "closed", "all"] },
        labels: { type: "array", items: { type: "string" }, maxItems: 50 },
        assignee: { type: "string" },
        creator: { type: "string" },
        mentioned: { type: "string" },
        sort: { type: "string", enum: ["created", "updated", "comments"] },
        direction: { type: "string", enum: ["asc", "desc"] },
        since: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        repo: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "issue_get",
    description: "Fetch one generic issue by issue number from a target repo.",
    inputSchema: {
      type: "object",
      properties: {
        issueNumber: { type: "integer", minimum: 1 },
        repo: { type: "string" }
      },
      required: ["issueNumber"],
      additionalProperties: false
    }
  },
  {
    name: "issue_update",
    description: "Update a generic issue in place, including title, body, state, labels, assignees, and lock status. `labels` and `assignees` are full replacements; pass an empty array to clear.",
    inputSchema: {
      type: "object",
      properties: {
        issueNumber: { type: "integer", minimum: 1 },
        title: { type: "string" },
        body: { type: "string" },
        state: { type: "string", enum: ["open", "closed"] },
        stateReason: { type: "string" },
        labels: { type: "array", items: { type: "string" }, maxItems: 50 },
        assignees: { type: "array", items: { type: "string" }, maxItems: 20 },
        locked: { type: "boolean" },
        repo: { type: "string" }
      },
      required: ["issueNumber"],
      additionalProperties: false
    }
  },
  {
    name: "issue_comment_add",
    description: "Add a comment to an issue so agents can post task output, status, or handoff notes.",
    inputSchema: {
      type: "object",
      properties: {
        issueNumber: { type: "integer", minimum: 1 },
        body: { type: "string", minLength: 1 },
        replyToCommentId: { type: "integer", minimum: 1 },
        repo: { type: "string" }
      },
      required: ["issueNumber", "body"],
      additionalProperties: false
    }
  },
  {
    name: "issue_comments_list",
    description: "List issue comments so agents can inspect task output, the latest handoff, or completion notes.",
    inputSchema: {
      type: "object",
      properties: {
        issueNumber: { type: "integer", minimum: 1 },
        sort: { type: "string", enum: ["created", "updated"] },
        direction: { type: "string", enum: ["asc", "desc"] },
        since: { type: "string" },
        threaded: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        repo: { type: "string" }
      },
      required: ["issueNumber"],
      additionalProperties: false
    }
  },
  {
    name: "collaboration_org_invitation_create",
    description: "Invite a user to an organization, optionally pre-assigning them to one or more teams at invite time. Console UI cannot bind team_ids at invitation. Write operation: requires confirmed=true.",
    inputSchema: {
      type: "object",
      properties: {
        org: { type: "string", minLength: 1, description: "Organization login." },
        inviteeLogin: { type: "string", minLength: 1, description: "Invitee username." },
        role: { type: "string", enum: ["member", "owner"] },
        teamIds: { type: "array", items: { type: "integer", minimum: 1 }, maxItems: 50 },
        expiresInDays: { type: "integer", minimum: 1, maximum: 30 },
        confirmed: { type: "boolean", description: "Must be true to execute the write." }
      },
      required: ["org", "inviteeLogin"],
      additionalProperties: false
    }
  },
  {
    name: "collaboration_team_membership_set",
    description: "Add a user to an organization team or adjust their team role (member or maintainer). Write operation: requires confirmed=true.",
    inputSchema: {
      type: "object",
      properties: {
        org: { type: "string", minLength: 1 },
        teamSlug: { type: "string", minLength: 1 },
        username: { type: "string", minLength: 1 },
        role: { type: "string", enum: ["member", "maintainer"] },
        confirmed: { type: "boolean" }
      },
      required: ["org", "teamSlug", "username", "role"],
      additionalProperties: false
    }
  },
  {
    name: "collaboration_user_repo_invitations",
    description: "List repository invitations pending for the current agent identity (read-only).",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "collaboration_user_repo_invitation_accept",
    description: "Accept a pending repository invitation on behalf of the current agent identity. Write operation: requires confirmed=true.",
    inputSchema: {
      type: "object",
      properties: {
        invitationId: { type: "integer", minimum: 1 },
        confirmed: { type: "boolean" }
      },
      required: ["invitationId"],
      additionalProperties: false
    }
  },
  {
    name: "collaboration_user_repo_invitation_decline",
    description: "Decline a pending repository invitation on behalf of the current agent identity. Write operation: requires confirmed=true.",
    inputSchema: {
      type: "object",
      properties: {
        invitationId: { type: "integer", minimum: 1 },
        confirmed: { type: "boolean" }
      },
      required: ["invitationId"],
      additionalProperties: false
    }
  },
  {
    name: "collaboration_user_org_invitations",
    description: "List organization invitations pending for the current agent identity (read-only).",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "collaboration_user_org_invitation_accept",
    description: "Accept a pending organization invitation on behalf of the current agent identity. Write operation: requires confirmed=true.",
    inputSchema: {
      type: "object",
      properties: {
        invitationId: { type: "integer", minimum: 1 },
        confirmed: { type: "boolean" }
      },
      required: ["invitationId"],
      additionalProperties: false
    }
  },
  {
    name: "collaboration_user_org_invitation_decline",
    description: "Decline a pending organization invitation on behalf of the current agent identity. Write operation: requires confirmed=true.",
    inputSchema: {
      type: "object",
      properties: {
        invitationId: { type: "integer", minimum: 1 },
        confirmed: { type: "boolean" }
      },
      required: ["invitationId"],
      additionalProperties: false
    }
  },
  {
    name: "collaboration_teams",
    description: "List teams in an organization (read-only).",
    inputSchema: {
      type: "object",
      properties: { org: { type: "string", minLength: 1 } },
      required: ["org"],
      additionalProperties: false
    }
  },
  {
    name: "collaboration_team",
    description: "Fetch one team in an organization by slug (read-only).",
    inputSchema: {
      type: "object",
      properties: {
        org: { type: "string", minLength: 1 },
        teamSlug: { type: "string", minLength: 1 }
      },
      required: ["org", "teamSlug"],
      additionalProperties: false
    }
  },
  {
    name: "collaboration_team_members",
    description: "List members of an organization team (read-only).",
    inputSchema: {
      type: "object",
      properties: {
        org: { type: "string", minLength: 1 },
        teamSlug: { type: "string", minLength: 1 }
      },
      required: ["org", "teamSlug"],
      additionalProperties: false
    }
  },
  {
    name: "collaboration_team_repos",
    description: "List repos an organization team can access (read-only).",
    inputSchema: {
      type: "object",
      properties: {
        org: { type: "string", minLength: 1 },
        teamSlug: { type: "string", minLength: 1 }
      },
      required: ["org", "teamSlug"],
      additionalProperties: false
    }
  },
  {
    name: "collaboration_team_repo_set",
    description: "Grant (or update) a team's access to a repo. Write operation: requires confirmed=true.",
    inputSchema: {
      type: "object",
      properties: {
        org: { type: "string", minLength: 1 },
        teamSlug: { type: "string", minLength: 1 },
        repo: { type: "string", pattern: "^[^/\\s]+/[^/\\s]+$" },
        permission: { type: "string", enum: ["read", "write", "admin"] },
        confirmed: { type: "boolean" }
      },
      required: ["org", "teamSlug", "repo", "permission"],
      additionalProperties: false
    }
  },
  {
    name: "collaboration_team_repo_remove",
    description: "Remove a team's access to a repo. Write operation: requires confirmed=true.",
    inputSchema: {
      type: "object",
      properties: {
        org: { type: "string", minLength: 1 },
        teamSlug: { type: "string", minLength: 1 },
        repo: { type: "string", pattern: "^[^/\\s]+/[^/\\s]+$" },
        confirmed: { type: "boolean" }
      },
      required: ["org", "teamSlug", "repo"],
      additionalProperties: false
    }
  },
  {
    name: "collaboration_team_membership_remove",
    description: "Remove a user from an organization team. Write operation: requires confirmed=true.",
    inputSchema: {
      type: "object",
      properties: {
        org: { type: "string", minLength: 1 },
        teamSlug: { type: "string", minLength: 1 },
        username: { type: "string", minLength: 1 },
        confirmed: { type: "boolean" }
      },
      required: ["org", "teamSlug", "username"],
      additionalProperties: false
    }
  },
  {
    name: "collaboration_repo_collaborators",
    description: "List direct collaborators of a repo (read-only). Defaults to the plugin default repo.",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" } },
      additionalProperties: false
    }
  },
  {
    name: "collaboration_repo_invitations",
    description: "List pending invitations issued by a repo (read-only). Defaults to the plugin default repo.",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" } },
      additionalProperties: false
    }
  },
  {
    name: "collaboration_repo_collaborator_set",
    description: "Grant (or update) a user's direct access to a repo. Write operation: requires confirmed=true.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", pattern: "^[^/\\s]+/[^/\\s]+$" },
        username: { type: "string", minLength: 1 },
        permission: { type: "string", enum: ["read", "write", "admin"] },
        confirmed: { type: "boolean" }
      },
      required: ["username", "permission"],
      additionalProperties: false
    }
  },
  {
    name: "collaboration_repo_collaborator_remove",
    description: "Remove a user's direct access to a repo. Write operation: requires confirmed=true.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", pattern: "^[^/\\s]+/[^/\\s]+$" },
        username: { type: "string", minLength: 1 },
        confirmed: { type: "boolean" }
      },
      required: ["username"],
      additionalProperties: false
    }
  },
  {
    name: "collaboration_admin_invoke",
    description: "Rarely-used admin collaboration operations collapsed into one meta tool to keep the default tool list lean. Dispatches by action name. Write actions require confirmed=true. Supported actions: team_create, team_update, team_delete, org_invitations_list, org_invitation_revoke, org_members_list, org_member_remove, org_membership_remove, org_outside_collaborators_list, repo_transfer, repo_rename.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "team_create",
            "team_update",
            "team_delete",
            "org_invitations_list",
            "org_invitation_revoke",
            "org_members_list",
            "org_member_remove",
            "org_membership_remove",
            "org_outside_collaborators_list",
            "repo_transfer",
            "repo_rename"
          ]
        },
        params: {
          type: "object",
          description: "Action-specific parameters. See action docs: team_create {org,name,description?,privacy?}; team_update {org,teamSlug,name?,description?,privacy?}; team_delete {org,teamSlug}; org_invitations_list {org}; org_invitation_revoke {org,invitationId}; org_members_list {org,role?}; org_member_remove {org,username}; org_membership_remove {org,username}; org_outside_collaborators_list {org}; repo_transfer {repo,newOwner,newRepoName?}; repo_rename {repo,newName}.",
          additionalProperties: true
        },
        confirmed: { type: "boolean" }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "collaboration_repo_access_inspect",
    description: "Diagnose how a user is (or is not) granted access to a repo. Summarizes direct collaborators, team grants, pending invitations, and org default permission. Defaults to the plugin default repo.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Target repo in owner/name form. Defaults to the plugin default." },
        username: { type: "string", description: "Optional username to inspect for org membership state." }
      },
      additionalProperties: false
    }
  },
  {
    name: "memory_console",
    description: "Return a URL to the ClawMem Console where the user can browse, search, and manage memories in a web interface. Use when the user asks where to view or manage memories in a browser.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional search query to pre-fill in the console."
        },
        includeToken: {
          type: "boolean",
          description: "Include the agent token in the URL for one-click login. Default false."
        }
      },
      additionalProperties: false
    }
  }
];

let useLspFraming = false;

function encodeMessage(message) {
  const json = JSON.stringify(message);
  if (useLspFraming) {
    const body = Buffer.from(json, "utf8");
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
    process.stdout.write(Buffer.concat([header, body]));
    return;
  }
  process.stdout.write(`${json}\n`);
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function formatMemory(memory) {
  return [
    `#${memory.memoryId} ${memory.title}`,
    memory.detail,
    `state=${memory.state}`,
    memory.labels.length > 0 ? `labels=${memory.labels.join(",")}` : ""
  ].filter(Boolean).join("\n");
}

function formatIssueLabels(labels) {
  if (!Array.isArray(labels)) return "";
  const names = labels
    .map((entry) => (typeof entry === "string" ? entry : entry && entry.name ? entry.name : ""))
    .filter(Boolean);
  return names.length > 0 ? `labels=${names.join(",")}` : "";
}

function formatIssue(issue) {
  const parts = [
    `#${issue.number} ${issue.title || ""}`.trim(),
    `state=${issue.state || "open"}`
  ];
  const labels = formatIssueLabels(issue.labels);
  if (labels) parts.push(labels);
  if (issue.body) parts.push(String(issue.body).trim());
  return parts.filter(Boolean).join("\n");
}

function formatComment(comment) {
  const author = (comment && comment.user && (comment.user.login || comment.user.name)) || "(unknown)";
  const ts = comment && (comment.updated_at || comment.created_at);
  const body = String(comment && comment.body || "").trim();
  const header = `[${author}${ts ? ` @ ${ts}` : ""}]`;
  return `${header}\n${body}`;
}

function requireMutationConfirmation(args, action) {
  if (args && args.confirmed === true) return null;
  return textResult(
    [
      `Refusing to ${action} without explicit confirmation.`,
      "Re-call this tool with confirmed=true to proceed."
    ].join("\n")
  );
}

function splitOwnerRepo(fullName) {
  const [owner, repo] = String(fullName || "").split("/");
  return { owner: (owner || "").trim(), repo: (repo || "").trim() };
}

function resolveTargetRepo(route, args) {
  const raw = args && typeof args.repo === "string" ? args.repo.trim() : "";
  if (raw) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(raw)) throw new Error("repo must look like owner/name");
    return raw;
  }
  return route.defaultRepo;
}

async function handleToolCall(name, args) {
  const route = await ensureRoute();
  const repo = route.defaultRepo;
  switch (name) {
    case "memory_recall": {
      const items = await recall(route, repo, String(args.query || "").trim(), Number(args.limit || resolveMemoryRecallLimit()));
      if (items.length === 0) return textResult(`No active memories matched in ${repo}.`);
      return textResult(items.map(formatMemory).join("\n\n"));
    }
    case "memory_list": {
      const statusAlias = args.status === "active"
        ? "open"
        : args.status === "stale"
          ? "closed"
          : args.status === "all"
            ? "all"
            : null;
      const labels = ["type:memory"];
      if (args.kind) labels.push(`kind:${String(args.kind).trim()}`);
      if (args.topic) labels.push(`topic:${String(args.topic).trim()}`);
      const issues = await github.listIssues(route, repo, {
        state: statusAlias || args.state || "open",
        labels,
        perPage: Number(args.limit || 20)
      });
      const items = (issues || []).map(summarizeMemory);
      if (items.length === 0) return textResult(`No memories found in ${repo}.`);
      return textResult(items.map(formatMemory).join("\n\n"));
    }
    case "memory_get": {
      let issue = null;
      if (args.memoryId) {
        issue = await github.getIssue(route, repo, Number(args.memoryId), true);
      }
      if (!issue && args.ref) {
        const state = args.status === "active" ? "open" : args.status === "stale" ? "closed" : args.status === "all" ? "all" : "open";
        issue = await github.findMemoryByRef(route, repo, String(args.ref), state);
      }
      if (!issue) {
        const ref = args.memoryId ? `#${args.memoryId}` : args.ref ? `"${args.ref}"` : "(no id)";
        return textResult(`Memory ${ref} not found in ${repo}.`);
      }
      return textResult(formatMemory(summarizeMemory(issue)));
    }
    case "memory_store": {
      const stored = await github.storeMemory(route, repo, args);
      const summary = summarizeMemory(stored.issue);
      return textResult(
        stored.created
          ? `Stored memory in ${repo}.\n\n${formatMemory(summary)}`
          : `Memory already exists in ${repo}.\n\n${formatMemory(summary)}`
      );
    }
    case "memory_update": {
      const updated = await github.updateMemory(route, repo, Number(args.memoryId), args);
      if (!updated) return textResult(`Memory #${args.memoryId} not found in ${repo}.`);
      return textResult(`Updated memory in ${repo}.\n\n${formatMemory(summarizeMemory(updated))}`);
    }
    case "memory_forget": {
      const forgotten = await github.forgetMemory(route, repo, Number(args.memoryId));
      return textResult(`Closed memory in ${repo}.\n\n${formatMemory(summarizeMemory(forgotten))}`);
    }
    case "memory_labels": {
      const schema = await github.listSchema(route, repo);
      const lines = [
        `Schema for ${repo}:`,
        `kinds (${schema.kinds.length}): ${schema.kinds.length > 0 ? schema.kinds.join(", ") : "(none)"}`,
        `topics (${schema.topics.length}): ${schema.topics.length > 0 ? schema.topics.join(", ") : "(none)"}`
      ];
      return textResult(lines.join("\n"));
    }
    case "memory_repos": {
      const repos = await github.listUserRepos(route);
      if (!repos || repos.length === 0) return textResult("No accessible repos found for the current agent.");
      const lines = repos.map((r) => {
        const full = r.full_name || (r.owner && r.owner.login ? `${r.owner.login}/${r.name}` : r.name || "");
        const marks = [];
        if (full === repo) marks.push("default");
        if (r.private) marks.push("private");
        const tag = marks.length > 0 ? ` [${marks.join(", ")}]` : "";
        const desc = r.description ? ` — ${r.description}` : "";
        return `- ${full}${tag}${desc}`;
      });
      return textResult(lines.join("\n"));
    }
    case "memory_repo_create": {
      const name = String(args.name || "").trim();
      if (!name) throw new Error("name is required");
      const org = args.org ? String(args.org).trim() : "";
      const created = org
        ? await github.createOrgRepo(route, org, {
            name,
            description: args.description,
            private: args.private,
            autoInit: args.autoInit
          })
        : await github.createUserRepo(route, {
            name,
            description: args.description,
            private: args.private,
            autoInit: args.autoInit
          });
      const fullName = created.full_name || (created.owner && created.owner.login ? `${created.owner.login}/${created.name}` : name);
      let note = "";
      if (args.setDefault) {
        mutateState((state) => {
          if (state.route) state.route.defaultRepo = fullName;
          return state;
        });
        note = `\nDefault repo updated to ${fullName} for this plugin install.`;
      }
      return textResult(`Created repo ${fullName}${created.private ? " (private)" : ""}.${note}`);
    }
    case "memory_repo_set_default": {
      const repoArg = String(args.repo || "").trim();
      if (!/^[^/\s]+\/[^/\s]+$/.test(repoArg)) throw new Error("repo must look like owner/name");
      mutateState((state) => {
        if (!state.route) state.route = {};
        state.route.defaultRepo = repoArg;
        return state;
      });
      return textResult(`Default repo set to ${repoArg} for this plugin install. Previous default was ${repo}.`);
    }
    case "issue_create": {
      const targetRepo = resolveTargetRepo(route, args);
      const title = String(args.title || "").trim();
      if (!title) throw new Error("title is required");
      const payload = { title };
      if (typeof args.body === "string") payload.body = args.body;
      if (Array.isArray(args.labels) && args.labels.length > 0) payload.labels = args.labels;
      if (Array.isArray(args.assignees) && args.assignees.length > 0) payload.assignees = args.assignees;
      if (args.state) payload.state = args.state;
      if (args.stateReason) payload.state_reason = args.stateReason;
      const issue = await github.createIssue(route, targetRepo, payload);
      return textResult(`Created issue in ${targetRepo}.\n\n${formatIssue(issue)}`);
    }
    case "issue_list": {
      const targetRepo = resolveTargetRepo(route, args);
      const issues = await github.listIssues(route, targetRepo, {
        state: args.state || "open",
        labels: Array.isArray(args.labels) ? args.labels : undefined,
        assignee: args.assignee,
        creator: args.creator,
        mentioned: args.mentioned,
        sort: args.sort,
        direction: args.direction,
        since: args.since,
        perPage: Number(args.limit || 20)
      });
      if (!issues || issues.length === 0) return textResult(`No issues found in ${targetRepo}.`);
      return textResult(issues.map(formatIssue).join("\n\n"));
    }
    case "issue_get": {
      const targetRepo = resolveTargetRepo(route, args);
      const issue = await github.getIssue(route, targetRepo, Number(args.issueNumber), true);
      if (!issue) return textResult(`Issue #${args.issueNumber} not found in ${targetRepo}.`);
      return textResult(`Repo: ${targetRepo}\n${formatIssue(issue)}`);
    }
    case "issue_update": {
      const targetRepo = resolveTargetRepo(route, args);
      const payload = {};
      if (typeof args.title === "string" && args.title.trim()) payload.title = args.title.trim();
      if (typeof args.body === "string") payload.body = args.body;
      if (args.state) payload.state = args.state;
      if (args.stateReason) payload.state_reason = args.stateReason;
      if (Array.isArray(args.labels)) payload.labels = args.labels;
      if (Array.isArray(args.assignees)) payload.assignees = args.assignees;
      if (typeof args.locked === "boolean") payload.locked = args.locked;
      const issue = await github.updateIssue(route, targetRepo, Number(args.issueNumber), payload);
      return textResult(`Updated issue in ${targetRepo}.\n\n${formatIssue(issue)}`);
    }
    case "issue_comment_add": {
      const targetRepo = resolveTargetRepo(route, args);
      const body = String(args.body || "").trim();
      if (!body) throw new Error("body is required");
      const replyTo = typeof args.replyToCommentId === "number" ? args.replyToCommentId : undefined;
      const comment = await github.createComment(
        route,
        targetRepo,
        Number(args.issueNumber),
        body,
        replyTo ? { inReplyTo: replyTo } : {}
      );
      return textResult(`Added comment to issue #${args.issueNumber} in ${targetRepo}.\n\n${formatComment(comment)}`);
    }
    case "issue_comments_list": {
      const targetRepo = resolveTargetRepo(route, args);
      const comments = await github.listComments(route, targetRepo, Number(args.issueNumber), {
        sort: args.sort,
        direction: args.direction,
        since: args.since,
        threaded: args.threaded,
        perPage: Number(args.limit || 20)
      });
      if (!comments || comments.length === 0) {
        return textResult(`No comments found for issue #${args.issueNumber} in ${targetRepo}.`);
      }
      return textResult([
        `Found ${comments.length} comment${comments.length === 1 ? "" : "s"} on issue #${args.issueNumber} in ${targetRepo}:`,
        ...comments.map(formatComment)
      ].join("\n\n"));
    }
    case "collaboration_org_invitation_create": {
      const org = String(args.org || "").trim();
      const inviteeLogin = String(args.inviteeLogin || "").trim();
      if (!org || !inviteeLogin) throw new Error("org and inviteeLogin are required");
      const roleResult = collab.resolveOrgInvitationRole(args.role, "member");
      if ("error" in roleResult) throw new Error(roleResult.error);
      const teamIds = Array.isArray(args.teamIds)
        ? args.teamIds.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)
        : [];
      const gate = requireMutationConfirmation(
        args,
        `invite ${inviteeLogin} to ${org}${teamIds.length > 0 ? ` (teams=${teamIds.join(",")})` : ""} as ${roleResult.role}`
      );
      if (gate) return gate;
      const invitation = await github.createOrgInvitation(route, org, {
        inviteeLogin,
        role: roleResult.role,
        teamIds,
        expiresInDays: typeof args.expiresInDays === "number" ? args.expiresInDays : undefined
      });
      return textResult(
        [
          `Invited ${inviteeLogin} to ${org} as ${roleResult.role}${teamIds.length > 0 ? ` (teams=${teamIds.join(",")})` : ""}.`,
          collab.renderOrgInvitationLine(invitation)
        ].join("\n")
      );
    }
    case "collaboration_team_membership_set": {
      const org = String(args.org || "").trim();
      const teamSlug = String(args.teamSlug || "").trim();
      const username = String(args.username || "").trim();
      if (!org || !teamSlug || !username) throw new Error("org, teamSlug, and username are required");
      const roleResult = collab.resolveTeamRole(args.role);
      if ("error" in roleResult) throw new Error(roleResult.error);
      const gate = requireMutationConfirmation(
        args,
        `set ${username} as ${roleResult.role} of ${org}/${teamSlug}`
      );
      if (gate) return gate;
      const membership = await github.setTeamMembership(route, org, teamSlug, username, roleResult.role);
      const state = (membership && membership.state) || "updated";
      return textResult(`Set ${username} as ${roleResult.role} of team ${org}/${teamSlug} (state=${state}).`);
    }
    case "collaboration_user_repo_invitations": {
      const invitations = await github.listUserRepoInvitations(route);
      if (!invitations || invitations.length === 0) return textResult("No pending repository invitations for the current agent.");
      const lines = invitations.map((inv) => {
        const repo = inv && inv.repository && (inv.repository.full_name || inv.repository.name);
        return `- ${collab.renderRepoInvitationLine(inv)}${repo ? ` on ${repo}` : ""}`;
      });
      return textResult([`${invitations.length} pending repository invitation(s):`, ...lines].join("\n"));
    }
    case "collaboration_user_repo_invitation_accept": {
      const invitationId = Number(args.invitationId);
      if (!Number.isInteger(invitationId) || invitationId <= 0) throw new Error("invitationId must be a positive integer");
      const gate = requireMutationConfirmation(args, `accept repository invitation #${invitationId}`);
      if (gate) return gate;
      await github.acceptUserRepoInvitation(route, invitationId);
      return textResult(`Accepted repository invitation #${invitationId}.`);
    }
    case "collaboration_user_repo_invitation_decline": {
      const invitationId = Number(args.invitationId);
      if (!Number.isInteger(invitationId) || invitationId <= 0) throw new Error("invitationId must be a positive integer");
      const gate = requireMutationConfirmation(args, `decline repository invitation #${invitationId}`);
      if (gate) return gate;
      await github.declineUserRepoInvitation(route, invitationId);
      return textResult(`Declined repository invitation #${invitationId}.`);
    }
    case "collaboration_user_org_invitations": {
      const invitations = await github.listUserOrgInvitations(route);
      if (!invitations || invitations.length === 0) return textResult("No pending organization invitations for the current agent.");
      const lines = invitations.map((inv) => `- ${collab.renderOrgInvitationLine(inv)}`);
      return textResult([`${invitations.length} pending organization invitation(s):`, ...lines].join("\n"));
    }
    case "collaboration_user_org_invitation_accept": {
      const invitationId = Number(args.invitationId);
      if (!Number.isInteger(invitationId) || invitationId <= 0) throw new Error("invitationId must be a positive integer");
      const gate = requireMutationConfirmation(args, `accept organization invitation #${invitationId}`);
      if (gate) return gate;
      await github.acceptUserOrgInvitation(route, invitationId);
      return textResult(`Accepted organization invitation #${invitationId}.`);
    }
    case "collaboration_user_org_invitation_decline": {
      const invitationId = Number(args.invitationId);
      if (!Number.isInteger(invitationId) || invitationId <= 0) throw new Error("invitationId must be a positive integer");
      const gate = requireMutationConfirmation(args, `decline organization invitation #${invitationId}`);
      if (gate) return gate;
      await github.declineUserOrgInvitation(route, invitationId);
      return textResult(`Declined organization invitation #${invitationId}.`);
    }
    case "collaboration_teams": {
      const org = String(args.org || "").trim();
      if (!org) throw new Error("org is required");
      const teams = await github.listOrgTeams(route, org);
      if (!teams || teams.length === 0) return textResult(`No teams found in ${org}.`);
      return textResult([`Teams in ${org}:`, ...teams.map((t) => `- ${collab.renderTeamLine(t)}`)].join("\n"));
    }
    case "collaboration_team": {
      const org = String(args.org || "").trim();
      const teamSlug = String(args.teamSlug || "").trim();
      if (!org || !teamSlug) throw new Error("org and teamSlug are required");
      const team = await github.getTeam(route, org, teamSlug);
      if (!team) return textResult(`Team ${org}/${teamSlug} not found.`);
      const lines = [
        `Team ${org}/${team.slug || team.name}`,
        team.name ? `- name: ${team.name}` : "",
        team.description ? `- description: ${team.description}` : "",
        team.privacy ? `- privacy: ${team.privacy}` : "",
        team.permission ? `- permission: ${team.permission}` : ""
      ].filter(Boolean);
      return textResult(lines.join("\n"));
    }
    case "collaboration_team_members": {
      const org = String(args.org || "").trim();
      const teamSlug = String(args.teamSlug || "").trim();
      if (!org || !teamSlug) throw new Error("org and teamSlug are required");
      const members = await github.listTeamMembers(route, org, teamSlug);
      if (!members || members.length === 0) return textResult(`No members in ${org}/${teamSlug}.`);
      return textResult([`Members of ${org}/${teamSlug}:`, ...members.map((m) => `- ${collab.renderCollaboratorLine(m)}`)].join("\n"));
    }
    case "collaboration_team_repos": {
      const org = String(args.org || "").trim();
      const teamSlug = String(args.teamSlug || "").trim();
      if (!org || !teamSlug) throw new Error("org and teamSlug are required");
      const repos = await github.listTeamRepos(route, org, teamSlug);
      if (!repos || repos.length === 0) return textResult(`Team ${org}/${teamSlug} has no repo grants.`);
      const lines = repos.map((r) => {
        const full = collab.repoSummaryFullName(r) || r.name || "(unknown)";
        const perms = r.permissions ? Object.entries(r.permissions).filter(([, v]) => v).map(([k]) => k).join(",") : "";
        const role = r.role_name || perms;
        return `- ${full}${role ? ` (${role})` : ""}`;
      });
      return textResult([`Repos visible to ${org}/${teamSlug}:`, ...lines].join("\n"));
    }
    case "collaboration_team_repo_set": {
      const org = String(args.org || "").trim();
      const teamSlug = String(args.teamSlug || "").trim();
      const full = String(args.repo || "").trim();
      const permission = String(args.permission || "").trim();
      if (!org || !teamSlug || !full || !permission) throw new Error("org, teamSlug, repo, and permission are required");
      const { owner, repo: repoName } = splitOwnerRepo(full);
      if (!owner || !repoName) throw new Error("repo must look like owner/name");
      const gate = requireMutationConfirmation(
        args,
        `grant ${org}/${teamSlug} ${permission} access to ${full}`
      );
      if (gate) return gate;
      await github.setTeamRepoAccess(route, org, teamSlug, owner, repoName, permission);
      return textResult(`Granted ${org}/${teamSlug} ${permission} access to ${full}.`);
    }
    case "collaboration_team_repo_remove": {
      const org = String(args.org || "").trim();
      const teamSlug = String(args.teamSlug || "").trim();
      const full = String(args.repo || "").trim();
      if (!org || !teamSlug || !full) throw new Error("org, teamSlug, and repo are required");
      const { owner, repo: repoName } = splitOwnerRepo(full);
      if (!owner || !repoName) throw new Error("repo must look like owner/name");
      const gate = requireMutationConfirmation(args, `remove ${org}/${teamSlug} access from ${full}`);
      if (gate) return gate;
      await github.removeTeamRepoAccess(route, org, teamSlug, owner, repoName);
      return textResult(`Removed ${org}/${teamSlug} access from ${full}.`);
    }
    case "collaboration_team_membership_remove": {
      const org = String(args.org || "").trim();
      const teamSlug = String(args.teamSlug || "").trim();
      const username = String(args.username || "").trim();
      if (!org || !teamSlug || !username) throw new Error("org, teamSlug, and username are required");
      const gate = requireMutationConfirmation(args, `remove ${username} from ${org}/${teamSlug}`);
      if (gate) return gate;
      await github.removeTeamMembership(route, org, teamSlug, username);
      return textResult(`Removed ${username} from ${org}/${teamSlug}.`);
    }
    case "collaboration_repo_collaborators": {
      const targetFull = resolveTargetRepo(route, args);
      const { owner, repo: repoName } = splitOwnerRepo(targetFull);
      if (!owner || !repoName) throw new Error("repo must look like owner/name");
      const collaborators = collab.filterDirectCollaborators(
        await github.listRepoCollaborators(route, owner, repoName),
        owner
      );
      if (collaborators.length === 0) return textResult(`No direct collaborators on ${targetFull}.`);
      return textResult([`Collaborators on ${targetFull}:`, ...collaborators.map((c) => `- ${collab.renderCollaboratorLine(c)}`)].join("\n"));
    }
    case "collaboration_repo_invitations": {
      const targetFull = resolveTargetRepo(route, args);
      const { owner, repo: repoName } = splitOwnerRepo(targetFull);
      if (!owner || !repoName) throw new Error("repo must look like owner/name");
      const invitations = await github.listRepoInvitations(route, owner, repoName);
      if (!invitations || invitations.length === 0) return textResult(`No pending invitations for ${targetFull}.`);
      return textResult([`Pending invitations for ${targetFull}:`, ...invitations.map((inv) => `- ${collab.renderRepoInvitationLine(inv)}`)].join("\n"));
    }
    case "collaboration_repo_collaborator_set": {
      const targetFull = resolveTargetRepo(route, args);
      const { owner, repo: repoName } = splitOwnerRepo(targetFull);
      if (!owner || !repoName) throw new Error("repo must look like owner/name");
      const username = String(args.username || "").trim();
      const permission = String(args.permission || "").trim();
      if (!username || !permission) throw new Error("username and permission are required");
      const gate = requireMutationConfirmation(args, `grant ${username} ${permission} access to ${targetFull}`);
      if (gate) return gate;
      const result = await github.setRepoCollaborator(route, owner, repoName, username, permission);
      const note = result && result.id
        ? `Invitation #${result.id} created for ${username} on ${targetFull} (${permission}).`
        : `Granted ${username} ${permission} access to ${targetFull}.`;
      return textResult(note);
    }
    case "collaboration_repo_collaborator_remove": {
      const targetFull = resolveTargetRepo(route, args);
      const { owner, repo: repoName } = splitOwnerRepo(targetFull);
      if (!owner || !repoName) throw new Error("repo must look like owner/name");
      const username = String(args.username || "").trim();
      if (!username) throw new Error("username is required");
      const gate = requireMutationConfirmation(args, `remove ${username} from ${targetFull}`);
      if (gate) return gate;
      await github.removeRepoCollaborator(route, owner, repoName, username);
      return textResult(`Removed ${username} from ${targetFull}.`);
    }
    case "collaboration_admin_invoke": {
      const action = String(args.action || "").trim();
      const p = (args.params && typeof args.params === "object") ? args.params : {};
      const mustConfirm = (desc) => requireMutationConfirmation(args, desc);

      switch (action) {
        case "team_create": {
          const org = String(p.org || "").trim();
          const name = String(p.name || "").trim();
          if (!org || !name) throw new Error("params.org and params.name are required");
          const gate = mustConfirm(`create team ${name} in ${org}`);
          if (gate) return gate;
          const team = await github.createOrgTeam(route, org, {
            name,
            description: p.description,
            privacy: p.privacy
          });
          return textResult(`Created team ${org}/${team.slug || name}.`);
        }
        case "team_update": {
          const org = String(p.org || "").trim();
          const slug = String(p.teamSlug || "").trim();
          if (!org || !slug) throw new Error("params.org and params.teamSlug are required");
          const gate = mustConfirm(`update team ${org}/${slug}`);
          if (gate) return gate;
          const team = await github.updateTeam(route, org, slug, {
            name: p.name,
            description: p.description,
            privacy: p.privacy
          });
          return textResult(`Updated team ${org}/${team.slug || slug}.`);
        }
        case "team_delete": {
          const org = String(p.org || "").trim();
          const slug = String(p.teamSlug || "").trim();
          if (!org || !slug) throw new Error("params.org and params.teamSlug are required");
          const gate = mustConfirm(`delete team ${org}/${slug}`);
          if (gate) return gate;
          await github.deleteTeam(route, org, slug);
          return textResult(`Deleted team ${org}/${slug}.`);
        }
        case "org_invitations_list": {
          const org = String(p.org || "").trim();
          if (!org) throw new Error("params.org is required");
          const invitations = await github.listOrgInvitations(route, org);
          if (!invitations || invitations.length === 0) return textResult(`No pending invitations for ${org}.`);
          return textResult([`Pending invitations for ${org}:`, ...invitations.map((inv) => `- ${collab.renderOrgInvitationLine(inv)}`)].join("\n"));
        }
        case "org_invitation_revoke": {
          const org = String(p.org || "").trim();
          const invitationId = Number(p.invitationId);
          if (!org || !Number.isInteger(invitationId) || invitationId <= 0) throw new Error("params.org and params.invitationId are required");
          const gate = mustConfirm(`revoke invitation #${invitationId} from ${org}`);
          if (gate) return gate;
          await github.revokeOrgInvitation(route, org, invitationId);
          return textResult(`Revoked invitation #${invitationId} from ${org}.`);
        }
        case "org_members_list": {
          const org = String(p.org || "").trim();
          if (!org) throw new Error("params.org is required");
          const roleFilter = p.role === "admin" ? "admin" : undefined;
          const members = await github.listOrgMembers(route, org, roleFilter);
          if (!members || members.length === 0) return textResult(`No members found for ${org}${roleFilter ? ` (role=${roleFilter})` : ""}.`);
          return textResult([`Members of ${org}${roleFilter ? ` (role=${roleFilter})` : ""}:`, ...members.map((m) => `- ${collab.renderCollaboratorLine(m)}`)].join("\n"));
        }
        case "org_member_remove": {
          const org = String(p.org || "").trim();
          const username = String(p.username || "").trim();
          if (!org || !username) throw new Error("params.org and params.username are required");
          const gate = mustConfirm(`remove ${username} from ${org} (hard)`);
          if (gate) return gate;
          await github.removeOrgMember(route, org, username);
          return textResult(`Removed ${username} from ${org}.`);
        }
        case "org_membership_remove": {
          const org = String(p.org || "").trim();
          const username = String(p.username || "").trim();
          if (!org || !username) throw new Error("params.org and params.username are required");
          const gate = mustConfirm(`remove ${username}'s membership state in ${org}`);
          if (gate) return gate;
          await github.removeOrgMembership(route, org, username);
          return textResult(`Cleared ${username}'s membership state in ${org}.`);
        }
        case "org_outside_collaborators_list": {
          const org = String(p.org || "").trim();
          if (!org) throw new Error("params.org is required");
          const outside = await github.listOrgOutsideCollaborators(route, org);
          if (!outside || outside.length === 0) return textResult(`No outside collaborators in ${org}.`);
          return textResult([`Outside collaborators in ${org}:`, ...outside.map((u) => `- ${collab.renderCollaboratorLine(u)}`)].join("\n"));
        }
        case "repo_transfer": {
          const full = String(p.repo || "").trim();
          const newOwner = String(p.newOwner || "").trim();
          if (!full || !newOwner) throw new Error("params.repo and params.newOwner are required");
          const { owner, repo: repoName } = splitOwnerRepo(full);
          if (!owner || !repoName) throw new Error("params.repo must look like owner/name");
          const gate = mustConfirm(`transfer ${full} to ${newOwner}${p.newRepoName ? ` as ${p.newRepoName}` : ""}`);
          if (gate) return gate;
          const result = await github.transferRepo(route, owner, repoName, newOwner, p.newRepoName);
          const newFull = collab.repoSummaryFullName(result) || `${newOwner}/${p.newRepoName || repoName}`;
          return textResult(`Transferred ${full} to ${newFull}.`);
        }
        case "repo_rename": {
          const full = String(p.repo || "").trim();
          const newName = String(p.newName || "").trim();
          if (!full || !newName) throw new Error("params.repo and params.newName are required");
          const { owner, repo: repoName } = splitOwnerRepo(full);
          if (!owner || !repoName) throw new Error("params.repo must look like owner/name");
          const gate = mustConfirm(`rename ${full} to ${owner}/${newName}`);
          if (gate) return gate;
          await github.renameRepo(route, owner, repoName, newName);
          return textResult(`Renamed ${full} to ${owner}/${newName}.`);
        }
        default:
          throw new Error(`Unknown collaboration_admin_invoke action: ${action}`);
      }
    }
    case "collaboration_repo_access_inspect": {
      const targetFull = resolveTargetRepo(route, args);
      const { owner, repo: repoName } = splitOwnerRepo(targetFull);
      if (!owner || !repoName) throw new Error("repo must look like owner/name");
      const username = typeof args.username === "string" ? args.username.trim() : "";
      const lines = [`Repo access inspection for ${targetFull}:`];
      const notes = [];
      let orgName = owner;
      let orgDefaultPermission;
      let orgContextAvailable = false;

      try {
        const r = await github.getRepo(route, owner, repoName);
        if (r) {
          lines.push(`- Visibility: ${r.private ? "private" : "shared/public"}`);
          if (r.description && String(r.description).trim()) lines.push(`- Description: ${String(r.description).trim()}`);
          if (r.owner && r.owner.login) orgName = String(r.owner.login).trim() || owner;
        } else {
          notes.push(`Repo metadata unavailable: not found`);
        }
      } catch (error) {
        notes.push(`Repo metadata unavailable: ${String(error)}`);
      }

      try {
        const org = await github.getOrg(route, orgName);
        if (org) {
          orgContextAvailable = true;
          orgDefaultPermission = collab.normalizePermissionAlias(org.default_repository_permission);
          lines.push(`- Org default repository permission: ${orgDefaultPermission || "unknown"}`);
        }
      } catch (error) {
        notes.push(`Org metadata unavailable for "${orgName}": ${String(error)}`);
      }

      if (username) {
        lines.push("", `Org membership for "${username}" in "${orgName}":`);
        if (!orgContextAvailable) {
          lines.push("- Not applicable because the owner org could not be resolved.");
        } else {
          try {
            const membership = await github.getOrgMembership(route, orgName, username);
            if (!membership) {
              lines.push("- No active or pending org membership was found.");
              if (orgDefaultPermission && orgDefaultPermission !== "none") {
                lines.push("- Org base repo access does not apply unless the user becomes an org member.");
              }
            } else {
              lines.push(`- ${collab.renderOrgMembershipLine(membership)}`);
              if (membership.state === "active") {
                if (orgDefaultPermission && orgDefaultPermission !== "none") {
                  lines.push(`- Org base repo access is active via default permission "${orgDefaultPermission}".`);
                  notes.push(`Because ${username} is an active org member and "${orgName}" default repository permission is ${orgDefaultPermission}, removing direct collaborators or team grants alone may not remove repo access.`);
                } else {
                  lines.push("- No org base repo access is visible because the org default permission is none.");
                }
              } else {
                lines.push("- Org base repo access is not active yet because the org membership is still pending.");
              }
            }
          } catch (error) {
            notes.push(`Org membership lookup failed for "${username}" in "${orgName}": ${String(error)}`);
          }
        }
      } else if (orgDefaultPermission && orgDefaultPermission !== "none") {
        notes.push(`Any active org member can still inherit ${orgDefaultPermission} access from "${orgName}" even after direct collaborator or team grants are removed.`);
      }

      try {
        const collaborators = collab.filterDirectCollaborators(await github.listRepoCollaborators(route, owner, repoName), owner);
        lines.push("", "Explicit collaborators (excluding owner):");
        if (collaborators.length === 0) lines.push("- None visible");
        else lines.push(...collaborators.map((c) => `- ${collab.renderCollaboratorLine(c)}`));
      } catch (error) {
        notes.push(`Direct collaborator lookup failed: ${String(error)}`);
      }

      try {
        const invitations = await github.listRepoInvitations(route, owner, repoName);
        lines.push("", "Pending repository invitations:");
        if (invitations.length === 0) lines.push("- None visible");
        else lines.push(...invitations.map((inv) => `- ${collab.renderRepoInvitationLine(inv)}`));
      } catch (error) {
        notes.push(`Repo invitation lookup failed: ${String(error)}`);
      }

      if (orgContextAvailable) {
        try {
          const teamAccess = await collab.listRepoAccessTeams(github, route, orgName, targetFull);
          lines.push("", "Teams with repo access:");
          if (teamAccess.teams.length === 0) lines.push("- None visible");
          else lines.push(...teamAccess.teams.map((t) => `- ${collab.renderTeamLine(t)}`));
          notes.push(...teamAccess.notes);
        } catch (error) {
          notes.push(`Repo team grant lookup failed: ${String(error)}`);
        }

        try {
          const outside = await github.listOrgOutsideCollaborators(route, orgName);
          lines.push("", `Outside collaborators in owner org "${orgName}":`);
          if (outside.length === 0) lines.push("- None visible");
          else lines.push(...outside.map((u) => `- ${collab.renderCollaboratorLine(u)}`));
        } catch (error) {
          notes.push(`Outside collaborator lookup failed: ${String(error)}`);
        }
      }

      if (notes.length > 0) {
        lines.push("", "Notes:");
        lines.push(...notes.map((n) => `- ${n}`));
      }
      return textResult(lines.join("\n"));
    }
    case "memory_console": {
      const url = buildConsoleUrl(route, {
        repo,
        query: args && typeof args.query === "string" ? args.query : "",
        includeToken: Boolean(args && args.includeToken)
      });
      const lines = [
        `Open ${url} to browse your memories for ${repo}.`,
        args && args.includeToken
          ? "This URL includes a one-click login token — do not share it."
          : "The console will require sign-in unless includeToken was set."
      ];
      return textResult(lines.join("\n"));
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function dispatch(message) {
  if (!message || typeof message !== "object") return;
  if (!message.id && message.method === "notifications/initialized") return;
  if (!message.id && message.method === "notifications/cancelled") return;

  try {
    if (message.method === "initialize") {
      return encodeMessage({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params && message.params.protocolVersion ? message.params.protocolVersion : "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: {
            name: "clawmem",
            version: "0.1.0"
          }
        }
      });
    }
    if (message.method === "ping") {
      return encodeMessage({ jsonrpc: "2.0", id: message.id, result: {} });
    }
    if (message.method === "tools/list") {
      return encodeMessage({
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: TOOL_DEFS }
      });
    }
    if (message.method === "tools/call") {
      const params = message.params || {};
      const result = await handleToolCall(params.name, params.arguments || {});
      appendEvent({
        source: "mcp",
        type: "tool_call",
        tool: params.name,
        args: params.arguments || {}
      });
      return encodeMessage({ jsonrpc: "2.0", id: message.id, result });
    }
    if (message.id) {
      return encodeMessage({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32601,
          message: `Unsupported method: ${message.method}`
        }
      });
    }
  } catch (error) {
    appendEvent({
      source: "mcp",
      type: "error",
      message: String(error)
    });
    if (message.id) {
      encodeMessage({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: String(error)
        }
      });
    }
  }
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    if (useLspFraming || /^Content-Length:/i.test(buffer.toString("utf8", 0, Math.min(buffer.length, 32)))) {
      useLspFraming = true;
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const headerText = buffer.slice(0, headerEnd).toString("utf8");
      const match = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buffer = Buffer.alloc(0);
        return;
      }
      const contentLength = Number(match[1]);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;
      if (buffer.length < messageEnd) return;
      const body = buffer.slice(messageStart, messageEnd).toString("utf8");
      buffer = buffer.slice(messageEnd);
      try { dispatch(JSON.parse(body)); } catch {}
      continue;
    }
    const nlIndex = buffer.indexOf(0x0a);
    if (nlIndex === -1) return;
    const line = buffer.slice(0, nlIndex).toString("utf8").trim();
    buffer = buffer.slice(nlIndex + 1);
    if (!line) continue;
    try { dispatch(JSON.parse(line)); } catch {}
  }
});

process.stdin.on("end", () => process.exit(0));
appendEvent({
  source: "mcp",
  type: "server_start",
  connected: Boolean(loadState().route)
});
