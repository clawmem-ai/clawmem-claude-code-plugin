#!/usr/bin/env node
const { appendEvent, loadState, mutateState } = require("../lib/state");
const github = require("../lib/github");
const { ensureRoute } = require("../lib/runtime");

async function readJsonStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function main() {
  const input = await readJsonStdin();
  const sessionId = String(input.session_id || "unknown");
  const reason = String(input.reason || "other");
  const state = loadState();
  const session = state.sessions[sessionId];
  if (!session || !session.conversationIssueNumber) {
    appendEvent({
      source: "hook",
      hook: "SessionEnd",
      type: "session_end_without_conversation",
      sessionId,
      reason
    });
    return;
  }

  const route = await ensureRoute();
  const repo = route.defaultRepo;
  try {
    await github.syncManagedLabels(route, repo, session.conversationIssueNumber, [
      "type:conversation",
      "status:closed"
    ]);
    await github.updateIssue(route, repo, session.conversationIssueNumber, {
      state: "closed"
    });
    await github.createEvent(route, {
      repo,
      type: "session_end",
      severity: "info",
      step: "session_end",
      session_id: sessionId,
      message: `Closed conversation issue #${session.conversationIssueNumber}.`,
      details: {
        reason,
        conversation_issue_number: session.conversationIssueNumber
      }
    });
  } finally {
    mutateState((nextState) => {
      delete nextState.sessions[sessionId];
      return nextState;
    });
  }

  appendEvent({
    source: "hook",
    hook: "SessionEnd",
    type: "conversation_closed",
    sessionId,
    issueNumber: session.conversationIssueNumber,
    reason
  });
}

main().catch((error) => {
  appendEvent({
    source: "hook",
    hook: "SessionEnd",
    type: "fatal_error",
    error: String(error)
  });
  process.exit(0);
});
