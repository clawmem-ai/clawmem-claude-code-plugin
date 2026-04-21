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
  const state = loadState();
  const result = mutator(state) || state;
  saveState(result);
  return result;
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
  statePath
};
