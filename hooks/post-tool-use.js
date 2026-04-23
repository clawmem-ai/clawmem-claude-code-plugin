#!/usr/bin/env node
const { appendEvent, loadState, mutateState } = require("../lib/state");
const { EventType } = require("../lib/events");
const github = require("../lib/github");
const { ensureRoute } = require("../lib/runtime");
const { detectMirrorAction, parseFrontmatter } = require("../lib/auto-memory");
const { slugify } = require("../lib/util");

const MEMORY_REVIEW_TOOL = "mcp__clawmem__memory_review";

function maybeResetReviewCounter(input) {
  const toolName = String((input && input.tool_name) || "");
  if (toolName !== MEMORY_REVIEW_TOOL) return false;
  const sessionId = String(input.session_id || "unknown");
  let didReset = false;
  mutateState((next) => {
    const session = next.sessions[sessionId] || {};
    if ((session.turnsSinceReview || 0) !== 0) {
      session.turnsSinceReview = 0;
      didReset = true;
    }
    next.sessions[sessionId] = session;
    return next;
  });
  if (didReset) {
    appendEvent({
      source: "hook",
      hook: "PostToolUse",
      type: EventType.MEMORY_REVIEW_RESET,
      sessionId
    });
  }
  return true;
}

async function readJsonStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function extractAgentMeta(input) {
  const agentId = String((input && input.agent_id) || "").trim();
  const agentType = String((input && input.agent_type) || "").trim();
  return { agentId, agentType };
}

function agentLabels(meta) {
  const labels = [];
  if (meta.agentId) labels.push(`agent:${slugify(meta.agentId, "sub")}`);
  if (meta.agentType) labels.push(`agent-type:${slugify(meta.agentType, "unknown")}`);
  return labels;
}

function memoryFieldsFromAutoMemory(filePath, content) {
  const { meta, body } = parseFrontmatter(content);
  const title = String(meta.name || meta.description || filePath.split("/").pop() || "memory").trim();
  const description = String(meta.description || "").trim();
  const kind = String(meta.type || "").trim();
  const rawBody = String(body || "").trim();
  const detailSegments = [description, rawBody].filter(Boolean);
  const detail = detailSegments.join("\n\n").trim() || title;
  return { title, detail, kind };
}

async function tagAgentLabels(route, repo, issueNumber, agentMeta) {
  const labels = agentLabels(agentMeta);
  if (labels.length === 0) return;
  try {
    await github.addIssueLabels(route, repo, issueNumber, labels);
  } catch (error) {
    appendEvent({
      source: "hook",
      hook: "PostToolUse",
      type: "mirror_label_error",
      memoryId: issueNumber,
      labels,
      error: String(error)
    });
  }
}

async function handleUpsert(route, repo, sessionId, action, agentMeta) {
  const fields = memoryFieldsFromAutoMemory(action.filePath, action.content);
  const state = loadState();
  const mirror = state.autoMemoryMirror || {};
  const existingId = mirror[action.filePath];

  if (existingId) {
    try {
      const updated = await github.updateMemory(route, repo, existingId, {
        detail: fields.detail,
        title: fields.title,
        kind: fields.kind
      });
      if (updated) {
        await tagAgentLabels(route, repo, existingId, agentMeta);
        await github.createEvent(route, {
          repo,
          type: "auto_memory_mirror_update",
          severity: "info",
          step: "post_tool_use",
          session_id: sessionId,
          message: `Mirrored auto-memory update to clawmem memory #${existingId}.`,
          details: {
            file_path: action.filePath,
            memory_id: existingId,
            tool: action.tool,
            agent_id: agentMeta.agentId || null,
            agent_type: agentMeta.agentType || null
          }
        });
        return { memoryId: existingId, created: false };
      }
    } catch (error) {
      appendEvent({
        source: "hook",
        hook: "PostToolUse",
        type: "mirror_update_error",
        filePath: action.filePath,
        memoryId: existingId,
        error: String(error)
      });
    }
  }

  const result = await github.storeMemory(route, repo, {
    detail: fields.detail,
    title: fields.title,
    kind: fields.kind
  });
  const memoryId = result && result.issue && result.issue.number;
  if (!memoryId) return null;

  await tagAgentLabels(route, repo, memoryId, agentMeta);

  mutateState((next) => {
    next.autoMemoryMirror = next.autoMemoryMirror || {};
    next.autoMemoryMirror[action.filePath] = memoryId;
    return next;
  });

  await github.createEvent(route, {
    repo,
    type: result.created ? "auto_memory_mirror_store" : "auto_memory_mirror_dedup",
    severity: "info",
    step: "post_tool_use",
    session_id: sessionId,
    message: result.created
      ? `Mirrored auto-memory write to new clawmem memory #${memoryId}.`
      : `Mirrored auto-memory write matched existing clawmem memory #${memoryId}.`,
    details: {
      file_path: action.filePath,
      memory_id: memoryId,
      tool: action.tool,
      agent_id: agentMeta.agentId || null,
      agent_type: agentMeta.agentType || null
    }
  });
  return { memoryId, created: !!result.created };
}

async function handleDelete(route, repo, sessionId, action) {
  const state = loadState();
  const mirror = { ...(state.autoMemoryMirror || {}) };
  const closed = [];
  for (const filePath of action.paths) {
    const memoryId = mirror[filePath];
    if (!memoryId) continue;
    try {
      await github.forgetMemory(route, repo, memoryId);
      closed.push({ filePath, memoryId });
    } catch (error) {
      appendEvent({
        source: "hook",
        hook: "PostToolUse",
        type: "mirror_forget_error",
        filePath,
        memoryId,
        error: String(error)
      });
    }
  }
  if (closed.length > 0) {
    mutateState((next) => {
      next.autoMemoryMirror = next.autoMemoryMirror || {};
      for (const item of closed) delete next.autoMemoryMirror[item.filePath];
      return next;
    });
    await github.createEvent(route, {
      repo,
      type: "auto_memory_mirror_forget",
      severity: "info",
      step: "post_tool_use",
      session_id: sessionId,
      message: `Mirrored auto-memory deletion to clawmem: ${closed.map((c) => `#${c.memoryId}`).join(", ")}.`,
      details: { closed, tool: action.tool }
    });
  }
  return closed;
}

async function main() {
  const input = await readJsonStdin();
  if (maybeResetReviewCounter(input)) return;
  const action = detectMirrorAction(input);
  if (!action) return;

  const sessionId = String(input.session_id || "unknown");
  const agentMeta = extractAgentMeta(input);
  const route = await ensureRoute();
  const repo = route.defaultRepo;

  if (action.kind === "upsert") {
    await handleUpsert(route, repo, sessionId, action, agentMeta);
  } else if (action.kind === "delete") {
    await handleDelete(route, repo, sessionId, action);
  }
}

main().catch((error) => {
  appendEvent({
    source: "hook",
    hook: "PostToolUse",
    type: "fatal_error",
    error: String(error)
  });
  process.exit(0);
});
