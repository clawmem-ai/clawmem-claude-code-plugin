const test = require("node:test");
const assert = require("node:assert/strict");

const { deriveConsoleBaseUrl, normalizeApiBaseUrl, resolveBaseUrl, resolveConsoleBaseUrl } = require("../lib/config");

test("normalizeApiBaseUrl defaults to the hosted ClawMem API", () => {
  assert.equal(normalizeApiBaseUrl(""), "https://git.clawmem.ai/api/v3");
});

test("normalizeApiBaseUrl appends /api/v3 when missing", () => {
  assert.equal(normalizeApiBaseUrl("http://127.0.0.1:4003"), "http://127.0.0.1:4003/api/v3");
});

test("normalizeApiBaseUrl preserves existing /api/v3 suffix", () => {
  assert.equal(normalizeApiBaseUrl("http://127.0.0.1:4003/api/v3"), "http://127.0.0.1:4003/api/v3");
});

test("deriveConsoleBaseUrl maps git.<host> to console.<host>", () => {
  assert.equal(deriveConsoleBaseUrl("https://git.clawmem.ai/api/v3"), "https://console.clawmem.ai");
  assert.equal(deriveConsoleBaseUrl("https://git.staging.clawmem.ai/api/v3"), "https://console.staging.clawmem.ai");
});

test("deriveConsoleBaseUrl falls back to localhost:5173 for loopback", () => {
  assert.equal(deriveConsoleBaseUrl("http://127.0.0.1:4003/api/v3"), "http://localhost:5173");
  assert.equal(deriveConsoleBaseUrl("http://localhost:4003/api/v3"), "http://localhost:5173");
});

test("resolveConsoleBaseUrl honors CLAWMEM_CONSOLE_BASE_URL override", () => {
  const prev = process.env.CLAWMEM_CONSOLE_BASE_URL;
  process.env.CLAWMEM_CONSOLE_BASE_URL = "https://c.example.com/";
  try {
    assert.equal(resolveConsoleBaseUrl(), "https://c.example.com");
  } finally {
    if (prev === undefined) delete process.env.CLAWMEM_CONSOLE_BASE_URL;
    else process.env.CLAWMEM_CONSOLE_BASE_URL = prev;
  }
});

test("resolveBaseUrl accepts CLAWMEM_GIT_BASE_URL and normalizes it", () => {
  const previousBase = process.env.CLAWMEM_BASE_URL;
  const previous = process.env.CLAWMEM_GIT_BASE_URL;
  delete process.env.CLAWMEM_BASE_URL;
  process.env.CLAWMEM_GIT_BASE_URL = "https://git.clawmem.ai";

  try {
    assert.equal(resolveBaseUrl(), "https://git.clawmem.ai/api/v3");
  } finally {
    if (previousBase === undefined) {
      delete process.env.CLAWMEM_BASE_URL;
    } else {
      process.env.CLAWMEM_BASE_URL = previousBase;
    }
    if (previous === undefined) {
      delete process.env.CLAWMEM_GIT_BASE_URL;
    } else {
      process.env.CLAWMEM_GIT_BASE_URL = previous;
    }
  }
});
