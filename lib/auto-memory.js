const fs = require("node:fs");
const path = require("node:path");

const AUTO_MEMORY_PATH_RE = /\/\.claude\/projects\/[^/]+\/memory\/[^/]+\.md$/;

function isAutoMemoryPath(filePath) {
  if (!filePath || typeof filePath !== "string") return false;
  return AUTO_MEMORY_PATH_RE.test(filePath);
}

function isMemoryIndexPath(filePath) {
  return typeof filePath === "string" && filePath.endsWith("/memory/MEMORY.md");
}

function parseFrontmatter(text) {
  const source = String(text || "");
  if (!source.startsWith("---")) return { meta: {}, body: source };
  const end = source.indexOf("\n---", 3);
  if (end === -1) return { meta: {}, body: source };
  const header = source.slice(3, end).trim();
  const body = source.slice(end + 4).replace(/^\n/, "");
  const meta = {};
  for (const line of header.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    meta[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body };
}

function extractBashTargets(command) {
  if (!command || typeof command !== "string") return [];
  const targets = [];
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  for (const raw of tokens) {
    const token = raw.replace(/^["']|["']$/g, "");
    if (isAutoMemoryPath(token)) targets.push(token);
  }
  return targets;
}

function looksLikeDeleteCommand(command) {
  if (!command || typeof command !== "string") return false;
  return /(^|[\s;&|])rm(\s+-[a-zA-Z]+)?\s/.test(command);
}

function detectMirrorAction(input) {
  if (!input || typeof input !== "object") return null;
  const toolName = input.tool_name;
  const toolInput = input.tool_input || {};
  const toolResponse = input.tool_response || {};

  const success =
    toolResponse &&
    toolResponse.success !== false &&
    !toolResponse.isError &&
    !toolResponse.error;
  if (!success) return null;

  if (toolName === "Write") {
    const filePath = toolInput.file_path;
    if (!isAutoMemoryPath(filePath) || isMemoryIndexPath(filePath)) return null;
    return {
      kind: "upsert",
      filePath,
      content: String(toolInput.content || ""),
      tool: toolName
    };
  }

  if (toolName === "Edit" || toolName === "MultiEdit") {
    const filePath = toolInput.file_path;
    if (!isAutoMemoryPath(filePath) || isMemoryIndexPath(filePath)) return null;
    let content = "";
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      return null;
    }
    return { kind: "upsert", filePath, content, tool: toolName };
  }

  if (toolName === "Bash") {
    const command = toolInput.command;
    if (!looksLikeDeleteCommand(command)) return null;
    const targets = extractBashTargets(command);
    if (targets.length === 0) return null;
    return { kind: "delete", paths: targets, tool: toolName };
  }

  return null;
}

module.exports = {
  AUTO_MEMORY_PATH_RE,
  detectMirrorAction,
  extractBashTargets,
  isAutoMemoryPath,
  isMemoryIndexPath,
  looksLikeDeleteCommand,
  parseFrontmatter
};
