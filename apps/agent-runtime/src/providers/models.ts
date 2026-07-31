/**
 * The model catalogue and the context-window resolver — zoc-agent-chat-rebuild
 * R12.10, R13.1, R13.12.
 *
 * `providers/registry.ts` answers "how do I reach this provider". This module
 * answers "what is this model". They are separate because the second question has
 * a fallback chain and the first does not: a model id the catalogue has never
 * heard of is still perfectly usable — the user typed it into Settings and the
 * provider will either accept it or not — but its context window has to come from
 * somewhere, and `MemoryIndicator`'s chain (cloud catalogue → the local model's
 * own `n_ctx` → {@link DEFAULT_CONTEXT_WINDOW}) is where it comes from. That
 * chain is the one mechanism the design marks as surviving that component's
 * deletion, and this is where it survives.
 *
 * **Why the figures are a table rather than a fetch.** `contextLimit` sits on
 * `AssembledRequest`, so it is read *before* the Run's first provider call. A
 * round trip to discover it would put an extra failure mode in front of every
 * turn and would stop `/v1/models` answering offline, which is the one
 * configuration A6's zero-key path has to work in. A stale number in a table is a
 * slightly wrong meter; an unavailable number is no meter at all, and R12.10 asks
 * for the meter.
 *
 * **The generated `ModelDescriptor` is deliberately not reused.** It carries
 * `provider: ProviderKind`, and `ProviderKind` is the retained Gateway's
 * five-member enum — `llamacpp | openai | anthropic | gemini | mock` — with no
 * member for `google-ai-studio`, `groq`, or `xai`, which are three of the six
 * providers `registry.ts` ships. Reusing it would mean either mislabelling half
 * the catalogue or widening a generated type from the Node side, and the schema
 * check exists to stop the second. `providerCatalogue()` already answers in the
 * runtime's own vocabulary; this module matches it.
 */

import type { ModelRef } from "./registry.ts";

/**
 * The window assumed for a model nothing knows the size of.
 *
 * 8192 rather than something larger: the figure drives R12.5's pre-submission
 * overflow gate, and guessing high there means letting a request through that the
 * provider then refuses — a refusal the user reads after paying for the prompt.
 * Guessing low costs a warning that turns out to be unnecessary.
 */
export const DEFAULT_CONTEXT_WINDOW = 8192;

export interface ModelSpec {
  /** A `providers/registry.ts` provider id, not a `ProviderKind`. */
  readonly provider: string;
  /** The wire id sent as the provider's `model` field. */
  readonly modelId: string;
  readonly label: string;
  readonly contextWindow: number;
  readonly tools: boolean;
  readonly vision: boolean;
}

/**
 * The known cloud models, transcribed from the surface's editable catalogue.
 *
 * Transcribed rather than imported: R2.2 forbids one app importing another's
 * source tree, and the two lists answer different questions anyway — the
 * surface's is a *user-editable* picker whose entries can be added and renamed,
 * this one is the runtime's read-only best knowledge of a window size. Divergence
 * is therefore expected and harmless: a model the user adds is absent here and
 * falls through to the chain below, which is exactly the case that chain exists
 * for.
 *
 * `local-llamacpp` contributes no rows on purpose. Its models are whatever the
 * user has on disk, their windows are whatever they were loaded with, and
 * inventing a row for one would be inventing a figure Desktop_Core already knows
 * for real.
 */
export const MODELS: readonly ModelSpec[] = Object.freeze([
  cloud("openai", "gpt-4o", "GPT-4o", 128_000, { vision: true }),
  cloud("openai", "gpt-4o-mini", "GPT-4o mini", 128_000, { vision: true }),
  cloud("openai", "o3-mini", "o3-mini", 200_000, {}),
  cloud("anthropic", "claude-opus-5", "Claude Opus 5", 200_000, {
    vision: true,
  }),
  cloud("anthropic", "claude-sonnet-5", "Claude Sonnet 5", 200_000, {
    vision: true,
  }),
  cloud("anthropic", "claude-haiku-4-5-20251001", "Claude Haiku 4.5", 200_000, {
    vision: true,
  }),
  cloud("google-ai-studio", "gemini-2.0-flash", "Gemini 2.0 Flash", 1_000_000, {
    vision: true,
  }),
  cloud("google-ai-studio", "gemini-1.5-pro", "Gemini 1.5 Pro", 2_000_000, { vision: true }),
  cloud("google-ai-studio", "gemini-1.5-flash", "Gemini 1.5 Flash", 1_000_000, {
    vision: true,
  }),
  cloud("groq", "llama-3.3-70b-versatile", "Llama 3.3 70B Versatile", 128_000, {}),
  cloud("groq", "llama-3.1-8b-instant", "Llama 3.1 8B Instant", 128_000, {}),
  cloud("groq", "openai/gpt-oss-120b", "GPT-OSS 120B", 128_000, {}),
  cloud("xai", "grok-2-latest", "Grok 2", 131_072, {}),
  cloud("xai", "grok-2-vision-latest", "Grok 2 Vision", 32_768, { vision: true }),
  cloud("xai", "grok-beta", "Grok Beta", 131_072, {}),
]);

function cloud(
  provider: string,
  modelId: string,
  label: string,
  contextWindow: number,
  extras: { readonly vision?: boolean },
): ModelSpec {
  return Object.freeze({
    provider,
    modelId,
    label,
    contextWindow,
    tools: true,
    vision: extras.vision ?? false,
  });
}

/**
 * Provider and model id together, because a model id is not unique across
 * providers — `llama-3.3-70b-versatile` is a Groq row and could equally be a
 * llama.cpp file name, and the two have different windows.
 */
const BY_KEY: ReadonlyMap<string, ModelSpec> = new Map(
  MODELS.map((spec) => [keyOf(spec.provider, spec.modelId), spec]),
);

function keyOf(provider: string, modelId: string): string {
  // NUL rather than a printable separator: a model id may contain a slash
  // (`openai/gpt-oss-120b`) and, in principle, anything else a provider allows.
  return `${provider}\u0000${modelId}`;
}

export function modelSpec(provider: string, modelId: string): ModelSpec | null {
  return BY_KEY.get(keyOf(provider, modelId)) ?? null;
}

/**
 * Windows declared by locally-served models, keyed by model id.
 *
 * Supplied by the caller rather than read here: the figures are Desktop_Core's
 * llama.cpp configuration (`n_ctx`), and a module that reached for them would
 * need a config port and would make every model lookup in the test suite need a
 * stub for one.
 */
export type LocalContextWindows = Readonly<Record<string, number>>;

/**
 * The window to measure this Run's context against.
 *
 * The chain is catalogue → the local model's declared `n_ctx` → the default. It
 * never throws and never returns zero: a wrong-but-plausible denominator renders
 * a meter that is slightly off, whereas a missing one renders `NaN%` or divides by
 * zero somewhere downstream, and R12.10's guarantee is about the figure being
 * *the selected model's*, not about it being unavailable when unknown.
 */
export function contextWindowFor(
  ref: Pick<ModelRef, "provider" | "modelId">,
  localWindows: LocalContextWindows = {},
): number {
  const known = modelSpec(ref.provider, ref.modelId);
  if (known !== null) return known.contextWindow;

  const declared = localWindows[ref.modelId];
  if (typeof declared === "number" && Number.isFinite(declared) && declared > 0) {
    return Math.floor(declared);
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/** Public catalogue for `GET /v1/models`. Carries no credential. */
export function modelCatalogue(providerId?: string): readonly ModelSpec[] {
  return providerId === undefined ? MODELS : MODELS.filter((spec) => spec.provider === providerId);
}
