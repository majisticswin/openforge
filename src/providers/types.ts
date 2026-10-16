/**
 * How OpenForge talks to a model:
 * - anthropic / openai / gemini: each vendor's official SDK
 * - compatible: any OpenAI-compatible API, cloud (OpenRouter, Groq, your own vLLM server) or local (Ollama, LM Studio)
 * - mock: the built-in demo model
 */
export type ProviderKind = "anthropic" | "openai" | "gemini" | "compatible" | "mock";

/** One AI the user has added: a key (or URL) plus the model they picked for it. */
export interface Connection {
  id: string;
  kind: ProviderKind;
  /** Display name, e.g. "Claude", "OpenRouter", "Ollama on this computer". */
  name: string;
  apiKey?: string;
  /** Required for "compatible" connections, e.g. http://localhost:11434/v1 */
  baseURL?: string;
  /** Empty means "pick the best available model automatically". */
  model?: string;
  /** Which preset this came from (openrouter, groq, ollama...), for pricing and balance lookups. */
  preset?: string;
  /** True for models running on the user's own machine (they cost nothing per token). */
  local?: boolean;
  /** Optional prices in US dollars per million tokens, for providers OpenForge has no price list for. */
  price?: { input: number; output: number };
  enabled?: boolean;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** True when the provider didn't report usage and OpenForge estimated it from text length. */
  estimated?: boolean;
}

export interface GenerateRequest {
  system: string;
  prompt: string;
  maxTokens?: number;
  /** Called with each chunk of streamed text, for progress display. */
  onText?: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
  usage: TokenUsage;
  /** The model that actually answered (it can differ from the one requested, e.g. after a fallback). */
  model: string;
}

export interface Provider {
  /** The connection this provider was created from. */
  connection: Connection;
  kind: ProviderKind;
  /** Human-friendly label, e.g. "Claude (claude-opus-5-5)". */
  label: string;
  model: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

/** Rough token estimate (about 4 characters per token) for servers that don't report usage. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
