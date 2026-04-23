const path = require("node:path");

function pluginRoot() {
  if (process.env.CLAUDE_PLUGIN_ROOT) return process.env.CLAUDE_PLUGIN_ROOT;
  return path.resolve(__dirname, "..");
}

function pluginDataDir() {
  if (process.env.CLAUDE_PLUGIN_DATA) return process.env.CLAUDE_PLUGIN_DATA;
  return path.join(pluginRoot(), ".data-dev");
}

function normalizeApiBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "https://git.clawmem.ai/api/v3";
  const trimmed = raw.replace(/\/+$/, "");
  if (trimmed.endsWith("/api/v3")) return trimmed;
  return `${trimmed}/api/v3`;
}

function resolveBaseUrl(storedRoute) {
  return normalizeApiBaseUrl(
    process.env.CLAWMEM_BASE_URL ||
      process.env.CLAWMEM_GIT_BASE_URL ||
      process.env.CLAUDE_PLUGIN_OPTION_baseUrl ||
      process.env.CLAUDE_PLUGIN_OPTION_base_url ||
      (storedRoute && storedRoute.baseUrl) ||
      ""
  );
}

function deriveConsoleBaseUrl(apiBaseUrl) {
  try {
    const u = new URL(apiBaseUrl);
    const host = u.host;
    if (host === "127.0.0.1" || host === "localhost" || host.startsWith("127.0.0.1:") || host.startsWith("localhost:")) {
      return "http://localhost:5173";
    }
    if (host.startsWith("git.")) {
      return `${u.protocol}//console.${host.slice(4)}`;
    }
    return `${u.protocol}//${host}`;
  } catch {
    return "https://console.clawmem.ai";
  }
}

function resolveConsoleBaseUrl(storedRoute) {
  const explicit = String(
    process.env.CLAWMEM_CONSOLE_BASE_URL ||
      process.env.CLAUDE_PLUGIN_OPTION_consoleBaseUrl ||
      ""
  ).trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const stored = storedRoute && storedRoute.consoleBaseUrl ? String(storedRoute.consoleBaseUrl).trim() : "";
  if (stored) return stored.replace(/\/+$/, "");
  const apiBase = resolveBaseUrl(storedRoute);
  return deriveConsoleBaseUrl(apiBase).replace(/\/+$/, "");
}

function resolveAgentPrefix() {
  return String(process.env.CLAWMEM_AGENT_PREFIX || "claude").trim() || "claude";
}

function resolveDefaultRepoName() {
  return String(process.env.CLAWMEM_DEFAULT_REPO_NAME || "memory").trim() || "memory";
}

function firstDefinedInt(names, fallback, { min = 1, max = 20 } = {}) {
  for (const name of names) {
    const raw = Number(process.env[name]);
    if (!Number.isFinite(raw)) continue;
    const n = Math.floor(raw);
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }
  return fallback;
}

function resolveMemoryRecallLimit() {
  return firstDefinedInt(
    ["CLAWMEM_MEMORY_RECALL_LIMIT", "CLAUDE_PLUGIN_OPTION_memoryRecallLimit"],
    5,
    { min: 1, max: 20 }
  );
}

function resolveMemoryAutoRecallLimit() {
  return firstDefinedInt(
    ["CLAWMEM_MEMORY_AUTO_RECALL_LIMIT", "CLAUDE_PLUGIN_OPTION_memoryAutoRecallLimit"],
    3,
    { min: 1, max: 20 }
  );
}

function resolveReviewNudgeInterval() {
  return firstDefinedInt(
    ["CLAWMEM_REVIEW_NUDGE_INTERVAL", "CLAUDE_PLUGIN_OPTION_reviewNudgeInterval"],
    10,
    { min: 0, max: 100 }
  );
}

function resolveFinalizeTimeoutMs() {
  return firstDefinedInt(
    ["CLAWMEM_FINALIZE_TIMEOUT_MS", "CLAUDE_PLUGIN_OPTION_summaryWaitTimeoutMs"],
    90_000,
    { min: 30_000, max: 600_000 }
  );
}

function eventLogPath() {
  return path.join(pluginDataDir(), "debug", "events.jsonl");
}

module.exports = {
  deriveConsoleBaseUrl,
  eventLogPath,
  normalizeApiBaseUrl,
  pluginDataDir,
  pluginRoot,
  resolveAgentPrefix,
  resolveBaseUrl,
  resolveConsoleBaseUrl,
  resolveDefaultRepoName,
  resolveFinalizeTimeoutMs,
  resolveMemoryAutoRecallLimit,
  resolveMemoryRecallLimit,
  resolveReviewNudgeInterval
};
