import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assignRoles, forgeSite, type ForgeEvent } from "../src/engine/forge.js";
import { PRESETS } from "../src/providers/catalog.js";
import { listModels, scanLocalServers } from "../src/providers/discovery.js";
import { connectionsFromEnv, createProvider, sanitizeConnection } from "../src/providers/index.js";
import { costOf, priceFor } from "../src/providers/pricing.js";
import { UsageStore } from "../src/usage.js";
import { createFakeOpenAIServer } from "./fake-openai-server.js";

test("scan finds a running local server and lists its models with sizes", async () => {
  const fake = createFakeOpenAIServer();
  const server = await fake.listen();
  try {
    const ollama = PRESETS.find((p) => p.id === "ollama")!;
    const lmstudio = PRESETS.find((p) => p.id === "lmstudio")!;
    const found = await scanLocalServers([
      { preset: ollama, host: "127.0.0.1", port: server.port },
      { preset: lmstudio, host: "127.0.0.1", port: 1 }, // nothing listens here
    ]);
    assert.equal(found.length, 1);
    assert.equal(found[0].preset, "ollama");
    assert.deepEqual(found[0].models.map((m) => m.id), ["qwen3-coder:30b", "llama4:16x17b"]);
    assert.equal(found[0].models[0].size, 4_200_000_000);
    assert.ok(found[0].models.every((m) => m.free));
  } finally {
    await server.close();
  }
});

test("lists models for a manually added OpenAI-compatible server", async () => {
  const server = await createFakeOpenAIServer(["my-model"]).listen();
  try {
    const models = await listModels({ id: "x", kind: "compatible", name: "Mine", baseURL: `http://127.0.0.1:${server.port}/v1` });
    assert.deepEqual(models.map((m) => m.id), ["my-model"]);
    await assert.rejects(listModels({ id: "y", kind: "compatible", name: "Bad", baseURL: "not-a-url" }));
  } finally {
    await server.close();
  }
});

test("builds a site through an OpenAI-compatible server and records real token usage", { timeout: 180_000 }, async () => {
  const fake = createFakeOpenAIServer();
  const server = await fake.listen();
  const dir = await mkdtemp(path.join(os.tmpdir(), "openforge-compat-"));
  try {
    const provider = createProvider({
      id: "cloud",
      kind: "compatible",
      name: "My cloud LLM",
      baseURL: `http://127.0.0.1:${server.port}/v1`,
      model: "qwen3-coder:30b",
      price: { input: 1, output: 2 },
    });
    const events: ForgeEvent[] = [];
    const result = await forgeSite("A bakery site", { roles: assignRoles([provider]), dir, onEvent: (e) => events.push(e) });
    assert.ok(result.verify.ok);
    const calls = events.flatMap((e) => (e.type === "usage" ? [e.call] : []));
    assert.ok(calls.length >= 4);
    for (const c of calls) {
      assert.equal(c.estimated, false, "server-reported usage is used");
      assert.equal(c.model, "qwen3-coder:30b");
      assert.ok(c.cost! > 0);
      assert.equal(c.cost, (c.inputTokens * 1 + c.outputTokens * 2) / 1e6);
    }
    assert.ok(fake.requests.every((r) => r.includeUsage));
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("prices: Claude is priced automatically, local is free, unknown stays unknown", () => {
  assert.deepEqual(priceFor({ id: "a", kind: "anthropic", name: "Claude" }, "claude-opus-5-5"), { input: 4, output: 20 });
  assert.deepEqual(priceFor({ id: "l", kind: "compatible", name: "Ollama", local: true }, "llama"), { input: 0, output: 0 });
  assert.equal(priceFor({ id: "o", kind: "openai", name: "OpenAI" }, "gpt-x"), undefined);
  assert.deepEqual(priceFor({ id: "o", kind: "openai", name: "OpenAI", price: { input: 3, output: 9 } }, "gpt-x"), { input: 3, output: 9 });
  assert.equal(costOf({ inputTokens: 1_000_000, outputTokens: 500_000 }, { input: 4, output: 20 }), 14);
  assert.equal(costOf({ inputTokens: 10, outputTokens: 10 }, undefined), undefined);
});

test("connections from the browser are validated", () => {
  assert.equal(sanitizeConnection({ kind: "anthropic", name: "Claude" }), null, "API providers need a key");
  assert.equal(sanitizeConnection({ kind: "compatible", baseURL: "ftp://x" }), null);
  assert.equal(sanitizeConnection({ kind: "evil" }), null);
  const ok = sanitizeConnection({ id: "a", kind: "compatible", name: "Groq", baseURL: "https://api.groq.com/openai/v1", apiKey: " k ", price: { input: "0.5", output: "1" } });
  assert.equal(ok?.apiKey, "k");
  assert.deepEqual(ok?.price, { input: 0.5, output: 1 });
  const env = connectionsFromEnv({ ANTHROPIC_API_KEY: "x", LOCAL_BASE_URL: "http://localhost:11434/v1", OPENFORGE_DEMO: "1" });
  assert.deepEqual(env.map((c) => c.kind), ["anthropic", "compatible", "mock"]);
  assert.equal(env[1].local, true);
});

test("usage summary totals by day, model and site", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openforge-usage-"));
  try {
    const store = new UsageStore(dir);
    const base = { role: "builder", connectionId: "c", connectionName: "Claude", kind: "anthropic", local: false, estimated: false, durationMs: 1000 };
    await store.record({ ...base, at: "2026-10-16T01:00:00Z", model: "claude-opus-5-5", inputTokens: 1000, outputTokens: 2000, cost: 0.044, projectId: "p1", projectName: "Bakery" });
    await store.record({ ...base, at: "2026-10-16T02:00:00Z", model: "claude-opus-5-5", inputTokens: 500, outputTokens: 500, cost: 0.012, projectId: "p1", projectName: "Bakery" });
    await store.record({ ...base, at: "2026-09-01T02:00:00Z", model: "gpt-x", connectionName: "OpenAI", inputTokens: 100, outputTokens: 100, projectId: "p2", projectName: "Shop" });
    const s = await store.summary(new Date("2026-10-16T12:00:00Z"));
    assert.equal(s.allTime.calls, 3);
    assert.equal(s.today.calls, 2);
    assert.equal(s.today.inputTokens, 1500);
    assert.equal(s.last30Days.calls, 2);
    assert.equal(s.allTime.unpricedCalls, 1);
    assert.ok(Math.abs(s.allTime.cost - 0.056) < 1e-9);
    assert.equal(s.byModel[0].model, "claude-opus-5-5");
    assert.deepEqual(s.byProject.map((p) => p.projectName), ["Bakery", "Shop"]);
    assert.equal(s.recent[0].at, "2026-09-01T02:00:00Z", "most recently recorded first");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
