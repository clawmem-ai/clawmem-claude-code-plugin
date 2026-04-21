const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_RECALL_QUERY_CHARS,
  buildRecallSearchText,
  sanitizeRecallQueryInput,
  stripRecallArtifacts,
  truncateRecallQuery
} = require("../lib/recall-sanitize");

test("returns empty on empty input", () => {
  assert.equal(buildRecallSearchText(""), "");
  assert.equal(buildRecallSearchText(null), "");
  assert.equal(buildRecallSearchText(undefined), "");
});

test("strips URLs from the query text", () => {
  const result = buildRecallSearchText("deploy failing https://example.com/job/123 please help");
  assert.equal(result, "deploy failing please help");
});

test("strips previously injected <clawmem-context> blocks", () => {
  const input = "real query here\n<clawmem-context>\n- prior\n</clawmem-context>\ntrailing";
  const result = stripRecallArtifacts(input);
  assert.ok(!result.includes("<clawmem-context>"));
  assert.ok(!result.includes("prior"));
  assert.ok(result.includes("real query"));
  assert.ok(result.includes("trailing"));
});

test("strips Feishu system hints at the end", () => {
  const result = sanitizeRecallQueryInput("can you help me deploy [System: channel=ops]");
  assert.equal(result, "can you help me deploy");
});

test("strips Feishu sender prefix", () => {
  const result = sanitizeRecallQueryInput("ou_abc123: help with deploy");
  assert.equal(result, "help with deploy");
});

test("strips Slack-style envelope", () => {
  const result = sanitizeRecallQueryInput("[Slack alice]: hi there");
  assert.equal(result, "hi there");
});

test("strips leading message_id hint lines", () => {
  const result = sanitizeRecallQueryInput("[message_id: abc]\n\nreal text");
  assert.equal(result, "real text");
});

test("strips leading inbound metadata fenced json block", () => {
  const input = [
    "Conversation info (untrusted metadata):",
    "```json",
    '{"thread_id":"x"}',
    "```",
    "",
    "actual question"
  ].join("\n");
  const result = sanitizeRecallQueryInput(input);
  assert.equal(result, "actual question");
});

test("truncates to MAX_RECALL_QUERY_CHARS", () => {
  const long = "word ".repeat(1000);
  const result = truncateRecallQuery(long, MAX_RECALL_QUERY_CHARS);
  assert.ok(result.length <= MAX_RECALL_QUERY_CHARS);
  assert.equal(MAX_RECALL_QUERY_CHARS, 1500);
});

test("buildRecallSearchText composes sanitize + strip + truncate", () => {
  const input = [
    "[Slack bob]: please investigate https://x.com/a",
    "<clawmem-context>ignore</clawmem-context>",
    "the failing CI job"
  ].join("\n");
  const result = buildRecallSearchText(input);
  assert.ok(!result.includes("http"));
  assert.ok(!result.includes("clawmem-context"));
  assert.ok(!result.includes("ignore"));
  assert.ok(result.includes("investigate"));
  assert.ok(result.includes("failing CI job"));
});
