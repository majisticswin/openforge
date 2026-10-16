import Anthropic from "@anthropic-ai/sdk";
import type { GenerateRequest, Provider } from "./types.js";

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

export function createAnthropicProvider(apiKey: string, model = DEFAULT_CLAUDE_MODEL): Provider {
  const client = new Anthropic({ apiKey });

  return {
    id: "anthropic",
    label: `Claude (${model})`,
    model,
    async generate({ system, prompt, maxTokens = 64000, onText, signal }: GenerateRequest) {
      const stream = client.beta.messages.stream(
        {
          model,
          max_tokens: maxTokens,
          thinking: { type: "adaptive" },
          output_config: { effort: "high" },
          // If the model declines a request, let the API retry it on its default fallback model.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system,
          messages: [{ role: "user", content: prompt }],
        },
        { signal },
      );

      if (onText) stream.on("text", (text) => onText(text));
      const message = await stream.finalMessage();

      if (message.stop_reason === "refusal") {
        throw new Error(`Claude declined this request (${message.stop_details?.category ?? "unspecified"}).`);
      }
      const text = message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("");
      if (message.stop_reason === "max_tokens") {
        throw new Error("Claude hit its output limit before finishing. Try a smaller site description.");
      }
      return text;
    },
  };
}
