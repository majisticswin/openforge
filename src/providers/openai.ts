import OpenAI from "openai";
import { estimateTokens, type Connection, type GenerateRequest, type Provider, type TokenUsage } from "./types.js";

const NON_CHAT_MODEL = /(embed|whisper|tts|dall-e|davinci|babbage|moderation|audio|realtime|transcribe|image|search|computer-use|sora)/i;

export function isChatModel(id: string): boolean {
  return !NON_CHAT_MODEL.test(id);
}

/**
 * Picks the newest general-purpose GPT model the key can use, so the app keeps
 * working as OpenAI ships new models. Users can pick a model explicitly instead.
 */
export async function detectOpenAIModel(client: OpenAI): Promise<string> {
  const skip = /(mini|nano|codex|instruct|vision|preview|chat-latest|oss|\d{4}-\d{2}-\d{2})/;
  const candidates: { id: string; created: number }[] = [];
  for await (const model of client.models.list()) {
    if (/^gpt-\d/.test(model.id) && isChatModel(model.id) && !skip.test(model.id)) candidates.push(model);
  }
  if (candidates.length === 0) throw new Error("No GPT models are available to this OpenAI key.");
  candidates.sort((a, b) => b.created - a.created);
  return candidates[0].id;
}

async function firstModel(client: OpenAI): Promise<string> {
  for await (const model of client.models.list()) {
    if (isChatModel(model.id)) return model.id;
  }
  throw new Error("This server did not list any models.");
}

export function openAIClient(connection: Connection): OpenAI {
  return new OpenAI({
    apiKey: connection.apiKey || "not-needed",
    baseURL: connection.kind === "compatible" ? connection.baseURL : undefined,
    // OpenRouter asks apps to identify themselves; other servers ignore these headers.
    defaultHeaders: connection.preset === "openrouter" ? { "HTTP-Referer": "https://github.com/majisticswin/openforge", "X-Title": "OpenForge" } : undefined,
  });
}

/** Works for OpenAI itself and for every OpenAI-compatible server, cloud or local. */
export function createOpenAIProvider(connection: Connection): Provider {
  const client = openAIClient(connection);
  let model = connection.model || undefined;
  // Some compatible servers reject stream_options; remember that after the first failure.
  let askForUsage = true;

  const provider: Provider = {
    connection,
    kind: connection.kind,
    label: model ? `${connection.name} (${model})` : connection.name,
    model: model ?? "auto",
    async generate({ system, prompt, maxTokens = 64000, onText, signal }: GenerateRequest) {
      model ??= connection.kind === "openai" ? await detectOpenAIModel(client) : await firstModel(client);
      provider.model = model;
      provider.label = `${connection.name} (${model})`;

      const request = async (withUsage: boolean) =>
        client.chat.completions.create(
          {
            model: model!,
            stream: true,
            ...(withUsage ? { stream_options: { include_usage: true } } : {}),
            // Local servers often have small context windows, so let them choose their own output limit.
            ...(connection.local ? {} : { max_completion_tokens: maxTokens }),
            messages: [
              { role: "system", content: system },
              { role: "user", content: prompt },
            ],
          },
          { signal },
        );

      let stream;
      try {
        stream = await request(askForUsage);
      } catch (err) {
        if (!(askForUsage && err instanceof OpenAI.BadRequestError)) throw err;
        askForUsage = false;
        stream = await request(false);
      }

      let text = "";
      let finish: string | null = null;
      let usage: TokenUsage | undefined;
      let answeredBy = model;
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        const delta = choice?.delta?.content ?? "";
        if (delta) {
          text += delta;
          onText?.(delta);
        }
        if (choice?.finish_reason) finish = choice.finish_reason;
        if (chunk.model) answeredBy = chunk.model;
        if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
      }
      if (finish === "length") throw new Error(`${connection.name} hit its output limit before finishing.`);
      if (finish === "content_filter") throw new Error(`${connection.name} declined this request.`);
      return {
        text,
        model: answeredBy,
        usage: usage ?? { inputTokens: estimateTokens(system + prompt), outputTokens: estimateTokens(text), estimated: true },
      };
    },
  };
  return provider;
}
