export type ProviderId = "anthropic" | "openai" | "gemini" | "local" | "mock";

export interface GenerateRequest {
  system: string;
  prompt: string;
  maxTokens?: number;
  /** Called with each chunk of streamed text, for progress display. */
  onText?: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface Provider {
  id: ProviderId;
  /** Human-friendly label, e.g. "Claude (claude-opus-5-5)". */
  label: string;
  model: string;
  generate(req: GenerateRequest): Promise<string>;
}

export interface ProviderConfig {
  anthropic?: { apiKey: string; model?: string };
  openai?: { apiKey: string; model?: string };
  gemini?: { apiKey: string; model?: string };
  /** Any OpenAI-compatible server: Ollama, LM Studio, OpenRouter, vLLM... */
  local?: { baseURL: string; model: string; apiKey?: string };
  mock?: boolean;
}
