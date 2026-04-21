const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const github = require("../lib/github");

function startMockServer(handler) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const reply = handler(req, body) || { status: 404, body: "{}" };
      res.writeHead(reply.status, { "Content-Type": "application/json", ...(reply.headers || {}) });
      res.end(reply.body || "");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("storeMemory deduplicates on sha256 and merges topics", async () => {
  const calls = [];
  const existingIssue = {
    number: 42,
    title: "Memory: something",
    body: "type: memory\nmemory_hash: ABCD\n",
    state: "open",
    labels: [{ name: "type:memory" }, { name: "topic:alpha" }]
  };
  const server = await startMockServer((req, body) => {
    calls.push({ method: req.method, url: req.url, body });
    if (req.method === "GET" && req.url.startsWith("/api/v3/search/issues")) {
      return { status: 200, body: JSON.stringify({ items: [existingIssue] }) };
    }
    if (req.method === "GET" && req.url === "/api/v3/repos/tester/memory/issues/42") {
      return { status: 200, body: JSON.stringify(existingIssue) };
    }
    if (req.method === "POST" && req.url === "/api/v3/repos/tester/memory/labels") {
      return { status: 201, body: "{}" };
    }
    if (req.method === "PATCH" && req.url === "/api/v3/repos/tester/memory/issues/42") {
      return { status: 200, body: JSON.stringify(existingIssue) };
    }
    return { status: 404, body: "{}" };
  });
  try {
    const { port } = server.address();
    const route = { baseUrl: `http://127.0.0.1:${port}/api/v3`, authScheme: "token", token: "t" };
    // First, stub sha256 by computing the same detail; our findActiveMemoryByHash matches if body contains the hash substring.
    // Arrange: make body include the computed hash of detail.
    const crypto = require("node:crypto");
    const detail = "remember pingcap coding style";
    const hash = crypto.createHash("sha256").update(detail).digest("hex");
    existingIssue.body = `type: memory\nmemory_hash: ${hash}\n`;
    const result = await github.storeMemory(route, "tester/memory", {
      detail,
      topics: ["beta"]
    });
    assert.equal(result.created, false);
    assert.equal(result.issue.number, 42);
    const patches = calls.filter((c) => c.method === "PATCH");
    assert.equal(patches.length, 1, "expected a PATCH to merge labels");
    const patchBody = JSON.parse(patches[0].body);
    assert.ok(patchBody.labels.includes("topic:alpha"));
    assert.ok(patchBody.labels.includes("topic:beta"));
    assert.ok(patchBody.labels.includes("type:memory"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("updateMemory rejects hash collision with another active memory", async () => {
  const crypto = require("node:crypto");
  const nextDetail = "shared secret";
  const nextHash = crypto.createHash("sha256").update(nextDetail).digest("hex");

  const currentIssue = {
    number: 10,
    title: "Memory: old",
    body: "type: memory\nmemory_hash: old-hash\ndetail: |-\n  old thing\n",
    state: "open",
    labels: [{ name: "type:memory" }]
  };
  const duplicateIssue = {
    number: 11,
    title: "Memory: dupe",
    body: `type: memory\nmemory_hash: ${nextHash}\n`,
    state: "open",
    labels: [{ name: "type:memory" }]
  };

  const server = await startMockServer((req) => {
    if (req.method === "GET" && req.url === "/api/v3/repos/tester/memory/issues/10") {
      return { status: 200, body: JSON.stringify(currentIssue) };
    }
    if (req.method === "GET" && req.url.startsWith("/api/v3/search/issues")) {
      return { status: 200, body: JSON.stringify({ items: [duplicateIssue] }) };
    }
    return { status: 404, body: "{}" };
  });
  try {
    const { port } = server.address();
    const route = { baseUrl: `http://127.0.0.1:${port}/api/v3`, authScheme: "token", token: "t" };
    await assert.rejects(
      () => github.updateMemory(route, "tester/memory", 10, { detail: nextDetail }),
      /Another active memory already stores this detail as #11/
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("addIssueLabels ensures labels then POSTs additive labels", async () => {
  const calls = [];
  const server = await startMockServer((req, body) => {
    calls.push({ method: req.method, url: req.url, body });
    if (req.method === "POST" && req.url === "/api/v3/repos/tester/memory/labels") {
      return { status: 201, body: "{}" };
    }
    if (req.method === "POST" && req.url === "/api/v3/repos/tester/memory/issues/42/labels") {
      return { status: 200, body: "[]" };
    }
    return { status: 404, body: "{}" };
  });
  try {
    const { port } = server.address();
    const route = { baseUrl: `http://127.0.0.1:${port}/api/v3`, authScheme: "token", token: "t" };
    await github.addIssueLabels(route, "tester/memory", 42, ["agent:abc123", "agent-type:general-purpose"]);
    const ensureCalls = calls.filter((c) => c.url === "/api/v3/repos/tester/memory/labels" && c.method === "POST");
    assert.equal(ensureCalls.length, 2, "ensureLabels should be called per label");
    const addCall = calls.find((c) => c.url === "/api/v3/repos/tester/memory/issues/42/labels");
    assert.ok(addCall, "expected POST to issues/42/labels");
    assert.deepEqual(JSON.parse(addCall.body).labels, ["agent:abc123", "agent-type:general-purpose"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("addIssueLabels is a no-op when labels array is empty", async () => {
  const calls = [];
  const server = await startMockServer((req, body) => {
    calls.push({ method: req.method, url: req.url, body });
    return { status: 404, body: "{}" };
  });
  try {
    const { port } = server.address();
    const route = { baseUrl: `http://127.0.0.1:${port}/api/v3`, authScheme: "token", token: "t" };
    const result = await github.addIssueLabels(route, "tester/memory", 42, []);
    assert.equal(result, null);
    assert.equal(calls.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("forgetMemory calls syncManagedLabels before closing", async () => {
  const calls = [];
  const issue = {
    number: 7,
    title: "Memory: thing",
    body: "type: memory\n",
    state: "open",
    labels: [{ name: "type:memory" }, { name: "topic:foo" }, { name: "priority:high" }]
  };
  const server = await startMockServer((req, body) => {
    calls.push({ method: req.method, url: req.url, body });
    if (req.method === "GET" && req.url === "/api/v3/repos/tester/memory/issues/7") {
      return { status: 200, body: JSON.stringify(issue) };
    }
    if (req.method === "POST" && req.url === "/api/v3/repos/tester/memory/labels") {
      return { status: 201, body: "{}" };
    }
    if (req.method === "PATCH" && req.url === "/api/v3/repos/tester/memory/issues/7") {
      return { status: 200, body: JSON.stringify(issue) };
    }
    return { status: 404, body: "{}" };
  });
  try {
    const { port } = server.address();
    const route = { baseUrl: `http://127.0.0.1:${port}/api/v3`, authScheme: "token", token: "t" };
    await github.forgetMemory(route, "tester/memory", 7);
    const patches = calls.filter((c) => c.method === "PATCH");
    assert.equal(patches.length, 2, "expected label sync PATCH then close PATCH");
    const labelPatch = JSON.parse(patches[0].body);
    assert.ok(labelPatch.labels.includes("type:memory"));
    assert.ok(labelPatch.labels.includes("topic:foo"));
    assert.ok(labelPatch.labels.includes("priority:high"));
    const closePatch = JSON.parse(patches[1].body);
    assert.equal(closePatch.state, "closed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
