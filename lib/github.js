const { clip, nowIso, sha256, slugify, todayIsoDate, yamlBlock } = require("./util");

function authHeader(route) {
  if (!route || !route.token) return {};
  const scheme = route.authScheme === "bearer" ? "Bearer" : "token";
  return { Authorization: `${scheme} ${route.token}` };
}

async function request(route, pathname, init = {}, opts = {}) {
  const baseUrl = route && route.baseUrl ? route.baseUrl : opts.baseUrl;
  if (!baseUrl) throw new Error("ClawMem base URL is not configured");
  const url = new URL(pathname, `${baseUrl.replace(/\/+$/, "")}/`);
  const headers = {
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    ...(opts.omitAuth ? {} : authHeader(route)),
    ...(init.headers || {})
  };
  const response = await fetch(url, { ...init, headers });
  if (response.status === 404 && opts.allowNotFound) return null;
  if (response.status === 422 && opts.allowValidationError) return null;
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status}: ${body || response.statusText}`);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text.trim()) return null;
  return JSON.parse(text);
}

function isAgentsEndpointUnavailable(error) {
  const msg = String(error && error.message || error);
  return /HTTP (404|405|501):/i.test(msg);
}

async function createAnonymousSession({ baseUrl, locale }) {
  const body = locale ? JSON.stringify({ locale }) : undefined;
  return request(
    null,
    "anonymous/session",
    {
      method: "POST",
      ...(body ? { body } : {})
    },
    { baseUrl, omitAuth: true }
  );
}

async function registerAgent({ baseUrl, prefixLogin, defaultRepoName }) {
  try {
    const res = await request(
      null,
      "agents",
      {
        method: "POST",
        body: JSON.stringify({
          prefix_login: prefixLogin,
          default_repo_name: defaultRepoName
        })
      },
      { baseUrl, omitAuth: true }
    );
    return {
      baseUrl,
      authScheme: "token",
      login: res.login,
      token: res.token,
      defaultRepo: res.repo_full_name,
      bootstrapMethod: "/api/v3/agents"
    };
  } catch (error) {
    if (!isAgentsEndpointUnavailable(error)) throw error;
    const locale = (typeof Intl !== "undefined" && Intl.DateTimeFormat)
      ? Intl.DateTimeFormat().resolvedOptions().locale || ""
      : "";
    const res = await createAnonymousSession({ baseUrl, locale });
    return {
      baseUrl,
      authScheme: "token",
      login: res.login || res.owner_login,
      token: res.token,
      defaultRepo: res.repo_full_name || (res.owner_login && res.repo_name ? `${res.owner_login}/${res.repo_name}` : ""),
      bootstrapMethod: "/api/v3/anonymous/session"
    };
  }
}

function repoPath(repo, suffix) {
  return `repos/${repo}/${suffix}`;
}

async function ensureLabels(route, repo, labels) {
  for (const label of labels) {
    const name = String(label || "").trim();
    if (!name) continue;
    await request(
      route,
      repoPath(repo, "labels"),
      {
        method: "POST",
        body: JSON.stringify({
          name,
          color: "1d76db",
          description: name
        })
      },
      { allowValidationError: true }
    );
  }
}

async function createIssue(route, repo, params) {
  await ensureLabels(route, repo, params.labels || []);
  return request(route, repoPath(repo, "issues"), {
    method: "POST",
    body: JSON.stringify(params)
  });
}

async function updateIssue(route, repo, issueNumber, params) {
  if (params.labels && params.labels.length > 0) {
    await ensureLabels(route, repo, params.labels);
  }
  return request(route, repoPath(repo, `issues/${issueNumber}`), {
    method: "PATCH",
    body: JSON.stringify(params)
  });
}

async function getIssue(route, repo, issueNumber, allowNotFound = false) {
  return request(route, repoPath(repo, `issues/${issueNumber}`), { method: "GET" }, { allowNotFound });
}

async function createComment(route, repo, issueNumber, body, params = {}) {
  const payload = { body };
  if (typeof params.inReplyTo === "number") payload.in_reply_to = params.inReplyTo;
  return request(route, repoPath(repo, `issues/${issueNumber}/comments`), {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

async function listComments(route, repo, issueNumber, params = {}) {
  const query = new URLSearchParams();
  query.set("page", String(params.page || 1));
  query.set("per_page", String(params.perPage || 100));
  if (params.sort) query.set("sort", params.sort);
  if (params.direction) query.set("direction", params.direction);
  if (params.since) query.set("since", params.since);
  if (params.threaded) query.set("threaded", "true");
  const result = await request(route, `${repoPath(repo, `issues/${issueNumber}/comments`)}?${query}`, { method: "GET" });
  return Array.isArray(result) ? result : [];
}

async function addIssueLabels(route, repo, issueNumber, labels) {
  const filtered = (Array.isArray(labels) ? labels : [])
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  if (filtered.length === 0) return null;
  await ensureLabels(route, repo, filtered);
  return request(route, repoPath(repo, `issues/${issueNumber}/labels`), {
    method: "POST",
    body: JSON.stringify({ labels: filtered })
  });
}

async function listIssues(route, repo, params = {}) {
  const query = new URLSearchParams();
  query.set("state", params.state || "open");
  query.set("per_page", String(params.perPage || 100));
  if (params.page) query.set("page", String(params.page));
  if (params.labels && params.labels.length > 0) query.set("labels", params.labels.join(","));
  if (params.assignee) query.set("assignee", params.assignee);
  if (params.creator) query.set("creator", params.creator);
  if (params.mentioned) query.set("mentioned", params.mentioned);
  if (params.sort) query.set("sort", params.sort);
  if (params.direction) query.set("direction", params.direction);
  if (params.since) query.set("since", params.since);
  return request(route, `${repoPath(repo, "issues")}?${query}`, { method: "GET" });
}

async function searchIssues(route, query, params = {}) {
  const search = new URLSearchParams();
  search.set("q", query);
  search.set("per_page", String(params.perPage || 20));
  const result = await request(route, `search/issues?${search}`, { method: "GET" });
  return Array.isArray(result && result.items) ? result.items : [];
}

async function listUserRepos(route) {
  const result = await request(route, "user/repos", { method: "GET" });
  return Array.isArray(result) ? result : [];
}

async function createUserRepo(route, params) {
  return request(route, "user/repos", {
    method: "POST",
    body: JSON.stringify({
      name: params.name,
      ...(params.description ? { description: params.description } : {}),
      private: params.private !== undefined ? params.private : true,
      auto_init: params.autoInit !== undefined ? params.autoInit : false
    })
  });
}

async function createOrgRepo(route, org, params) {
  return request(route, `orgs/${encodeURIComponent(org)}/repos`, {
    method: "POST",
    body: JSON.stringify({
      name: params.name,
      ...(params.description ? { description: params.description } : {}),
      private: params.private !== undefined ? params.private : true,
      auto_init: params.autoInit !== undefined ? params.autoInit : false,
      ...(params.hasIssues !== undefined ? { has_issues: params.hasIssues } : {}),
      ...(params.hasWiki !== undefined ? { has_wiki: params.hasWiki } : {})
    })
  });
}

async function listUserOrgs(route) {
  const result = await request(route, "user/orgs", { method: "GET" });
  return Array.isArray(result) ? result : [];
}

async function createUserOrg(route, params) {
  return request(route, "user/orgs", {
    method: "POST",
    body: JSON.stringify({
      login: params.login,
      ...(params.name ? { name: params.name } : {}),
      ...(params.defaultRepositoryPermission
        ? { default_repository_permission: params.defaultRepositoryPermission }
        : {})
    })
  });
}

async function listLabels(route, repo, params = {}) {
  const query = new URLSearchParams();
  query.set("page", String(params.page || 1));
  query.set("per_page", String(params.perPage || 100));
  const result = await request(route, `${repoPath(repo, "labels")}?${query}`, { method: "GET" });
  return Array.isArray(result) ? result : [];
}

async function listSchema(route, repo) {
  const kinds = new Set();
  const topics = new Set();
  for (let page = 1; page <= 20; page += 1) {
    const batch = await listLabels(route, repo, { page, perPage: 100 });
    for (const label of batch) {
      const name = String((label && label.name) || "").trim();
      if (name.startsWith("kind:")) {
        const kind = name.slice(5).trim();
        if (kind) kinds.add(kind);
      }
      if (name.startsWith("topic:")) {
        const topic = name.slice(6).trim();
        if (topic) topics.add(topic);
      }
    }
    if (batch.length < 100) break;
  }
  return { kinds: [...kinds].sort(), topics: [...topics].sort() };
}

async function createEvent(route, payload) {
  return request(route, "clawmem/events", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

function memoryBody({ detail, hash, kind, topics }) {
  const lines = [
    "type: memory",
    `date: ${todayIsoDate()}`,
    `memory_hash: ${hash}`
  ];
  if (kind) lines.push(`kind: ${kind}`);
  if (topics && topics.length > 0) lines.push(`topics: ${topics.join(", ")}`);
  lines.push("detail: |-");
  const body = String(detail || "").replace(/\r\n/g, "\n");
  for (const line of body.split("\n")) {
    lines.push(`  ${line}`);
  }
  return `${lines.join("\n")}\n`;
}

const MANAGED_LABEL_PREFIXES = ["type:", "kind:", "session:", "date:", "topic:"];
const MANAGED_LABEL_EXACT = new Set([
  "status:active",
  "status:closed",
  "memory-status:active",
  "memory-status:stale"
]);

function extractLabelNames(labels) {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((entry) => {
      if (!entry) return "";
      if (typeof entry === "string") return entry.trim();
      if (typeof entry.name === "string") return entry.name.trim();
      return "";
    })
    .filter(Boolean);
}

function isManagedLabel(label) {
  const name = String(label || "").trim();
  if (!name) return false;
  if (MANAGED_LABEL_EXACT.has(name)) return true;
  return MANAGED_LABEL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

async function syncManagedLabels(route, repo, issueNumber, desired) {
  const issue = await getIssue(route, repo, issueNumber);
  if (!issue) return null;
  const unmanaged = extractLabelNames(issue.labels).filter((name) => !isManagedLabel(name));
  const merged = [...new Set([...unmanaged, ...desired.filter(Boolean)])];
  return updateIssue(route, repo, issueNumber, { labels: merged });
}

function conversationBody({ sessionId, openedAt, title, summary, lastActivity, date }) {
  const lines = [
    "type: conversation",
    `session_id: ${sessionId}`,
    "client: claude-code",
    "status: active",
    `opened_at: ${openedAt}`
  ];
  if (title) lines.push(`title: ${String(title).replace(/\n/g, " ").trim()}`);
  if (date) lines.push(`date: ${date}`);
  if (lastActivity) lines.push(`last_activity: ${lastActivity}`);
  if (summary) {
    lines.push("summary: |-");
    for (const line of String(summary).replace(/\r\n/g, "\n").split("\n")) {
      lines.push(`  ${line}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function parseConversationBody(body) {
  const text = String(body || "");
  const result = {};
  const simpleKeys = ["type", "session_id", "client", "status", "opened_at", "title", "date", "last_activity"];
  for (const key of simpleKeys) {
    const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    if (match) result[key] = match[1].trim();
  }
  const summaryMatch = text.match(/summary:\s*\|-\n([\s\S]*?)(?:\n[a-z_]+:|\n*$)/);
  if (summaryMatch) {
    result.summary = summaryMatch[1]
      .split("\n")
      .map((line) => line.replace(/^  /, ""))
      .join("\n")
      .trim();
  }
  return result;
}

function conversationComment(role, turnId, text) {
  return [
    `role: ${role}`,
    `turn: ${turnId}`,
    `ts: ${nowIso()}`,
    "---",
    String(text || "").trim()
  ].join("\n");
}

function issueLabels(issue) {
  return Array.isArray(issue && issue.labels)
    ? issue.labels.map((label) => (typeof label === "string" ? label : label && label.name ? label.name : "")).filter(Boolean)
    : [];
}

function issueState(issue) {
  return String((issue && issue.state) || "open").toLowerCase();
}

function issueDetail(issue) {
  const body = String((issue && issue.body) || "");
  const blockMatch = body.match(/detail:\s*\|-\n([\s\S]*)$/m);
  if (blockMatch) {
    return blockMatch[1]
      .split("\n")
      .map((line) => line.replace(/^  /, ""))
      .join("\n")
      .trim();
  }
  const inlineMatch = body.match(/detail:\s*(.+)$/m);
  if (inlineMatch) return inlineMatch[1].trim();
  return clip(body.replace(/\s+/g, " ").trim(), 240);
}

function kindLabel(kind) {
  const value = String(kind || "").trim();
  return value ? `kind:${slugify(value, "note")}` : "";
}

function topicLabels(topics) {
  return Array.isArray(topics)
    ? topics.map((topic) => `topic:${slugify(topic, "general")}`)
    : [];
}

function memoryLabelsFor(kind, topics) {
  const labels = ["type:memory"];
  const k = kindLabel(kind);
  if (k) labels.push(k);
  labels.push(...topicLabels(topics));
  return labels;
}

function topicsFromLabels(labels) {
  return labels
    .filter((name) => name.startsWith("topic:"))
    .map((name) => name.slice(6).trim())
    .filter(Boolean);
}

function kindFromLabels(labels) {
  const found = labels.find((name) => name.startsWith("kind:"));
  return found ? found.slice(5).trim() : "";
}

async function findActiveMemoryByHash(route, repo, hash) {
  const needle = String(hash || "").trim();
  if (!needle) return null;
  const items = await searchIssues(route, `"${needle}" repo:${repo} label:type:memory state:open`, { perPage: 10 });
  return (items || []).find((issue) => String(issue.body || "").includes(needle)) || null;
}

async function findMemoryByRef(route, repo, ref, state = "open") {
  const trimmed = String(ref || "").trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const issue = await getIssue(route, repo, Number(trimmed), true);
    if (issue) return issue;
  }
  const scope = state === "closed" ? "state:closed" : state === "all" ? "" : "state:open";
  const parts = [`"${trimmed}"`, `repo:${repo}`, "is:issue", "label:type:memory"];
  if (scope) parts.push(scope);
  const items = await searchIssues(route, parts.join(" "), { perPage: 10 });
  return items.find((issue) => String(issue.number) === trimmed || String(issue.body || "").includes(trimmed)) || null;
}

async function storeMemory(route, repo, params) {
  const detail = String(params.detail || "").trim();
  if (!detail) throw new Error("detail is required");
  const hash = sha256(detail);
  const existing = await findActiveMemoryByHash(route, repo, hash);
  if (existing) {
    const currentLabels = extractLabelNames(existing.labels);
    const mergedKind = params.kind ? slugify(params.kind, "note") : kindFromLabels(currentLabels);
    const mergedTopics = [
      ...topicsFromLabels(currentLabels),
      ...((params.topics || []).map((topic) => slugify(topic, "general")))
    ].filter(Boolean);
    const deduped = [...new Set(mergedTopics)];
    const nextLabels = memoryLabelsFor(mergedKind, deduped);
    const currentManaged = currentLabels.filter(isManagedLabel).sort();
    const desiredManaged = [...nextLabels].sort();
    if (JSON.stringify(currentManaged) !== JSON.stringify(desiredManaged)) {
      await ensureLabels(route, repo, nextLabels);
      await syncManagedLabels(route, repo, existing.number, nextLabels);
      const refreshed = await getIssue(route, repo, existing.number, true);
      return { created: false, issue: refreshed || existing };
    }
    return { created: false, issue: existing };
  }
  const title = clip(
    String(params.title || "").trim() || `Memory: ${detail}`,
    120
  );
  const kindSlug = params.kind ? slugify(params.kind, "note") : "";
  const topicSlugs = (params.topics || []).map((topic) => slugify(topic, "general")).filter(Boolean);
  const labels = memoryLabelsFor(kindSlug, topicSlugs);
  const issue = await createIssue(route, repo, {
    title,
    body: memoryBody({ detail, hash, kind: kindSlug, topics: topicSlugs }),
    labels
  });
  return { created: true, issue };
}

async function updateMemory(route, repo, memoryId, params) {
  const issueNumber = Number(memoryId);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new Error("memoryId must be a positive issue number");
  const current = await getIssue(route, repo, issueNumber, true);
  if (!current) return null;
  const nextDetail = params.detail ? String(params.detail).trim() : issueDetail(current);
  const hash = sha256(nextDetail);
  const duplicate = await findActiveMemoryByHash(route, repo, hash);
  if (duplicate && duplicate.number !== issueNumber) {
    throw new Error(`Another active memory already stores this detail as #${duplicate.number}`);
  }
  const nextTitle = params.title ? clip(params.title, 120) : current.title;
  const currentLabels = extractLabelNames(current.labels);
  const kindSlug = params.kind !== undefined
    ? (params.kind ? slugify(params.kind, "note") : "")
    : kindFromLabels(currentLabels);
  const topicSlugs = params.topics !== undefined
    ? (params.topics || []).map((topic) => slugify(topic, "general")).filter(Boolean)
    : topicsFromLabels(currentLabels);
  const labels = memoryLabelsFor(kindSlug, topicSlugs);
  await ensureLabels(route, repo, labels);
  await updateIssue(route, repo, issueNumber, {
    title: nextTitle,
    body: memoryBody({ detail: nextDetail, hash, kind: kindSlug, topics: topicSlugs })
  });
  await syncManagedLabels(route, repo, issueNumber, labels);
  return getIssue(route, repo, issueNumber, true);
}

async function getRepo(route, owner, repo) {
  return request(route, `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { method: "GET" }, { allowNotFound: true });
}

async function getOrg(route, org) {
  return request(route, `orgs/${encodeURIComponent(org)}`, { method: "GET" }, { allowNotFound: true });
}

async function getOrgMembership(route, org, username) {
  return request(
    route,
    `orgs/${encodeURIComponent(org)}/memberships/${encodeURIComponent(username)}`,
    { method: "GET" },
    { allowNotFound: true }
  );
}

async function listOrgTeams(route, org) {
  const result = await request(route, `orgs/${encodeURIComponent(org)}/teams`, { method: "GET" });
  return Array.isArray(result) ? result : [];
}

async function listTeamRepos(route, org, teamSlug) {
  const result = await request(
    route,
    `orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(teamSlug)}/repos`,
    { method: "GET" }
  );
  return Array.isArray(result) ? result : [];
}

async function getTeam(route, org, teamSlug) {
  return request(
    route,
    `orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(teamSlug)}`,
    { method: "GET" },
    { allowNotFound: true }
  );
}

async function createOrgTeam(route, org, { name, description, privacy } = {}) {
  const body = { name };
  if (description) body.description = description;
  body.privacy = privacy || "closed";
  return request(route, `orgs/${encodeURIComponent(org)}/teams`, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

async function updateTeam(route, org, teamSlug, { name, description, privacy } = {}) {
  const body = {};
  if (name) body.name = name;
  if (description) body.description = description;
  if (privacy) body.privacy = privacy;
  return request(
    route,
    `orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(teamSlug)}`,
    { method: "PATCH", body: JSON.stringify(body) }
  );
}

async function deleteTeam(route, org, teamSlug) {
  return request(
    route,
    `orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(teamSlug)}`,
    { method: "DELETE" }
  );
}

async function listTeamMembers(route, org, teamSlug) {
  const result = await request(
    route,
    `orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(teamSlug)}/members`,
    { method: "GET" }
  );
  return Array.isArray(result) ? result : [];
}

async function removeTeamMembership(route, org, teamSlug, username) {
  return request(
    route,
    `orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(teamSlug)}/memberships/${encodeURIComponent(username)}`,
    { method: "DELETE" }
  );
}

async function setTeamRepoAccess(route, org, teamSlug, owner, repo, permission) {
  return request(
    route,
    `orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(teamSlug)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    { method: "PUT", body: JSON.stringify({ permission }) }
  );
}

async function removeTeamRepoAccess(route, org, teamSlug, owner, repo) {
  return request(
    route,
    `orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(teamSlug)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    { method: "DELETE" }
  );
}

async function setRepoCollaborator(route, owner, repo, username, permission) {
  return request(
    route,
    `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(username)}`,
    { method: "PUT", body: JSON.stringify({ permission }) }
  );
}

async function removeRepoCollaborator(route, owner, repo, username) {
  return request(
    route,
    `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(username)}`,
    { method: "DELETE" }
  );
}

async function listOrgInvitations(route, org) {
  const result = await request(route, `orgs/${encodeURIComponent(org)}/invitations`, { method: "GET" });
  return Array.isArray(result) ? result : [];
}

async function revokeOrgInvitation(route, org, invitationId) {
  return request(
    route,
    `orgs/${encodeURIComponent(org)}/invitations/${Number(invitationId)}`,
    { method: "DELETE" }
  );
}

async function listOrgMembers(route, org, role) {
  const query = role ? `?role=${encodeURIComponent(role)}` : "";
  const result = await request(route, `orgs/${encodeURIComponent(org)}/members${query}`, { method: "GET" });
  return Array.isArray(result) ? result : [];
}

async function removeOrgMember(route, org, username) {
  return request(
    route,
    `orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(username)}`,
    { method: "DELETE" }
  );
}

async function removeOrgMembership(route, org, username) {
  return request(
    route,
    `orgs/${encodeURIComponent(org)}/memberships/${encodeURIComponent(username)}`,
    { method: "DELETE" }
  );
}

async function transferRepo(route, owner, repo, newOwner, newRepoName) {
  const body = { new_owner: newOwner };
  if (newRepoName) body.new_repo_name = newRepoName;
  return request(
    route,
    `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/transfer`,
    { method: "POST", body: JSON.stringify(body) }
  );
}

async function renameRepo(route, owner, repo, newName) {
  return request(
    route,
    `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    { method: "PATCH", body: JSON.stringify({ name: newName }) }
  );
}

async function setTeamMembership(route, org, teamSlug, username, role) {
  return request(
    route,
    `orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(teamSlug)}/memberships/${encodeURIComponent(username)}`,
    { method: "PUT", body: JSON.stringify({ role }) }
  );
}

async function listRepoCollaborators(route, owner, repo) {
  const result = await request(
    route,
    `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators`,
    { method: "GET" }
  );
  return Array.isArray(result) ? result : [];
}

async function listRepoInvitations(route, owner, repo) {
  const result = await request(
    route,
    `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/invitations`,
    { method: "GET" }
  );
  return Array.isArray(result) ? result : [];
}

async function listOrgOutsideCollaborators(route, org) {
  const result = await request(
    route,
    `orgs/${encodeURIComponent(org)}/outside_collaborators`,
    { method: "GET" }
  );
  return Array.isArray(result) ? result : [];
}

async function createOrgInvitation(route, org, { inviteeLogin, role, teamIds, expiresInDays } = {}) {
  const body = {
    invitee_login: inviteeLogin,
    role: role || "member"
  };
  if (Array.isArray(teamIds) && teamIds.length > 0) body.team_ids = teamIds;
  if (typeof expiresInDays === "number") body.expires_in_days = expiresInDays;
  return request(route, `orgs/${encodeURIComponent(org)}/invitations`, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

async function listUserRepoInvitations(route) {
  const result = await request(route, "user/repository_invitations", { method: "GET" });
  return Array.isArray(result) ? result : [];
}

async function acceptUserRepoInvitation(route, invitationId) {
  return request(route, `user/repository_invitations/${Number(invitationId)}`, { method: "PATCH" });
}

async function declineUserRepoInvitation(route, invitationId) {
  return request(route, `user/repository_invitations/${Number(invitationId)}`, { method: "DELETE" });
}

async function listUserOrgInvitations(route) {
  const result = await request(route, "user/organization_invitations", { method: "GET" });
  return Array.isArray(result) ? result : [];
}

async function acceptUserOrgInvitation(route, invitationId) {
  return request(route, `user/organization_invitations/${Number(invitationId)}`, { method: "PATCH" });
}

async function declineUserOrgInvitation(route, invitationId) {
  return request(route, `user/organization_invitations/${Number(invitationId)}`, { method: "DELETE" });
}

async function forgetMemory(route, repo, memoryId) {
  const issueNumber = Number(memoryId);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new Error("memoryId must be a positive issue number");
  const current = await getIssue(route, repo, issueNumber, true);
  if (!current) return null;
  const labels = extractLabelNames(current.labels);
  if (!labels.includes("type:memory")) {
    // still allow close, but don't touch labels
    return updateIssue(route, repo, issueNumber, { state: "closed" });
  }
  const kindSlug = kindFromLabels(labels);
  const topicSlugs = topicsFromLabels(labels);
  await syncManagedLabels(route, repo, issueNumber, memoryLabelsFor(kindSlug, topicSlugs));
  return updateIssue(route, repo, issueNumber, { state: "closed" });
}

module.exports = {
  acceptUserOrgInvitation,
  acceptUserRepoInvitation,
  addIssueLabels,
  conversationBody,
  conversationComment,
  createComment,
  createEvent,
  createIssue,
  createOrgInvitation,
  createOrgRepo,
  createOrgTeam,
  createUserOrg,
  createUserRepo,
  declineUserOrgInvitation,
  declineUserRepoInvitation,
  deleteTeam,
  ensureLabels,
  extractLabelNames,
  findActiveMemoryByHash,
  findMemoryByRef,
  forgetMemory,
  getIssue,
  getOrg,
  getOrgMembership,
  getRepo,
  getTeam,
  isManagedLabel,
  issueDetail,
  issueLabels,
  issueState,
  listComments,
  listIssues,
  listLabels,
  listOrgInvitations,
  listOrgMembers,
  listOrgOutsideCollaborators,
  listOrgTeams,
  listRepoCollaborators,
  listRepoInvitations,
  listSchema,
  listTeamMembers,
  listTeamRepos,
  listUserOrgInvitations,
  listUserOrgs,
  listUserRepoInvitations,
  listUserRepos,
  removeOrgMember,
  removeOrgMembership,
  removeRepoCollaborator,
  removeTeamMembership,
  removeTeamRepoAccess,
  renameRepo,
  revokeOrgInvitation,
  parseConversationBody,
  registerAgent,
  request,
  searchIssues,
  setRepoCollaborator,
  setTeamMembership,
  setTeamRepoAccess,
  storeMemory,
  syncManagedLabels,
  transferRepo,
  updateIssue,
  updateMemory,
  updateTeam
};
