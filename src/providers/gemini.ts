import { GoogleGenAI } from "@google/genai";
import { estimateTokens, type Connection, type GenerateRequest, type Provider, type TokenUsage } from "./types.js";

function version(name: string): number[] {
  return (name.match(/gemini-([\d.]+)/)?.[1] ?? "0").split(".").map(Number);
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Picks the newest Gemini Pro model, preferring stable releases over previews. */
export async function detectGeminiModel(ai: GoogleGenAI): Promise<string> {
  const names: string[] = [];
  const pager = await ai.models.list();
  for await (const model of pager) {
    const name = model.name?.replace(/^models\//, "");
    if (name && /^gemini-[\d.]+-pro/.test(name) && !/(tts|image|audio|live|exp|\d{2}-\d{2})/.test(name)) {
      names.push(name);
    }
  }
  if (names.length === 0) throw new Error("No Gemini Pro models are available to this Gemini key.");
  names.sort((a, b) => {
    const byVersion = compareVersions(version(b), version(a));
    if (byVersion !== 0) return byVersion;
    return Number(a.includes("preview")) - Number(b.includes("preview"));
  });
  return names[0];
}

export function createGeminiProvider(connection: Connection): Provider {
  const ai = new GoogleGenAI({ apiKey: connection.apiKey });
  let model: string | undefined = connection.model || undefined;

  const provider: Provider = {
    connection,
    kind: "gemini",
    label: model ? `${connection.name} (${model})` : connection.name,
    model: model ?? "auto",
    async generate({ system, prompt, maxTokens = 65536, onText, signal }: GenerateRequest) {
      model ??= await detectGeminiModel(ai);
      provider.model = model;
      provider.label = `${connection.name} (${model})`;

      const stream = await ai.models.generateContentStream({
        model,
        contents: prompt,
        config: { systemInstruction: system, maxOutputTokens: maxTokens, abortSignal: signal },
      });

      let text = "";
      let finish: string | undefined;
      let usage: TokenUsage | undefined;
      for await (const chunk of stream) {
        const delta = chunk.text ?? "";
        if (delta) {
          text += delta;
          onText?.(delta);
        }
        finish = chunk.candidates?.[0]?.finishReason ?? finish;
        const meta = chunk.usageMetadata;
        if (meta?.promptTokenCount !== undefined) {
          // Thinking tokens are billed as output.
          usage = { inputTokens: meta.promptTokenCount, outputTokens: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0) };
        }
      }
      if (finish === "MAX_TOKENS") throw new Error("Gemini hit its output limit before finishing.");
      if (finish === "SAFETY" || finish === "PROHIBITED_CONTENT") throw new Error("Gemini declined this request.");
      return {
        text,
        model,
        usage: usage ?? { inputTokens: estimateTokens(system + prompt), outputTokens: estimateTokens(text), estimated: true },
      };
    },
  };
  return provider;
}
