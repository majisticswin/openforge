import OpenAI from "openai";
import type { GenerateRequest, Provider, ProviderId } from "./types.js";

/**
 * Picks the newest general-purpose GPT model the key can use, so the app keeps
 * working as OpenAI ships new models. Set a model explicitly to override.
 */
export async function detectOpenAIModel(client: OpenAI): Promise<string> {
  const skip = /(mini|nano|audio|realtime|search|transcribe|tts|image|codex|instruct|vision|preview|chat-latest|oss|\d{4}-\d{2}-\d{2})/;
  const candidates: { id: string; created: number }[] = [];
  for await (const model of client.models.list()) {
    if (/^gpt-\d/.test(model.id) && !skip.test(model.id)) candidates.push(model);
  }
  if (candidates.length === 0) throw new Error("No GPT models are available to this OpenAI key.");
  candidates.sort((a, b) => b.created - a.created);
  return candidates[0].id;
}

function createChatProvider(id: ProviderId, label: string, client: OpenAI, resolveModel: () => Promise<string>): Provider {
  let model: string | undefined;
  const provider: Provider = {
    id,
    label,
    model: "auto",
    async generate({ system, prompt, maxTokens = 64000, onText, signal }: GenerateRequest) {
      model ??= await resolveModel();
      provider.model = model;
      provider.label = `${label} (${model})`;

      const stream = await client.chat.completions.create(
        {
          model,
          stream: true,
          max_completion_tokens: maxTokens,
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
        },
        { signal },
      );

      let text = "";
      let finish: string | null = null;
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        const delta = choice?.delta?.content ?? "";
        if (delta) {
          text += delta;
          onText?.(delta);
        }
        if (choice?.finish_reason) finish = choice.finish_reason;
      }
      if (finish === "length") throw new Error(`${label} hit its output limit before finishing.`);
      if (finish === "content_filter") throw new Error(`${label} declined this request.`);
      return text;
    },
  };
  return provider;
}

export function createOpenAIProvider(apiKey: string, model?: string): Provider {
  const client = new OpenAI({ apiKey });
  return createChatProvider("openai", "GPT", client, async () => model || (await detectOpenAIModel(client)));
}

/** Free local models (Ollama, LM Studio) or any OpenAI-compatible endpoint (OpenRouter, vLLM). */
export function createLocalProvider(baseURL: string, model: string, apiKey = "local"): Provider {
  const client = new OpenAI({ apiKey, baseURL });
  return createChatProvider("local", "Local", client, async () => model);
}
