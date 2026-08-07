/** Provider/model token-price estimates used by UsagePart (R27.1–R27.3). */
/** Feature: zoc-agent-chat-rebuild, task 31.2 (R27.1, R27.2, R27.3). */

/** USD per one million tokens. Unknown and local models intentionally return null. */
interface Price {
  readonly input: number;
  readonly output: number;
  readonly cachedInput?: number;
}

const PRICES: Readonly<Record<string, Price>> = Object.freeze({
  "openai\0gpt-4o": { input: 2.5, output: 10, cachedInput: 1.25 },
  "openai\0gpt-4o-mini": { input: 0.15, output: 0.6, cachedInput: 0.075 },
  "openai\0o3-mini": { input: 1.1, output: 4.4, cachedInput: 0.55 },
  "anthropic\0claude-opus-5": { input: 15, output: 75, cachedInput: 1.5 },
  "anthropic\0claude-sonnet-5": { input: 3, output: 15, cachedInput: 0.3 },
  "anthropic\0claude-haiku-4-5-20251001": { input: 1, output: 5, cachedInput: 0.1 },
  "google-ai-studio\0gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "google-ai-studio\0gemini-1.5-pro": { input: 1.25, output: 5 },
  "google-ai-studio\0gemini-1.5-flash": { input: 0.075, output: 0.3 },
  "groq\0llama-3.3-70b-versatile": { input: 0.59, output: 0.79 },
  "groq\0llama-3.1-8b-instant": { input: 0.05, output: 0.08 },
  "xai\0grok-2-latest": { input: 2, output: 10 },
  "xai\0grok-2-vision-latest": { input: 2, output: 10 },
});

export function estimateCostCentsFor(provider: string, modelId: string) {
  const price = PRICES[`${provider}\0${modelId}`];
  if (price === undefined) return () => null;
  return (usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens: number;
  }): number => {
    const cached = Math.max(0, usage.cachedInputTokens);
    const uncached = Math.max(0, usage.inputTokens - cached);
    const dollars =
      (uncached * price.input +
        cached * (price.cachedInput ?? price.input) +
        Math.max(0, usage.outputTokens) * price.output) /
      1_000_000;
    return dollars * 100;
  };
}
