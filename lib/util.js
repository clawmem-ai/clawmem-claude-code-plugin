const crypto = require("node:crypto");

function nowIso() {
  return new Date().toISOString();
}

function todayIsoDate() {
  return nowIso().slice(0, 10);
}

function slugify(input, fallback = "item") {
  const value = String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return value || fallback;
}

function sha256(input) {
  return crypto.createHash("sha256").update(String(input || ""), "utf8").digest("hex");
}

function clip(input, max = 240) {
  const text = String(input || "");
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function yamlBlock(value, indent = 2) {
  const pad = " ".repeat(indent);
  const lines = String(value || "").replace(/\r\n/g, "\n").split("\n");
  if (lines.length === 0) return `${pad}|-\n`;
  return `${pad}|-\n${lines.map((line) => `${pad}${pad}${line}`).join("\n")}\n`;
}

function json(value) {
  return JSON.stringify(value, null, 2);
}

module.exports = {
  clip,
  json,
  nowIso,
  sha256,
  slugify,
  todayIsoDate,
  yamlBlock
};
