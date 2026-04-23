const fs = require("node:fs");
const path = require("node:path");
const { eventLogPath, pluginDataDir } = require("./config");
const { nowIso } = require("./util");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  if (process.platform !== "win32") {
    try { fs.chmodSync(dirPath, 0o700); } catch {}
  }
}

function statePath() {
  return path.join(pluginDataDir(), "state.json");
}

function lockPath() {
  return `${statePath()}.lock`;
}

const LOCK_BACKOFFS_MS = [50, 100, 200, 400, 800, 1600];
const STALE_LOCK_MS = 2_500;

function sleepSync(ms) {
  const end = Date.now() + ms;
  // Atomics.wait on a private buffer blocks the thread without spinning the event loop.
  try {
    const sab = new SharedArrayBuffer(4);
    const ia = new Int32Array(sab);
    Atomics.wait(ia, 0, 0, ms);
    if (Date.now() >= end) return;
  } catch {}
  while (Date.now() < end) {}
}

function tryCreateLock(p) {
  const fd = fs.openSync(p, "wx");
  if (process.platform !== "win32") {
    try { fs.fchmodSync(fd, 0o600); } catch {}
  }
  return fd;
}

function acquireLock() {
  ensureDir(pluginDataDir());
  const p = lockPath();
  let lastErr = null;
  for (let attempt = 0; attempt <= LOCK_BACKOFFS_MS.length; attempt += 1) {
    try {
      return tryCreateLock(p);
    } catch (err) {
      lastErr = err;
      if (err && err.code !== "EEXIST") throw err;
      let cleaned = false;
      try {
        const st = fs.statSync(p);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          try { fs.unlinkSync(p); cleaned = true; } catch {}
        }
      } catch (statErr) {
        if (statErr && statErr.code === "ENOENT") cleaned = true;
      }
      if (cleaned) {
        try { return tryCreateLock(p); } catch (retryErr) {
          lastErr = retryErr;
          if (retryErr && retryErr.code !== "EEXIST") throw retryErr;
        }
      }
      if (attempt === LOCK_BACKOFFS_MS.length) break;
      sleepSync(LOCK_BACKOFFS_MS[attempt]);
    }
  }
  const e = new Error(`clawmem: could not acquire state lock at ${p}`);
  if (lastErr) e.cause = lastErr;
  throw e;
}

function releaseLock(fd) {
  try { fs.closeSync(fd); } catch {}
  try { fs.unlinkSync(lockPath()); } catch {}
}

function withStateLock(fn) {
  const fd = acquireLock();
  try {
    return fn();
  } finally {
    releaseLock(fd);
  }
}

function defaultState() {
  return {
    version: 1,
    route: null,
    sessions: {},
    autoMemoryMirror: {}
  };
}

function loadState() {
  ensureDir(pluginDataDir());
  const file = statePath();
  if (!fs.existsSync(file)) return defaultState();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      sessions: parsed && typeof parsed.sessions === "object" && parsed.sessions ? parsed.sessions : {},
      autoMemoryMirror: parsed && typeof parsed.autoMemoryMirror === "object" && parsed.autoMemoryMirror ? parsed.autoMemoryMirror : {}
    };
  } catch {
    return defaultState();
  }
}

function saveState(nextState) {
  ensureDir(pluginDataDir());
  const file = statePath();
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(nextState, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
  if (process.platform !== "win32") {
    try { fs.chmodSync(file, 0o600); } catch {}
  }
}

function mutateState(mutator) {
  return withStateLock(() => {
    const state = loadState();
    const result = mutator(state) || state;
    saveState(result);
    return result;
  });
}

function appendEvent(event) {
  const file = eventLogPath();
  ensureDir(path.dirname(file));
  fs.appendFileSync(
    file,
    `${JSON.stringify({ ts: nowIso(), ...event })}\n`,
    "utf8"
  );
}

module.exports = {
  appendEvent,
  defaultState,
  ensureDir,
  loadState,
  mutateState,
  saveState,
  statePath,
  withStateLock
};
