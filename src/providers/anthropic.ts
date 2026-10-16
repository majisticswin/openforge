import Anthropic from "@anthropic-ai/sdk";
import type { Connection, GenerateRequest, Provider } from "./types.js";

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

export function createAnthropicProvider(connection: Connection): Provider {
  const client = new Anthropic({ apiKey: connection.apiKey });
  const model = connection.model || DEFAULT_CLAUDE_MODEL;

  return {
    connection,
    kind: "anthropic",
    label: `${connection.name} (${model})`,
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
      if (message.stop_reason === "max_tokens") {
        throw new Error("Claude hit its output limit before finishing. Try a smaller site description.");
      }
      const text = message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("");
      const u = message.usage;
      return {
        text,
        model: message.model,
        usage: {
          inputTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          outputTokens: u.output_tokens,
        },
      };
    },
  };
}
