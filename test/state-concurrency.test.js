const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fork } = require("node:child_process");

function makeTempDataDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `clawmem-wave0-${tag}-`));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function freshStateModule(dataDir) {
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  delete require.cache[require.resolve("../lib/config")];
  delete require.cache[require.resolve("../lib/state")];
  return require("../lib/state");
}

test("mutateState serializes concurrent writes across processes", { timeout: 30_000 }, async () => {
  const dataDir = makeTempDataDir("concurrency");
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  const workerPath = path.join(__dirname, "state-concurrency.worker.js");
  const childEnv = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, CLAWMEM_WORKER_ITERATIONS: "20" };
  const workerCount = 10;

  try {
    const children = Array.from({ length: workerCount }, () =>
      fork(workerPath, [], { env: childEnv, stdio: ["ignore", "pipe", "pipe", "ipc"] })
    );

    const exits = children.map(
      (child) =>
        new Promise((resolve, reject) => {
          child.on("error", reject);
          child.on("exit", (code, signal) => {
            if (signal) reject(new Error(`worker killed by signal ${signal}`));
            else if (code !== 0) reject(new Error(`worker exited with code ${code}`));
            else resolve();
          });
        })
    );

    await Promise.all(exits);

    const { loadState } = freshStateModule(dataDir);
    const state = loadState();
    assert.equal(state.concurrencyCounter, workerCount * 20);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
    delete require.cache[require.resolve("../lib/config")];
    delete require.cache[require.resolve("../lib/state")];
    cleanup(dataDir);
  }
});

test("mutateState preserves single-process semantics", () => {
  const dataDir = makeTempDataDir("serial");
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  try {
    const { mutateState, loadState } = freshStateModule(dataDir);
    for (let i = 0; i < 10; i += 1) {
      mutateState((s) => {
        s.serialCounter = (s.serialCounter || 0) + 1;
      });
    }
    const state = loadState();
    assert.equal(state.serialCounter, 10);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
    delete require.cache[require.resolve("../lib/config")];
    delete require.cache[require.resolve("../lib/state")];
    cleanup(dataDir);
  }
});
