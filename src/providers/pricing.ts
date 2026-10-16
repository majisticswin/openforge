import type { Connection, TokenUsage } from "./types.js";

export interface Price {
  /** US dollars per million input tokens. */
  input: number;
  /** US dollars per million output tokens. */
  output: number;
}

/**
 * Published Claude API prices (USD per million tokens). Other vendors change
 * prices often, so for them OpenForge uses prices reported by the provider's own
 * model list (OpenRouter does this) or a price the user enters.
 */
const CLAUDE_PRICES: Record<string, Price> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export function knownPrice(model: string): Price | undefined {
  return CLAUDE_PRICES[model];
}

/** The price to use for a call, or undefined when OpenForge can't know it. */
export function priceFor(connection: Connection, model: string): Price | undefined {
  if (connection.local || connection.kind === "mock") return { input: 0, output: 0 };
  if (connection.price && Number.isFinite(connection.price.input) && Number.isFinite(connection.price.output)) return connection.price;
  return knownPrice(model);
}

export function costOf(usage: TokenUsage, price: Price | undefined): number | undefined {
  if (!price) return undefined;
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
}
