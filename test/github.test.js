const test = require("node:test");
const assert = require("node:assert/strict");

const {
  conversationBody,
  extractLabelNames,
  isManagedLabel,
  issueDetail,
  parseConversationBody
} = require("../lib/github");

test("issueDetail reads YAML block detail", () => {
  const body = "type: memory\ndetail: |-\n  prefers jq in shell e2e\n  and curl for simple API checks\n";
  assert.equal(issueDetail({ body }), "prefers jq in shell e2e\nand curl for simple API checks");
});

test("isManagedLabel recognizes managed prefixes and exacts", () => {
  assert.equal(isManagedLabel("type:memory"), true);
  assert.equal(isManagedLabel("status:active"), true);
  assert.equal(isManagedLabel("status:closed"), true);
  assert.equal(isManagedLabel("memory-status:stale"), true);
  assert.equal(isManagedLabel("kind:preference"), true);
  assert.equal(isManagedLabel("session:abc123"), true);
  assert.equal(isManagedLabel("date:2026-04-20"), true);
  assert.equal(isManagedLabel("topic:deploy"), true);
  assert.equal(isManagedLabel("agent:claude"), true);
  assert.equal(isManagedLabel("source:claude-code"), false);
  assert.equal(isManagedLabel("priority:high"), false);
  assert.equal(isManagedLabel(""), false);
});

test("extractLabelNames handles string and object entries", () => {
  assert.deepEqual(extractLabelNames(["type:memory", { name: "status:active" }, null, { name: "" }]), [
    "type:memory",
    "status:active"
  ]);
  assert.deepEqual(extractLabelNames(undefined), []);
});

test("conversationBody + parseConversationBody round-trip", () => {
  const body = conversationBody({
    sessionId: "abcd-1234",
    openedAt: "2026-04-20T10:00:00Z",
    title: "Claude Session abcd1234",
    date: "2026-04-20",
    lastActivity: "2026-04-20T11:00:00Z",
    summary: "line one\nline two"
  });
  const parsed = parseConversationBody(body);
  assert.equal(parsed.type, "conversation");
  assert.equal(parsed.session_id, "abcd-1234");
  assert.equal(parsed.status, "active");
  assert.equal(parsed.opened_at, "2026-04-20T10:00:00Z");
  assert.equal(parsed.title, "Claude Session abcd1234");
  assert.equal(parsed.date, "2026-04-20");
  assert.equal(parsed.last_activity, "2026-04-20T11:00:00Z");
  assert.equal(parsed.summary, "line one\nline two");
});
