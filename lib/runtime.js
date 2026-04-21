const { resolveAgentPrefix, resolveBaseUrl, resolveConsoleBaseUrl, resolveDefaultRepoName } = require("./config");
const { appendEvent, mutateState } = require("./state");
const github = require("./github");
const { buildRecallSearchText } = require("./recall-sanitize");
const { clip, nowIso, slugify, todayIsoDate } = require("./util");

function applyUserOverrides(route) {
  const override = {};
  const optToken = String(process.env.CLAUDE_PLUGIN_OPTION_token || process.env.CLAWMEM_TOKEN || "").trim();
  if (optToken) override.token = optToken;
  const optRepo = String(process.env.CLAUDE_PLUGIN_OPTION_defaultRepo || process.env.CLAWMEM_DEFAULT_REPO || "").trim();
  if (optRepo && /^[^/\s]+\/[^/\s]+$/.test(optRepo)) override.defaultRepo = optRepo;
  const baseUrl = resolveBaseUrl(route);
  if (baseUrl) override.baseUrl = baseUrl;
  if (Object.keys(override).length === 0) return route;
  return { authScheme: "token", ...(route || {}), ...override };
}

async function ensureRoute() {
  let route = null;
  mutateState((state) => {
    route = state.route;
    return state;
  });
  route = applyUserOverrides(route);
  if (route && route.token && route.defaultRepo && route.baseUrl) return route;

  const baseUrl = resolveBaseUrl(route);
  const MAX_PREFIX_LEN = 20;
  const agentPrefix = resolveAgentPrefix();
  const projectSlot = Math.max(1, MAX_PREFIX_LEN - agentPrefix.length - 1);
  const projectSlug = slugify(process.cwd().split("/").pop() || "project", "project").slice(0, projectSlot).replace(/-+$/, "") || "project";
  const prefix = `${agentPrefix}-${projectSlug}`.slice(0, MAX_PREFIX_LEN);
  const defaultRepoName = resolveDefaultRepoName();
  const registered = await github.registerAgent({
    baseUrl,
    prefixLogin: prefix,
    defaultRepoName
  });
  mutateState((state) => {
    state.route = registered;
    return state;
  });
  appendEvent({
    source: "runtime",
    type: "bootstrap_success",
    repo: registered.defaultRepo,
    login: registered.login,
    method: registered.bootstrapMethod || "/api/v3/agents"
  });
  return registered;
}

function summarizeMemory(issue) {
  const detail = github.issueDetail(issue);
  return {
    memoryId: issue.number,
    title: issue.title,
    detail,
    state: github.issueState(issue),
    labels: github.issueLabels(issue)
  };
}

async function recall(route, repo, query, limit = 3) {
  const cleaned = buildRecallSearchText(String(query || ""));
  if (!cleaned) return [];
  const q = `${cleaned} repo:${repo} label:type:memory state:open`;
  const issues = await github.searchIssues(route, q, { perPage: limit });
  return issues.slice(0, limit).map(summarizeMemory);
}

function formatRecallContext(items, repo) {
  if (!items || items.length === 0) return "";
  const lines = [
    `## ClawMem Recall (${repo})`,
    ...items.map((item) => `- [#${item.memoryId}] ${item.title}: ${clip(item.detail, 240)}`)
  ];
  return lines.join("\n");
}

function buildConsoleUrl(route, options = {}) {
  const base = resolveConsoleBaseUrl(route).replace(/\/+$/, "");
  const repo = (options.repo || (route && route.defaultRepo) || "").trim();
  const query = new URLSearchParams();
  if (options.includeToken && route && route.token) query.set("token", route.token);
  if (options.query) query.set("q", options.query);
  const suffix = query.toString();
  const path = repo ? `/${repo}` : "";
  return suffix ? `${base}${path}?${suffix}` : `${base}${path}`;
}

async function createConversationIssue(route, repo, sessionId) {
  const openedAt = nowIso();
  const date = todayIsoDate();
  const issue = await github.createIssue(route, repo, {
    title: `Claude Session ${sessionId.slice(0, 8)}`,
    body: github.conversationBody({
      sessionId,
      openedAt,
      title: `Claude Session ${sessionId.slice(0, 8)}`,
      date,
      lastActivity: openedAt
    }),
    labels: [
      "type:conversation",
      "status:active",
      "source:claude-code",
      `session:${slugify(sessionId, "session")}`,
      `date:${date}`
    ]
  });
  return issue.number;
}

async function updateConversationBody(route, repo, issueNumber, patch) {
  const current = await github.getIssue(route, repo, issueNumber);
  if (!current) return null;
  const parsed = github.parseConversationBody(current.body);
  const merged = {
    sessionId: parsed.session_id || patch.sessionId,
    openedAt: parsed.opened_at || patch.openedAt || nowIso(),
    title: patch.title || parsed.title,
    date: parsed.date || patch.date || todayIsoDate(),
    lastActivity: patch.lastActivity || nowIso(),
    summary: patch.summary || parsed.summary
  };
  return github.updateIssue(route, repo, issueNumber, {
    body: github.conversationBody(merged)
  });
}

module.exports = {
  buildConsoleUrl,
  createConversationIssue,
  ensureRoute,
  formatRecallContext,
  recall,
  summarizeMemory,
  updateConversationBody
};
