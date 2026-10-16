import type { ProviderKind } from "./types.js";

export interface Preset {
  id: string;
  kind: ProviderKind;
  name: string;
  group: "major" | "cloud" | "local";
  /** Default API address for OpenAI-compatible presets. */
  baseURL?: string;
  needsKey: boolean;
  /** Where to get a key, shown in the app. */
  keyUrl?: string;
  /** Default local port, used by the scanner. */
  port?: number;
  note?: string;
}

/** Everything a user can pick from the "Add an AI" dropdown. */
export const PRESETS: Preset[] = [
  { id: "anthropic", kind: "anthropic", name: "Claude (Anthropic)", group: "major", needsKey: true, keyUrl: "https://console.anthropic.com/settings/keys" },
  { id: "openai", kind: "openai", name: "ChatGPT models (OpenAI)", group: "major", needsKey: true, keyUrl: "https://platform.openai.com/api-keys" },
  { id: "gemini", kind: "gemini", name: "Gemini (Google)", group: "major", needsKey: true, keyUrl: "https://aistudio.google.com/apikey", note: "Has a free tier." },

  { id: "openrouter", kind: "compatible", name: "OpenRouter (hundreds of models, one key)", group: "cloud", baseURL: "https://openrouter.ai/api/v1", needsKey: true, keyUrl: "https://openrouter.ai/keys", note: "Includes free models." },
  { id: "groq", kind: "compatible", name: "Groq", group: "cloud", baseURL: "https://api.groq.com/openai/v1", needsKey: true, keyUrl: "https://console.groq.com/keys" },
  { id: "together", kind: "compatible", name: "Together AI", group: "cloud", baseURL: "https://api.together.xyz/v1", needsKey: true, keyUrl: "https://api.together.ai/settings/api-keys" },
  { id: "deepseek", kind: "compatible", name: "DeepSeek", group: "cloud", baseURL: "https://api.deepseek.com/v1", needsKey: true, keyUrl: "https://platform.deepseek.com/api_keys" },
  { id: "mistral", kind: "compatible", name: "Mistral", group: "cloud", baseURL: "https://api.mistral.ai/v1", needsKey: true, keyUrl: "https://console.mistral.ai/api-keys" },
  { id: "fireworks", kind: "compatible", name: "Fireworks AI", group: "cloud", baseURL: "https://api.fireworks.ai/inference/v1", needsKey: true, keyUrl: "https://fireworks.ai/account/api-keys" },
  { id: "xai", kind: "compatible", name: "xAI (Grok)", group: "cloud", baseURL: "https://api.x.ai/v1", needsKey: true, keyUrl: "https://console.x.ai" },
  { id: "custom-cloud", kind: "compatible", name: "My own hosted LLM (any OpenAI-compatible URL)", group: "cloud", needsKey: false, note: "For models you host yourself with vLLM, TGI, Ollama or LiteLLM on a cloud server, or any other OpenAI-compatible API." },

  { id: "ollama", kind: "compatible", name: "Ollama", group: "local", baseURL: "http://localhost:11434/v1", port: 11434, needsKey: false },
  { id: "lmstudio", kind: "compatible", name: "LM Studio", group: "local", baseURL: "http://localhost:1234/v1", port: 1234, needsKey: false },
  { id: "llamacpp", kind: "compatible", name: "llama.cpp / LocalAI", group: "local", baseURL: "http://localhost:8080/v1", port: 8080, needsKey: false },
  { id: "vllm", kind: "compatible", name: "vLLM", group: "local", baseURL: "http://localhost:8000/v1", port: 8000, needsKey: false },
  { id: "jan", kind: "compatible", name: "Jan", group: "local", baseURL: "http://localhost:1337/v1", port: 1337, needsKey: false },
  { id: "textgen", kind: "compatible", name: "text-generation-webui", group: "local", baseURL: "http://localhost:5000/v1", port: 5000, needsKey: false },
  { id: "koboldcpp", kind: "compatible", name: "KoboldCpp", group: "local", baseURL: "http://localhost:5001/v1", port: 5001, needsKey: false },
  { id: "gpt4all", kind: "compatible", name: "GPT4All", group: "local", baseURL: "http://localhost:4891/v1", port: 4891, needsKey: false },
  { id: "custom-local", kind: "compatible", name: "Other local server (enter its address)", group: "local", needsKey: false },
];

export function findPreset(id: string | undefined): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}
