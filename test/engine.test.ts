import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { test } from "node:test";
import { applyChanges, formatFileBlocks, parseFileBlocks, safeRelativePath } from "../src/engine/files.js";
import { assignRoles, editSite, extractJson, forgeSite, type ForgeEvent } from "../src/engine/forge.js";
import { createMockProvider } from "../src/providers/mock.js";
import type { Provider } from "../src/providers/types.js";
import { createZip } from "../src/zip.js";

test("parses file blocks, strips stray fences, and ignores unsafe paths", () => {
  const output = `Here you go:
<<<FILE path="server.js">>>
console.log("hi");
<<<END FILE>>>
<<<FILE path="public/app.js">>>
\`\`\`js
export const x = 1;
\`\`\`
<<<END FILE>>>
<<<FILE path="../../etc/passwd">>>
nope
<<<END FILE>>>
<<<DELETE path="old.js">>>`;
  const { files, deleted } = parseFileBlocks(output);
  assert.deepEqual([...files.keys()], ["server.js", "public/app.js"]);
  assert.equal(files.get("public/app.js"), "export const x = 1;");
  assert.deepEqual(deleted, ["old.js"]);
});

test("rejects paths outside the project", () => {
  assert.equal(safeRelativePath("/abs/file"), null);
  assert.equal(safeRelativePath("a/../../b"), null);
  assert.equal(safeRelativePath("C:/win"), null);
  assert.equal(safeRelativePath("node_modules/x.js"), null);
  assert.equal(safeRelativePath("./public/index.html"), "public/index.html");
});

test("file blocks round-trip and changes apply", () => {
  const files = new Map([["a.txt", "one"], ["b.txt", "two"]]);
  const parsed = parseFileBlocks(formatFileBlocks(files));
  assert.deepEqual(parsed.files, files);
  const next = applyChanges(files, { files: new Map([["c.txt", "three"]]), deleted: ["a.txt"] });
  assert.deepEqual([...next.keys()].sort(), ["b.txt", "c.txt"]);
});

test("extracts JSON wrapped in prose or fences", () => {
  assert.deepEqual(extractJson('Sure!\n```json\n{"a": {"b": 1}}\n```'), { a: { b: 1 } });
  assert.throws(() => extractJson("no json here"));
});

test("assigns Claude to build and other models to plan and review", () => {
  const fake = (id: Provider["id"]): Provider => ({ id, label: id, model: id, generate: async () => "" });
  const roles = assignRoles([fake("gemini"), fake("openai"), fake("anthropic")]);
  assert.equal(roles.builder.id, "anthropic");
  assert.equal(roles.planner.id, "openai");
  assert.deepEqual(roles.reviewers.map((r) => r.id), ["openai", "gemini"]);
  const solo = assignRoles([fake("gemini")]);
  assert.equal(solo.builder.id, "gemini");
  assert.deepEqual(solo.reviewers.map((r) => r.id), ["gemini"]);
  assert.throws(() => assignRoles([]));
});

test("zip output contains the files", () => {
  const zip = createZip([{ path: "site/index.html", content: "<h1>Hello</h1>" }]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  const nameLength = zip.readUInt16LE(26);
  const size = zip.readUInt32LE(18);
  const data = zip.subarray(30 + nameLength, 30 + nameLength + size);
  assert.equal(inflateRawSync(data).toString(), "<h1>Hello</h1>");
});

test("full pipeline with the demo model: builds, catches a broken link, fixes it, and passes", { timeout: 180_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openforge-test-"));
  try {
    const events: ForgeEvent[] = [];
    const roles = assignRoles([createMockProvider()]);
    const result = await forgeSite("A website for my bakery", { roles, dir, onEvent: (e) => events.push(e) });

    const verifies = events.filter((e): e is Extract<ForgeEvent, { type: "verify" }> => e.type === "verify");
    assert.equal(verifies[0].result.ok, false, "the first build has a broken link");
    assert.ok(result.verify.ok, `final checks should pass: ${result.verify.problems.join("; ")}`);
    assert.ok(result.files.has("public/menu.html"));
    assert.ok(result.verify.checks.some((c) => c.name === "Page /contact loads" && c.ok));

    const edited = await editSite("Make it dark", result.plan, result.files, { roles, dir });
    assert.ok(edited.verify.ok);
    assert.match(edited.files.get("public/styles.css") ?? "", /Make it dark/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
