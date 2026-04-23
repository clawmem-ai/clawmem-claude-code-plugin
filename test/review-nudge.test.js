const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PLUGIN_ROOT = path.resolve(__dirname, "..");

function startMockBackend(port) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c.toString("utf8"); });
    req.on("end", () => {
      // Issue creation → return a fake issue number.
      if (req.method === "POST" && req.url.includes("/issues") && !req.url.includes("/comments")) {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ number: 42, title: "stub", body: "", labels: [] }));
        return;
      }
      // Comment creation.
      if (req.method === "POST" && req.url.includes("/comments")) {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: 1 }));
        return;
      }
      // Issue PATCH (body/label updates) or event POST or label PUT.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

function writeTranscript(dir, entries) {
  const p = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return p;
}

function makeTempDataDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `clawmem-review-${tag}-`));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function seedState(dataDir, sessions, opts = {}) {
  const baseUrl = opts.baseUrl || "http://127.0.0.1:1/api/v3";
  const statePath = path.join(dataDir, "state.json");
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      route: {
        baseUrl,
        authScheme: "token",
        login: "tester",
        token: "secret",
        defaultRepo: "tester/memory"
      },
      sessions: sessions || {},
      autoMemoryMirror: {}
    })
  );
}

function loadStateFile(dataDir) {
  const raw = fs.readFileSync(path.join(dataDir, "state.json"), "utf8");
  return JSON.parse(raw);
}

function runHook(hookRelPath, stdinObj, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(PLUGIN_ROOT, hookRelPath)], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(stdinObj));
  });
}

test("user-prompt-submit injects review-nudge only when turnsSinceReview >= interval", async () => {
  const dataDir = makeTempDataDir("nudge");
  try {
    // Case 1: below interval → no nudge
    seedState(dataDir, { s1: { nextTurnId: 1, turnsSinceReview: 5 } });
    let result = await runHook("hooks/user-prompt-submit.js", { session_id: "s1", prompt: "hello" }, {
      CLAUDE_PLUGIN_DATA: dataDir,
      CLAWMEM_REVIEW_NUDGE_INTERVAL: "10"
    });
    assert.equal(result.code, 0, `hook exit code: ${result.code}, stderr: ${result.stderr}`);
    assert.doesNotMatch(result.stdout, /<clawmem-review-nudge>/);

    // Case 2: at interval → nudge fires
    seedState(dataDir, { s1: { nextTurnId: 1, turnsSinceReview: 10 } });
    result = await runHook("hooks/user-prompt-submit.js", { session_id: "s1", prompt: "hello" }, {
      CLAUDE_PLUGIN_DATA: dataDir,
      CLAWMEM_REVIEW_NUDGE_INTERVAL: "10"
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /<clawmem-review-nudge>/);
    assert.match(result.stdout, /mcp__clawmem__memory_review/);

    // Case 3: above interval → nudge still fires
    seedState(dataDir, { s1: { nextTurnId: 1, turnsSinceReview: 25 } });
    result = await runHook("hooks/user-prompt-submit.js", { session_id: "s1", prompt: "hello" }, {
      CLAUDE_PLUGIN_DATA: dataDir,
      CLAWMEM_REVIEW_NUDGE_INTERVAL: "10"
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /<clawmem-review-nudge>/);

    // Case 4: interval = 0 → disabled, never fires
    seedState(dataDir, { s1: { nextTurnId: 1, turnsSinceReview: 99 } });
    result = await runHook("hooks/user-prompt-submit.js", { session_id: "s1", prompt: "hello" }, {
      CLAUDE_PLUGIN_DATA: dataDir,
      CLAWMEM_REVIEW_NUDGE_INTERVAL: "0"
    });
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.stdout, /<clawmem-review-nudge>/);
  } finally {
    cleanup(dataDir);
  }
});

test("post-tool-use resets turnsSinceReview when mcp__clawmem__memory_review fires", async () => {
  const dataDir = makeTempDataDir("reset");
  try {
    seedState(dataDir, { s2: { nextTurnId: 1, turnsSinceReview: 12 } });
    const result = await runHook(
      "hooks/post-tool-use.js",
      { session_id: "s2", tool_name: "mcp__clawmem__memory_review", tool_input: {}, tool_response: {} },
      { CLAUDE_PLUGIN_DATA: dataDir }
    );
    assert.equal(result.code, 0, `hook exit code: ${result.code}, stderr: ${result.stderr}`);
    const state = loadStateFile(dataDir);
    assert.equal(state.sessions.s2.turnsSinceReview, 0);
  } finally {
    cleanup(dataDir);
  }
});

test("post-tool-use does not reset for unrelated tool calls", async () => {
  const dataDir = makeTempDataDir("noreset");
  try {
    seedState(dataDir, { s3: { nextTurnId: 1, turnsSinceReview: 7 } });
    const result = await runHook(
      "hooks/post-tool-use.js",
      { session_id: "s3", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { stdout: "" } },
      { CLAUDE_PLUGIN_DATA: dataDir }
    );
    assert.equal(result.code, 0);
    const state = loadStateFile(dataDir);
    assert.equal(state.sessions.s3.turnsSinceReview, 7);
  } finally {
    cleanup(dataDir);
  }
});

test("stop hook increments turnsSinceReview by exactly 1 per Stop with any new turns", async () => {
  const dataDir = makeTempDataDir("stopcount");
  const port = 4031;
  const server = await startMockBackend(port);
  try {
    // Case A: mixed-role transcript → counter +1.
    seedState(dataDir, { s4: { nextTurnId: 1, turnsSinceReview: 0 } }, {
      baseUrl: `http://127.0.0.1:${port}/api/v3`
    });
    const transcriptMixed = writeTranscript(dataDir, [
      { type: "user", message: { content: "hello" } },
      { type: "assistant", message: { content: "hi" } }
    ]);
    let result = await runHook(
      "hooks/stop.js",
      { session_id: "s4", transcript_path: transcriptMixed },
      { CLAUDE_PLUGIN_DATA: dataDir }
    );
    assert.equal(result.code, 0, `mixed-role Stop failed: ${result.stderr}`);
    let state = loadStateFile(dataDir);
    assert.equal(state.sessions.s4.turnsSinceReview, 1, "mixed Stop should bump by 1");

    // Case B: next Stop with ASSISTANT-ONLY new turn → counter still +1 (new openclaw-aligned semantics).
    // Seed transcript already has both turns mirrored (cursor=2); add one assistant-only turn.
    const transcriptAssistantOnly = writeTranscript(dataDir, [
      { type: "user", message: { content: "hello" } },
      { type: "assistant", message: { content: "hi" } },
      { type: "assistant", message: { content: "follow-up from assistant" } }
    ]);
    result = await runHook(
      "hooks/stop.js",
      { session_id: "s4", transcript_path: transcriptAssistantOnly },
      { CLAUDE_PLUGIN_DATA: dataDir }
    );
    assert.equal(result.code, 0, `assistant-only Stop failed: ${result.stderr}`);
    state = loadStateFile(dataDir);
    assert.equal(
      state.sessions.s4.turnsSinceReview,
      2,
      "assistant-only Stop should still bump by 1 (openclaw-aligned)"
    );

    // Case C: Stop with empty transcript → early return, counter unchanged.
    const transcriptEmpty = writeTranscript(dataDir, []);
    result = await runHook(
      "hooks/stop.js",
      { session_id: "s4", transcript_path: transcriptEmpty },
      { CLAUDE_PLUGIN_DATA: dataDir }
    );
    assert.equal(result.code, 0, `empty-transcript Stop failed: ${result.stderr}`);
    state = loadStateFile(dataDir);
    assert.equal(
      state.sessions.s4.turnsSinceReview,
      2,
      "Stop with empty transcript (early-return path) should not bump counter"
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanup(dataDir);
  }
});
