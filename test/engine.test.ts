import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { test } from "node:test";
import { applyChanges, formatFileBlocks, parseFileBlocks, safeRelativePath } from "../src/engine/files.js";
import { assignRoles, editSite, extractJson, forgeSite, type ForgeEvent } from "../src/engine/forge.js";
import { createMockProvider } from "../src/providers/mock.js";
import type { Connection, Provider } from "../src/providers/types.js";
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

test("assigns Claude to build and other models to plan and review, unless the user picks", () => {
  const fake = (kind: Connection["kind"], id: string = kind, local = false): Provider => ({
    connection: { id, kind, name: id, local },
    kind,
    label: id,
    model: id,
    generate: async () => ({ text: "", model: id, usage: { inputTokens: 0, outputTokens: 0 } }),
  });
  const roles = assignRoles([fake("compatible", "ollama", true), fake("gemini"), fake("openai"), fake("anthropic"), fake("compatible", "openrouter")]);
  assert.equal(roles.builder.connection.id, "anthropic");
  assert.equal(roles.planner.connection.id, "openai");
  assert.deepEqual(roles.reviewers.map((r) => r.connection.id), ["openai", "gemini", "openrouter"]);

  const picked = assignRoles([fake("anthropic"), fake("gemini")], { builder: "gemini", planner: "gemini" });
  assert.equal(picked.builder.connection.id, "gemini");
  assert.equal(picked.planner.connection.id, "gemini");
  assert.deepEqual(picked.reviewers.map((r) => r.connection.id), ["anthropic"]);

  const solo = assignRoles([fake("gemini")]);
  assert.equal(solo.builder.connection.id, "gemini");
  assert.deepEqual(solo.reviewers.map((r) => r.connection.id), ["gemini"]);
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

    const usage = events.filter((e) => e.type === "usage");
    assert.ok(usage.length >= 4, "every AI call reports usage");
    assert.ok(usage.every((e) => e.type === "usage" && e.call.outputTokens > 0 && e.call.cost === 0));

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

test("when a model runs out of credit mid-build, the next model takes over and the build finishes", { timeout: 180_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openforge-test-"));
  try {
    // A real-looking model backed by the demo output, so the build can finish.
    const working = (kind: Connection["kind"], id: string): Provider => {
      const mock = createMockProvider();
      return { ...mock, connection: { id, kind, name: id }, kind, label: id };
    };
    const broke: Provider = {
      ...working("anthropic", "claude"),
      generate: async () => {
        throw Object.assign(
          new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'),
          { status: 400 },
        );
      },
    };
    const events: ForgeEvent[] = [];
    const roles = assignRoles([broke, working("openai", "gpt"), working("gemini", "gemini"), createMockProvider()]);
    assert.equal(roles.builder.label, "claude");
    const result = await forgeSite("A website for my bakery", { roles, dir, onEvent: (e) => events.push(e) });
    assert.ok(result.verify.ok);

    const switches = events.filter((e): e is Extract<ForgeEvent, { type: "switch" }> => e.type === "switch");
    assert.equal(switches.length, 1, "the broken model is only tried once");
    assert.equal(switches[0].problem, "credit");
    assert.equal(switches[0].to, "gpt");
    assert.equal(roles.builder.label, "gpt");
    assert.ok(!roles.reviewers.includes(roles.builder), "the new builder doesn't review its own code");
    assert.ok(events.some((e) => e.type === "usage" && e.call.role === "builder" && e.call.connectionId === "gpt"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a build fails with a clear message only when every model has failed", async () => {
  const dead = (id: string, status: number, message: string): Provider => ({
    connection: { id, kind: "openai", name: id },
    kind: "openai",
    label: id,
    model: id,
    generate: async () => {
      throw Object.assign(new Error(message), { status });
    },
  });
  const roles = assignRoles([dead("a", 401, "Incorrect API key provided"), dead("b", 429, "You exceeded your current quota")]);
  await assert.rejects(forgeSite("x", { roles, dir: os.tmpdir() }), (err: Error) => {
    assert.match(err.message, /Every AI model failed/);
    assert.match(err.message, /a rejected the API key/);
    assert.match(err.message, /b ran out of credit/);
    return true;
  });
});

test("models that failed recently are only used as a last resort", () => {
  const fake = (kind: Connection["kind"], id: string): Provider => ({
    connection: { id, kind, name: id },
    kind,
    label: id,
    model: id,
    generate: async () => ({ text: "", model: id, usage: { inputTokens: 0, outputTokens: 0 } }),
  });
  const roles = assignRoles([fake("anthropic", "claude"), fake("gemini", "gemini"), fake("openai", "gpt")], { builder: "claude", avoid: ["claude"] });
  assert.equal(roles.builder.label, "gpt");
  assert.ok(!roles.reviewers.some((r) => r.label === "claude"));
  assert.equal(roles.pool?.at(-1)?.label, "claude");
});
