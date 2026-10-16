import express from "express";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { createMockProvider } from "../src/providers/mock.js";

/**
 * A stand-in for a local OpenAI-compatible server (like Ollama). It answers with
 * the demo model's output, streamed the way real servers do, and reports usage.
 * Used by the tests, and handy for trying the "scan for local models" feature.
 */
export function createFakeOpenAIServer(models = ["qwen3-coder:30b", "llama4:16x17b"]) {
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  const mock = createMockProvider();
  const requests: { model: string; includeUsage: boolean }[] = [];

  app.get("/v1/models", (_req, res) => {
    res.json({ object: "list", data: models.map((id) => ({ id, object: "model", created: 1_760_000_000, owned_by: "local" })) });
  });
  app.get("/api/tags", (_req, res) => {
    res.json({ models: models.map((name, i) => ({ name, size: (i + 1) * 4_200_000_000 })) });
  });

  app.post("/v1/chat/completions", async (req, res) => {
    const { model, messages, stream_options } = req.body;
    requests.push({ model, includeUsage: Boolean(stream_options?.include_usage) });
    const system = messages.find((m: { role: string }) => m.role === "system")?.content ?? "";
    const prompt = messages.find((m: { role: string }) => m.role === "user")?.content ?? "";
    const { text } = await mock.generate({ system, prompt });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    const base = { id: "chatcmpl-fake", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
    for (let i = 0; i < text.length; i += 400) {
      send({ ...base, choices: [{ index: 0, delta: { content: text.slice(i, i + 400) }, finish_reason: null }] });
    }
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    if (stream_options?.include_usage) {
      send({ ...base, choices: [], usage: { prompt_tokens: Math.ceil((system.length + prompt.length) / 3.5), completion_tokens: Math.ceil(text.length / 3.5), total_tokens: 0 } });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });

  return {
    requests,
    listen: (port = 0) =>
      new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
        const server = app.listen(port, "127.0.0.1", () => {
          resolve({ port: (server.address() as AddressInfo).port, close: () => new Promise((r) => server.close(() => r())) });
        });
      }),
  };
}

// Run directly to pretend Ollama is running: npx tsx test/fake-openai-server.ts [port]
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { port } = await createFakeOpenAIServer().listen(Number(process.argv[2]) || 11434);
  console.log(`Fake local AI server on http://localhost:${port}/v1`);
}
