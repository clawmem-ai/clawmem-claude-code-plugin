#!/usr/bin/env node
const { appendEvent, loadState, mutateState } = require("../lib/state");
const { resolveMemoryAutoRecallLimit, resolveReviewNudgeInterval } = require("../lib/config");
const { EventType } = require("../lib/events");
const github = require("../lib/github");
const { ensureRoute, formatRecallContext, recall } = require("../lib/runtime");

function buildReviewNudgeContext(turnsSinceReview, interval) {
  return [
    "<clawmem-review-nudge>",
    `It has been ${turnsSinceReview} user turn(s) since the last ClawMem review (interval: ${interval}).`,
    "Before concluding this turn, run the review protocol in `skills/clawmem/references/review.md`:",
    "- Memory track: save new preferences, corrections, validations, and stale beliefs via `memory_store` / `memory_update` / `memory_forget`.",
    "- Skill track: capture or refine `kind:skill` playbooks for non-trivial workflows that succeeded this segment.",
    "- Promote two or more converging `kind:lesson` memories into one `kind:skill` when they point at the same corrective direction.",
    "Call the `mcp__clawmem__memory_review` MCP tool if you want the full checklist returned as tool output. Calling it clears this nudge.",
    "</clawmem-review-nudge>"
  ].join("\n");
}

async function readJsonStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function main() {
  const input = await readJsonStdin();
  const route = await ensureRoute();
  const repo = route.defaultRepo;
  const prompt = String(input.prompt || "").trim();
  const sessionId = String(input.session_id || "unknown");

  mutateState((state) => {
    const session = state.sessions[sessionId] || { nextTurnId: 1 };
    session.pendingTurn = {
      turnId: session.nextTurnId || 1,
      prompt,
      createdAt: new Date().toISOString()
    };
    session.nextTurnId = (session.nextTurnId || 1) + 1;
    state.sessions[sessionId] = session;
    return state;
  });

  let recalled = [];
  let recallFailed = false;
  try {
    if (prompt) recalled = await recall(route, repo, prompt, resolveMemoryAutoRecallLimit());
    await github.createEvent(route, {
      repo,
      type: recalled.length > 0 ? "recall_success" : "recall_miss",
      severity: "info",
      step: "user_prompt_submit",
      session_id: sessionId,
      message: recalled.length > 0 ? `Recalled ${recalled.length} memories before prompt execution.` : "No relevant memories recalled before prompt execution.",
      details: {
        prompt,
        memory_ids: recalled.map((item) => item.memoryId)
      }
    });
  } catch (error) {
    recallFailed = true;
    appendEvent({
      source: "hook",
      hook: "UserPromptSubmit",
      type: "recall_error",
      error: String(error)
    });
  }

  if (!recallFailed) {
    appendEvent({
      source: "hook",
      hook: "UserPromptSubmit",
      type: "recall_complete",
      sessionId,
      repo,
      count: recalled.length
    });
  }

  const interval = resolveReviewNudgeInterval();
  const turnsSinceReview = Number((loadState().sessions[sessionId] || {}).turnsSinceReview || 0);
  const nudgeContext = interval > 0 && turnsSinceReview >= interval
    ? buildReviewNudgeContext(turnsSinceReview, interval)
    : "";

  if (nudgeContext) {
    appendEvent({
      source: "hook",
      hook: "UserPromptSubmit",
      type: EventType.REVIEW_NUDGE_FIRED,
      sessionId,
      turnsSinceReview,
      interval
    });
  }

  const recallContext = recalled.length > 0 ? formatRecallContext(recalled, repo) : "";
  const parts = [recallContext, nudgeContext].filter(Boolean);
  if (parts.length === 0) return;
  const additionalContext = parts.join("\n");

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext
      }
    })
  );
}

main().catch((error) => {
  appendEvent({
    source: "hook",
    hook: "UserPromptSubmit",
    type: "fatal_error",
    error: String(error)
  });
  process.exit(0);
});
