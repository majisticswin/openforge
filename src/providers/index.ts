import { createAnthropicProvider } from "./anthropic.js";
import { createGeminiProvider } from "./gemini.js";
import { createMockProvider } from "./mock.js";
import { createLocalProvider, createOpenAIProvider } from "./openai.js";
import type { Provider, ProviderConfig } from "./types.js";

export type { Provider, ProviderConfig, ProviderId } from "./types.js";

export function createProviders(config: ProviderConfig): Provider[] {
  const providers: Provider[] = [];
  if (config.anthropic?.apiKey) providers.push(createAnthropicProvider(config.anthropic.apiKey, config.anthropic.model || undefined));
  if (config.openai?.apiKey) providers.push(createOpenAIProvider(config.openai.apiKey, config.openai.model || undefined));
  if (config.gemini?.apiKey) providers.push(createGeminiProvider(config.gemini.apiKey, config.gemini.model || undefined));
  if (config.local?.baseURL && config.local.model) {
    providers.push(createLocalProvider(config.local.baseURL, config.local.model, config.local.apiKey || undefined));
  }
  if (config.mock) providers.push(createMockProvider());
  return providers;
}

/** Reads keys from the environment (.env), for the CLI and as server defaults. */
export function configFromEnv(env = process.env): ProviderConfig {
  return {
    anthropic: env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL } : undefined,
    openai: env.OPENAI_API_KEY ? { apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL } : undefined,
    gemini: env.GEMINI_API_KEY ? { apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL } : undefined,
    local: env.LOCAL_BASE_URL && env.LOCAL_MODEL ? { baseURL: env.LOCAL_BASE_URL, model: env.LOCAL_MODEL, apiKey: env.LOCAL_API_KEY } : undefined,
    mock: env.OPENFORGE_DEMO === "1",
  };
}
