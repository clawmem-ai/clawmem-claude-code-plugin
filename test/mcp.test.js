const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"),
    body
  ]);
}

function createClient(child) {
  let buffer = Buffer.alloc(0);
  const pending = new Map();

  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const headerText = buffer.slice(0, headerEnd).toString("utf8");
      const match = headerText.match(/Content-Length:\s*(\d+)/i);
      assert.ok(match, "missing Content-Length header");
      const contentLength = Number(match[1]);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;
      if (buffer.length < messageEnd) return;
      const body = JSON.parse(buffer.slice(messageStart, messageEnd).toString("utf8"));
      buffer = buffer.slice(messageEnd);
      const resolve = pending.get(body.id);
      if (resolve) {
        pending.delete(body.id);
        resolve(body);
      }
    }
  });

  let nextId = 1;
  return {
    call(method, params) {
      const id = nextId++;
      child.stdin.write(encodeMessage({ jsonrpc: "2.0", id, method, params }));
      return new Promise((resolve) => pending.set(id, resolve));
    }
  };
}

test("mcp server lists tools", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawmem-mcp-list-"));
  const child = spawn("node", ["mcp/server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: tempDir
    },
    stdio: ["pipe", "pipe", "inherit"]
  });

  try {
    const client = createClient(child);
    const init = await client.call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } });
    assert.equal(init.result.serverInfo.name, "clawmem");
    const list = await client.call("tools/list", {});
    const names = list.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "collaboration_admin_invoke",
      "collaboration_org_invitation_create",
      "collaboration_repo_access_inspect",
      "collaboration_repo_collaborator_remove",
      "collaboration_repo_collaborator_set",
      "collaboration_repo_collaborators",
      "collaboration_repo_invitations",
      "collaboration_team",
      "collaboration_team_members",
      "collaboration_team_membership_remove",
      "collaboration_team_membership_set",
      "collaboration_team_repo_remove",
      "collaboration_team_repo_set",
      "collaboration_team_repos",
      "collaboration_teams",
      "collaboration_user_org_invitation_accept",
      "collaboration_user_org_invitation_decline",
      "collaboration_user_org_invitations",
      "collaboration_user_repo_invitation_accept",
      "collaboration_user_repo_invitation_decline",
      "collaboration_user_repo_invitations",
      "issue_comment_add",
      "issue_comments_list",
      "issue_create",
      "issue_get",
      "issue_list",
      "issue_update",
      "memory_console",
      "memory_forget",
      "memory_get",
      "memory_labels",
      "memory_list",
      "memory_recall",
      "memory_repo_create",
      "memory_repo_set_default",
      "memory_repos",
      "memory_store",
      "memory_update"
    ]);
  } finally {
    child.kill("SIGTERM");
  }
});

test("mcp memory_list call works against a mock backend", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawmem-mcp-call-"));
  fs.writeFileSync(
    path.join(tempDir, "state.json"),
    JSON.stringify({
      version: 1,
      route: {
        baseUrl: "http://127.0.0.1:4017/api/v3",
        authScheme: "token",
        login: "tester",
        token: "secret",
        defaultRepo: "tester/memory"
      },
      sessions: {}
    })
  );

  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/api/v3/repos/tester/memory/issues")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(4017, "127.0.0.1", resolve));

  const child = spawn("node", ["mcp/server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: tempDir
    },
    stdio: ["pipe", "pipe", "inherit"]
  });

  try {
    const client = createClient(child);
    await client.call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } });
    const result = await client.call("tools/call", {
      name: "memory_list",
      arguments: {
        state: "open",
        limit: 5
      }
    });
    assert.match(result.result.content[0].text, /No memories found in tester\/memory/);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => server.close(resolve));
  }
});
