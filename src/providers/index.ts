import { createAnthropicProvider } from "./anthropic.js";
import { createGeminiProvider } from "./gemini.js";
import { createMockProvider, MOCK_CONNECTION } from "./mock.js";
import { createOpenAIProvider } from "./openai.js";
import type { Connection, Provider } from "./types.js";

export type { Connection, Provider, ProviderKind } from "./types.js";

export function createProvider(connection: Connection): Provider {
  switch (connection.kind) {
    case "anthropic":
      return createAnthropicProvider(connection);
    case "gemini":
      return createGeminiProvider(connection);
    case "openai":
    case "compatible":
      return createOpenAIProvider(connection);
    case "mock":
      return createMockProvider(connection);
  }
}

/** Checks a connection sent by the browser and drops anything unusable. */
export function sanitizeConnection(raw: unknown): Connection | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const kinds = ["anthropic", "openai", "gemini", "compatible", "mock"];
  if (typeof c.kind !== "string" || !kinds.includes(c.kind)) return null;
  const str = (v: unknown, max = 500) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
  const price = c.price as { input?: unknown; output?: unknown } | undefined;
  const connection: Connection = {
    id: str(c.id, 64) ?? Math.random().toString(36).slice(2),
    kind: c.kind as Connection["kind"],
    name: str(c.name, 100) ?? c.kind,
    apiKey: str(c.apiKey),
    baseURL: str(c.baseURL),
    model: str(c.model, 200),
    preset: str(c.preset, 40),
    local: c.local === true,
    enabled: c.enabled !== false,
    price:
      price && Number.isFinite(Number(price.input)) && Number.isFinite(Number(price.output)) && price.input !== "" && price.output !== ""
        ? { input: Number(price.input), output: Number(price.output) }
        : undefined,
  };
  if (connection.kind === "compatible" && !/^https?:\/\//.test(connection.baseURL ?? "")) return null;
  if (["anthropic", "openai", "gemini"].includes(connection.kind) && !connection.apiKey) return null;
  return connection;
}

/** Reads keys from the environment (.env), for the CLI and as server defaults. */
export function connectionsFromEnv(env = process.env): Connection[] {
  const list: Connection[] = [];
  if (env.ANTHROPIC_API_KEY) list.push({ id: "env-anthropic", kind: "anthropic", name: "Claude", apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL, preset: "anthropic" });
  if (env.OPENAI_API_KEY) list.push({ id: "env-openai", kind: "openai", name: "OpenAI", apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL, preset: "openai" });
  if (env.GEMINI_API_KEY) list.push({ id: "env-gemini", kind: "gemini", name: "Gemini", apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL, preset: "gemini" });
  if (env.LOCAL_BASE_URL) {
    const local = /\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(env.LOCAL_BASE_URL);
    list.push({ id: "env-local", kind: "compatible", name: local ? "Local model" : "Custom model", baseURL: env.LOCAL_BASE_URL, model: env.LOCAL_MODEL, apiKey: env.LOCAL_API_KEY, local });
  }
  if (env.OPENFORGE_DEMO === "1") list.push(MOCK_CONNECTION);
  return list;
}
