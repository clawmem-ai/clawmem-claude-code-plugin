const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PLUGIN_ROOT = path.resolve(__dirname, "..");
const HOOKS_JSON = path.join(PLUGIN_ROOT, "hooks", "hooks.json");
const PLUGIN_MANIFEST = path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json");

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("hooks.json SessionEnd agent finalize hook entry comes first in the SessionEnd array", () => {
  const hooks = loadJson(HOOKS_JSON);
  const entries = hooks.hooks.SessionEnd;
  assert.ok(Array.isArray(entries), "SessionEnd should be an array");
  assert.ok(entries.length >= 2, `expected at least 2 SessionEnd entries, got ${entries.length}`);

  const agentEntry = entries[0];
  assert.equal(agentEntry.matcher, "^(logout|prompt_input_exit|other)$");
  assert.equal(agentEntry.hooks.length, 1);
  assert.equal(agentEntry.hooks[0].type, "agent");

  const legacyEntry = entries[entries.length - 1];
  assert.equal(legacyEntry.hooks[0].type, "command");
  assert.match(legacyEntry.hooks[0].command, /session-end\.js/);
});

test("hooks.json PreCompact has an agent finalize hook matching manual|auto", () => {
  const hooks = loadJson(HOOKS_JSON);
  const entries = hooks.hooks.PreCompact;
  assert.ok(Array.isArray(entries), "PreCompact should be an array");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].matcher, "manual|auto");
  assert.equal(entries[0].hooks[0].type, "agent");
});

test("SessionEnd agent finalize prompt references required tools, transcript flow, and event log", () => {
  const hooks = loadJson(HOOKS_JSON);
  const sessionEndAgent = hooks.hooks.SessionEnd[0].hooks[0];
  const prompt = sessionEndAgent.prompt;
  assert.equal(typeof prompt, "string");

  assert.match(prompt, /\$ARGUMENTS/, "prompt should pass hook input via $ARGUMENTS");
  assert.match(prompt, /transcript_path/, "prompt should reference transcript_path");
  assert.match(prompt, /mcp__clawmem__memory_labels/);
  assert.match(prompt, /mcp__clawmem__memory_store/);
  assert.match(prompt, /finalize_success/);
  assert.match(prompt, /finalize_failed/);
  assert.match(prompt, /\$CLAUDE_PLUGIN_DATA\/debug\/events\.jsonl/);
  assert.match(prompt, /"ok":\s*true/, "prompt should teach the ok:true response shape");
  assert.match(prompt, /"ok":\s*false/, "prompt should teach the ok:false response shape");

  assert.equal(sessionEndAgent.timeout, 90, "SessionEnd agent hook timeout should be 90s");
});

test("PreCompact agent finalize prompt references required tools and timeout", () => {
  const hooks = loadJson(HOOKS_JSON);
  const preCompactAgent = hooks.hooks.PreCompact[0].hooks[0];
  const prompt = preCompactAgent.prompt;
  assert.match(prompt, /\$ARGUMENTS/);
  assert.match(prompt, /transcript_path/);
  assert.match(prompt, /mcp__clawmem__memory_store/);
  assert.match(prompt, /finalize_success/);
  assert.match(prompt, /finalize_failed/);
  assert.match(prompt, /"PreCompact"/, "PreCompact hook should self-label its event type as PreCompact");

  assert.equal(preCompactAgent.timeout, 90);
});

test("both finalize agent prompts include a Scope restriction section", () => {
  const hooks = loadJson(HOOKS_JSON);
  const sessionEndPrompt = hooks.hooks.SessionEnd[0].hooks[0].prompt;
  const preCompactPrompt = hooks.hooks.PreCompact[0].hooks[0].prompt;

  for (const [label, prompt] of [["SessionEnd", sessionEndPrompt], ["PreCompact", preCompactPrompt]]) {
    assert.match(prompt, /Scope restriction:/, `${label} prompt should declare Scope restriction`);
    assert.match(prompt, /do not explore the repository/i, `${label} prompt should forbid repo exploration`);
    assert.match(prompt, /do not modify code/i, `${label} prompt should forbid code modification`);
    assert.match(prompt, /5[–-]10 tool calls/, `${label} prompt should cap tool-call count`);
  }
});

test("plugin manifest declares summaryWaitTimeoutMs config with correct bounds", () => {
  const manifest = loadJson(PLUGIN_MANIFEST);
  const props = manifest.configSchema.properties;
  assert.ok(props.summaryWaitTimeoutMs, "summaryWaitTimeoutMs missing from configSchema");
  assert.equal(props.summaryWaitTimeoutMs.type, "integer");
  assert.equal(props.summaryWaitTimeoutMs.minimum, 30000);
  assert.equal(props.summaryWaitTimeoutMs.maximum, 600000);

  assert.ok(manifest.uiHints.summaryWaitTimeoutMs, "summaryWaitTimeoutMs missing from uiHints");
});

test("resolveFinalizeTimeoutMs default and env overrides", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawmem-finalize-cfg-"));
  const prevData = process.env.CLAUDE_PLUGIN_DATA;
  const prevEnv1 = process.env.CLAWMEM_FINALIZE_TIMEOUT_MS;
  const prevEnv2 = process.env.CLAUDE_PLUGIN_OPTION_summaryWaitTimeoutMs;
  process.env.CLAUDE_PLUGIN_DATA = tempDir;
  delete process.env.CLAWMEM_FINALIZE_TIMEOUT_MS;
  delete process.env.CLAUDE_PLUGIN_OPTION_summaryWaitTimeoutMs;
  delete require.cache[require.resolve("../lib/config")];

  try {
    const { resolveFinalizeTimeoutMs } = require("../lib/config");
    assert.equal(resolveFinalizeTimeoutMs(), 90_000, "default should be 90000");

    process.env.CLAWMEM_FINALIZE_TIMEOUT_MS = "120000";
    delete require.cache[require.resolve("../lib/config")];
    const r1 = require("../lib/config").resolveFinalizeTimeoutMs();
    assert.equal(r1, 120_000, "env override should apply");

    process.env.CLAWMEM_FINALIZE_TIMEOUT_MS = "10000";
    delete require.cache[require.resolve("../lib/config")];
    const r2 = require("../lib/config").resolveFinalizeTimeoutMs();
    assert.equal(r2, 30_000, "below-minimum should clamp up to 30000");

    process.env.CLAWMEM_FINALIZE_TIMEOUT_MS = "999999";
    delete require.cache[require.resolve("../lib/config")];
    const r3 = require("../lib/config").resolveFinalizeTimeoutMs();
    assert.equal(r3, 600_000, "above-maximum should clamp down to 600000");

    delete process.env.CLAWMEM_FINALIZE_TIMEOUT_MS;
    process.env.CLAUDE_PLUGIN_OPTION_summaryWaitTimeoutMs = "45000";
    delete require.cache[require.resolve("../lib/config")];
    const r4 = require("../lib/config").resolveFinalizeTimeoutMs();
    assert.equal(r4, 45_000, "CLAUDE_PLUGIN_OPTION_summaryWaitTimeoutMs should apply");
  } finally {
    if (prevData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prevData;
    if (prevEnv1 === undefined) delete process.env.CLAWMEM_FINALIZE_TIMEOUT_MS;
    else process.env.CLAWMEM_FINALIZE_TIMEOUT_MS = prevEnv1;
    if (prevEnv2 === undefined) delete process.env.CLAUDE_PLUGIN_OPTION_summaryWaitTimeoutMs;
    else process.env.CLAUDE_PLUGIN_OPTION_summaryWaitTimeoutMs = prevEnv2;
    delete require.cache[require.resolve("../lib/config")];
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

test("lib/events.js exposes the finalize event types used by the agent hook", () => {
  const { EventType } = require("../lib/events");
  assert.equal(EventType.FINALIZE_SUCCESS, "finalize_success");
  assert.equal(EventType.FINALIZE_FAILED, "finalize_failed");
  assert.equal(EventType.FINALIZE_FALLBACK_TRIGGERED, "finalize_fallback_triggered");
});
