const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("state file and dir get restrictive permissions on POSIX", () => {
  if (process.platform === "win32") return;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawmem-state-perm-"));
  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tempDir;
  delete require.cache[require.resolve("../lib/config")];
  delete require.cache[require.resolve("../lib/state")];
  try {
    const { saveState, statePath } = require("../lib/state");
    saveState({ version: 1, route: null, sessions: {} });
    const file = statePath();
    const fileMode = fs.statSync(file).mode & 0o777;
    const dirMode = fs.statSync(path.dirname(file)).mode & 0o777;
    assert.equal(fileMode, 0o600);
    assert.equal(dirMode, 0o700);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;
    delete require.cache[require.resolve("../lib/config")];
    delete require.cache[require.resolve("../lib/state")];
  }
});
