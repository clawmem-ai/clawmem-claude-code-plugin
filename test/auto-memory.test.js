const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  detectMirrorAction,
  extractBashTargets,
  isAutoMemoryPath,
  isMemoryIndexPath,
  looksLikeDeleteCommand,
  parseFrontmatter
} = require("../lib/auto-memory");

const SAMPLE_PATH = "/Users/alice/.claude/projects/-home-alice-proj/memory/user_role.md";

test("isAutoMemoryPath matches only auto-memory files", () => {
  assert.equal(isAutoMemoryPath(SAMPLE_PATH), true);
  assert.equal(isAutoMemoryPath("/Users/alice/.claude/projects/-home-alice-proj/memory/MEMORY.md"), true);
  assert.equal(isAutoMemoryPath("/tmp/unrelated/memory/note.md"), false);
  assert.equal(isAutoMemoryPath("/Users/alice/.claude/projects/-home-alice-proj/other/foo.md"), false);
  assert.equal(isAutoMemoryPath(null), false);
});

test("isMemoryIndexPath detects MEMORY.md", () => {
  assert.equal(isMemoryIndexPath("/x/memory/MEMORY.md"), true);
  assert.equal(isMemoryIndexPath(SAMPLE_PATH), false);
});

test("parseFrontmatter extracts meta and body", () => {
  const { meta, body } = parseFrontmatter(
    "---\nname: user role\ndescription: senior engineer\ntype: user\n---\nSome body text.\n"
  );
  assert.equal(meta.name, "user role");
  assert.equal(meta.description, "senior engineer");
  assert.equal(meta.type, "user");
  assert.equal(body.trim(), "Some body text.");
});

test("parseFrontmatter returns body unchanged without frontmatter", () => {
  const { meta, body } = parseFrontmatter("no frontmatter here");
  assert.deepEqual(meta, {});
  assert.equal(body, "no frontmatter here");
});

test("looksLikeDeleteCommand matches rm invocations", () => {
  assert.equal(looksLikeDeleteCommand(`rm ${SAMPLE_PATH}`), true);
  assert.equal(looksLikeDeleteCommand(`rm -f ${SAMPLE_PATH}`), true);
  assert.equal(looksLikeDeleteCommand("ls -la"), false);
  assert.equal(looksLikeDeleteCommand(""), false);
});

test("extractBashTargets picks only auto-memory paths", () => {
  const cmd = `rm -f ${SAMPLE_PATH} /tmp/other.md`;
  assert.deepEqual(extractBashTargets(cmd), [SAMPLE_PATH]);
});

test("detectMirrorAction returns upsert for successful Write", () => {
  const action = detectMirrorAction({
    tool_name: "Write",
    tool_input: { file_path: SAMPLE_PATH, content: "---\nname: x\n---\nbody\n" },
    tool_response: { success: true }
  });
  assert.equal(action.kind, "upsert");
  assert.equal(action.filePath, SAMPLE_PATH);
  assert.match(action.content, /name: x/);
});

test("detectMirrorAction skips MEMORY.md index writes", () => {
  const action = detectMirrorAction({
    tool_name: "Write",
    tool_input: { file_path: "/x/.claude/projects/p/memory/MEMORY.md", content: "- [a](a.md)" },
    tool_response: { success: true }
  });
  assert.equal(action, null);
});

test("detectMirrorAction ignores non-auto-memory paths", () => {
  const action = detectMirrorAction({
    tool_name: "Write",
    tool_input: { file_path: "/tmp/other.md", content: "hi" },
    tool_response: { success: true }
  });
  assert.equal(action, null);
});

test("detectMirrorAction returns null on failed tool_response", () => {
  const action = detectMirrorAction({
    tool_name: "Write",
    tool_input: { file_path: SAMPLE_PATH, content: "x" },
    tool_response: { success: false, error: "boom" }
  });
  assert.equal(action, null);
});

test("detectMirrorAction for Edit reads post-edit content from disk", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawmem-am-"));
  const nestedDir = path.join(tempDir, ".claude", "projects", "p", "memory");
  fs.mkdirSync(nestedDir, { recursive: true });
  const filePath = path.join(nestedDir, "feedback_x.md");
  fs.writeFileSync(filePath, "---\nname: feedback_x\n---\nnew body\n");
  const action = detectMirrorAction({
    tool_name: "Edit",
    tool_input: { file_path: filePath, old_string: "old", new_string: "new" },
    tool_response: { success: true }
  });
  assert.equal(action.kind, "upsert");
  assert.equal(action.filePath, filePath);
  assert.match(action.content, /new body/);
});

test("detectMirrorAction returns delete for Bash rm on auto-memory path", () => {
  const action = detectMirrorAction({
    tool_name: "Bash",
    tool_input: { command: `rm -f ${SAMPLE_PATH}` },
    tool_response: { success: true }
  });
  assert.equal(action.kind, "delete");
  assert.deepEqual(action.paths, [SAMPLE_PATH]);
});

test("detectMirrorAction ignores non-rm Bash commands", () => {
  const action = detectMirrorAction({
    tool_name: "Bash",
    tool_input: { command: `cat ${SAMPLE_PATH}` },
    tool_response: { success: true }
  });
  assert.equal(action, null);
});
