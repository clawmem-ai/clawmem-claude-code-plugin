#!/usr/bin/env node
const fs = require("node:fs");
const { appendEvent, loadState, mutateState } = require("../lib/state");
const github = require("../lib/github");
const { createConversationIssue, ensureRoute, updateConversationBody } = require("../lib/runtime");

async function readJsonStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function extractText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        if (!part) return "";
        if (typeof part === "string") return part;
        if (part.type === "text" && typeof part.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function readTranscript(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];
  const raw = fs.readFileSync(transcriptPath, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // ignore malformed lines
    }
  }
  return entries;
}

function isRealUserEntry(entry) {
  if (!entry || entry.type !== "user" || !entry.message) return false;
  const content = entry.message.content;
  if (Array.isArray(content) && content.some((part) => part && part.type === "tool_result")) {
    return false;
  }
  return true;
}

function pickLastAssistantText(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.type === "assistant" && entry.message) {
      const text = extractText(entry.message).trim();
      if (text) return text;
    }
  }
  return "";
}

function pickLastUserText(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!isRealUserEntry(entries[i])) continue;
    const text = extractText(entries[i].message).trim();
    if (text) return text;
  }
  return "";
}

function collectMirrorableTurns(entries) {
  const turns = [];
  for (const entry of entries) {
    if (!entry) continue;
    if (entry.type === "assistant" && entry.message) {
      const text = extractText(entry.message).trim();
      if (text) turns.push({ role: "assistant", text });
    } else if (isRealUserEntry(entry)) {
      const text = extractText(entry.message).trim();
      if (text) turns.push({ role: "user", text });
    }
  }
  return turns;
}

function textFromField(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (!part) return "";
        if (typeof part === "string") return part;
        if (part.type === "text" && typeof part.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (typeof value === "object") {
    if (typeof value.content !== "undefined") return textFromField(value.content);
    if (typeof value.text === "string") return value.text.trim();
  }
  return "";
}

async function main() {
  const input = await readJsonStdin();
  const sessionId = String(input.session_id || "unknown");
  const transcriptPath = String(input.transcript_path || input.transcriptPath || "");
  const entries = readTranscript(transcriptPath);
  const turns = collectMirrorableTurns(entries);

  const state = loadState();
  const session = state.sessions[sessionId] || {};
  const cursor = Number(session.lastMirroredCount || 0);
  const newTurns = turns.slice(cursor);

  if (newTurns.length === 0) {
    const fallbackAssistant =
      textFromField(input.last_assistant_message) ||
      textFromField(input.lastAssistantMessage) ||
      pickLastAssistantText(entries);
    if (!fallbackAssistant) {
      appendEvent({
        source: "hook",
        hook: "Stop",
        type: "mirror_skipped_no_new_turns",
        sessionId
      });
      return;
    }
    const fallbackPrompt = (session.pendingTurn && session.pendingTurn.prompt) || pickLastUserText(entries);
    if (!fallbackPrompt) {
      appendEvent({
        source: "hook",
        hook: "Stop",
        type: "mirror_skipped_no_prompt",
        sessionId
      });
      return;
    }
    newTurns.push({ role: "user", text: fallbackPrompt });
    newTurns.push({ role: "assistant", text: fallbackAssistant });
  }

  const route = await ensureRoute();
  const repo = route.defaultRepo;
  let issueNumber = session.conversationIssueNumber;
  if (!issueNumber) {
    issueNumber = await createConversationIssue(route, repo, sessionId);
  }

  let turnId = Number(session.nextTurnId || 1);
  for (const turn of newTurns) {
    await github.createComment(
      route,
      repo,
      issueNumber,
      github.conversationComment(turn.role, turnId, turn.text)
    );
    if (turn.role === "assistant") turnId += 1;
  }

  await updateConversationBody(route, repo, issueNumber, {
    sessionId,
    lastActivity: new Date().toISOString()
  }).catch(() => null);

  await github.createEvent(route, {
    repo,
    type: "mirror_success",
    severity: "info",
    step: "stop",
    session_id: sessionId,
    message: `Mirrored ${newTurns.length} message(s) into conversation issue #${issueNumber}.`,
    details: {
      conversation_issue_number: issueNumber,
      appended: newTurns.length,
      next_turn_id: turnId
    }
  });

  const mirroredCount = cursor + newTurns.length;
  const turnDelta = newTurns.length > 0 ? 1 : 0;
  mutateState((nextState) => {
    const nextSession = nextState.sessions[sessionId] || {};
    nextSession.conversationIssueNumber = issueNumber;
    nextSession.lastMirroredCount = mirroredCount;
    nextSession.nextTurnId = turnId;
    nextSession.turnsSinceReview = (nextSession.turnsSinceReview || 0) + turnDelta;
    delete nextSession.pendingTurn;
    delete nextSession.lastMirroredTurnId;
    nextState.sessions[sessionId] = nextSession;
    return nextState;
  });

  appendEvent({
    source: "hook",
    hook: "Stop",
    type: "mirror_complete",
    sessionId,
    repo,
    issueNumber,
    appended: newTurns.length,
    mirroredCount
  });
}

main().catch((error) => {
  appendEvent({
    source: "hook",
    hook: "Stop",
    type: "fatal_error",
    error: String(error)
  });
  process.exit(0);
});
