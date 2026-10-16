import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { PRESETS, type Preset } from "./catalog.js";
import { isChatModel, openAIClient } from "./openai.js";
import { knownPrice, type Price } from "./pricing.js";
import type { Connection } from "./types.js";

export interface ModelInfo {
  id: string;
  name?: string;
  contextLength?: number;
  /** USD per million tokens, when the provider publishes it. */
  price?: Price;
  /** Download size in bytes, for local models. */
  size?: number;
  free?: boolean;
}

/** Lists the models a key (or server) can use, newest and most useful first. */
export async function listModels(connection: Connection): Promise<ModelInfo[]> {
  switch (connection.kind) {
    case "anthropic": {
      const client = new Anthropic({ apiKey: connection.apiKey });
      const models: ModelInfo[] = [];
      for await (const m of client.models.list()) {
        models.push({ id: m.id, name: m.display_name, contextLength: m.max_input_tokens ?? undefined, price: knownPrice(m.id) });
      }
      return models;
    }
    case "openai": {
      const client = openAIClient(connection);
      const models: { id: string; created: number }[] = [];
      for await (const m of client.models.list()) if (isChatModel(m.id)) models.push(m);
      return models.sort((a, b) => b.created - a.created).map((m) => ({ id: m.id }));
    }
    case "gemini": {
      const ai = new GoogleGenAI({ apiKey: connection.apiKey });
      const models: ModelInfo[] = [];
      for await (const m of await ai.models.list()) {
        const id = m.name?.replace(/^models\//, "");
        if (id && m.supportedActions?.includes("generateContent") && isChatModel(id)) {
          models.push({ id, name: m.displayName, contextLength: m.inputTokenLimit });
        }
      }
      return models.reverse();
    }
    case "compatible":
      return listCompatibleModels(connection.baseURL ?? "", connection.apiKey);
    case "mock":
      return [{ id: "mock", name: "Demo model", price: { input: 0, output: 0 }, free: true }];
  }
}

interface RawModel {
  id: string;
  name?: string;
  context_length?: number;
  max_model_len?: number;
  pricing?: { prompt?: string; completion?: string };
}

async function listCompatibleModels(baseURL: string, apiKey?: string, timeoutMs = 10_000): Promise<ModelInfo[]> {
  if (!/^https?:\/\//.test(baseURL)) throw new Error("Enter the server address, starting with http:// or https://");
  const res = await fetch(`${baseURL.replace(/\/+$/, "")}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401 || res.status === 403) throw new Error("The server rejected this API key.");
  if (!res.ok) throw new Error(`The server answered ${res.status} when listing models.`);
  const body = (await res.json()) as { data?: RawModel[] };
  return (body.data ?? [])
    .filter((m) => m.id && isChatModel(m.id))
    .map((m) => {
      const input = Number(m.pricing?.prompt);
      const output = Number(m.pricing?.completion);
      const price = Number.isFinite(input) && Number.isFinite(output) ? { input: input * 1e6, output: output * 1e6 } : undefined;
      return {
        id: m.id,
        name: m.name,
        contextLength: m.context_length ?? m.max_model_len,
        price,
        free: price ? price.input === 0 && price.output === 0 : undefined,
      };
    });
}

export interface LocalServer {
  preset: string;
  name: string;
  baseURL: string;
  models: ModelInfo[];
}

/** Hosts to scan: this machine, plus any in OPENFORGE_SCAN_HOSTS (e.g. host.docker.internal or a LAN box). */
function scanHosts(): string[] {
  const extra = (process.env.OPENFORGE_SCAN_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  return ["localhost", ...extra];
}

async function ollamaSizes(host: string, port: number): Promise<Map<string, number>> {
  try {
    const res = await fetch(`http://${host}:${port}/api/tags`, { signal: AbortSignal.timeout(1500) });
    const body = (await res.json()) as { models?: { name: string; size: number }[] };
    return new Map((body.models ?? []).map((m) => [m.name, m.size]));
  } catch {
    return new Map();
  }
}

export interface ScanTarget {
  preset: Preset;
  host: string;
  port: number;
}

function defaultScanTargets(): ScanTarget[] {
  const targets: ScanTarget[] = [];
  for (const host of scanHosts()) {
    for (const preset of PRESETS) if (preset.port) targets.push({ preset, host, port: preset.port });
  }
  return targets;
}

/** Looks for AI servers already running on this computer (Ollama, LM Studio, llama.cpp, vLLM and more). */
export async function scanLocalServers(targets = defaultScanTargets()): Promise<LocalServer[]> {
  const found = await Promise.all(
    targets.map(async ({ preset, host, port }): Promise<LocalServer | null> => {
      const baseURL = `http://${host}:${port}/v1`;
      try {
        const models = await listCompatibleModels(baseURL, undefined, 1500);
        if (preset.id === "ollama") {
          const sizes = await ollamaSizes(host, port);
          for (const m of models) m.size = sizes.get(m.id);
        }
        for (const m of models) {
          m.price = { input: 0, output: 0 };
          m.free = true;
        }
        const where = host === "localhost" ? "on this computer" : `on ${host}`;
        return { preset: preset.id, name: `${preset.name} ${where}`, baseURL, models };
      } catch {
        return null;
      }
    }),
  );
  return found.filter((s): s is LocalServer => s !== null);
}

export interface AccountInfo {
  /** Credit used, in US dollars, as reported by the provider. */
  used?: number;
  /** Spending limit in US dollars, if one is set. */
  limit?: number;
  /** Credit remaining, in US dollars (or another currency, see `currency`). */
  remaining?: number;
  currency?: string;
  /** Where to check the account when the provider has no API for it. */
  dashboardUrl?: string;
  supported: boolean;
}

const DASHBOARDS: Record<string, string> = {
  anthropic: "https://console.anthropic.com/settings/usage",
  openai: "https://platform.openai.com/usage",
  gemini: "https://aistudio.google.com/usage",
  groq: "https://console.groq.com/settings/usage",
  together: "https://api.together.ai/settings/billing",
  mistral: "https://console.mistral.ai/usage",
  fireworks: "https://fireworks.ai/account/usage",
  xai: "https://console.x.ai",
};

/**
 * Reads the account balance where the provider offers it to a normal API key
 * (OpenRouter and DeepSeek do). The big three only expose usage to admin keys
 * or their dashboards, so for those OpenForge returns the dashboard link.
 */
export async function accountInfo(connection: Connection): Promise<AccountInfo> {
  const preset = connection.preset ?? connection.kind;
  const headers = { Authorization: `Bearer ${connection.apiKey ?? ""}` };
  if (preset === "openrouter") {
    const res = await fetch("https://openrouter.ai/api/v1/key", { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`OpenRouter answered ${res.status}.`);
    const { data } = (await res.json()) as { data: { usage?: number; limit?: number | null; limit_remaining?: number | null } };
    return { supported: true, used: data.usage, limit: data.limit ?? undefined, remaining: data.limit_remaining ?? undefined, currency: "USD", dashboardUrl: "https://openrouter.ai/activity" };
  }
  if (preset === "deepseek") {
    const res = await fetch("https://api.deepseek.com/user/balance", { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`DeepSeek answered ${res.status}.`);
    const body = (await res.json()) as { balance_infos?: { currency: string; total_balance: string }[] };
    const first = body.balance_infos?.[0];
    return { supported: true, remaining: first ? Number(first.total_balance) : undefined, currency: first?.currency, dashboardUrl: "https://platform.deepseek.com/usage" };
  }
  return { supported: false, dashboardUrl: DASHBOARDS[preset] };
}
