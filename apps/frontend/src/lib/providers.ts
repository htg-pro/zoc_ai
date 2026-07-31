/**
 * Cloud provider catalogue + persistence.
 *
 * An editable catalogue covering OpenAI, Google AI Studio (Gemini), Groq, xAI,
 * and Anthropic, plus any number of user-added custom providers. Most providers
 * here are reached through an OpenAI-compatible `/chat/completions` endpoint
 * (Google, Groq and xAI all ship one); Anthropic is routed through its native
 * Messages API.
 *
 * Provider config — base URL, model list, custom providers — is persisted in
 * `localStorage`. It is configuration, not a credential and not a fact about the
 * machine, so it stays here.
 *
 * ## Keys — zoc-agent-chat-rebuild R13.2, R14.2, task 22.1
 *
 * **This module says nothing about where a key lives.** It pairs `requiresKey`
 * with {@link ProviderKeyState.hasKey}, which is Desktop_Core's answer to "is
 * there a key for this provider" and nothing more; the value itself never
 * reaches the renderer. `providerKeyName` is the keychain key *format*, retained
 * verbatim from the previous `secureStore` convention so keys saved by an earlier
 * build still resolve (R23).
 *
 * ## Model ids — R13.1
 *
 * The ids below are the ones the AI SDK provider packages take as their model
 * argument, which is what the Agent_Runtime's registry resolves against. For the
 * OpenAI-compatible providers that is the same string the wire takes, so nothing
 * is translated; the id in a row *is* the id sent. The runtime keeps its own
 * transcription of this table for context-window figures, and divergence there
 * is expected: a model a user adds here is absent from the runtime's table and
 * falls through to its default-window chain.
 */

import { secureStore, subscribeSecrets } from "./secure-store";

export interface ProviderModel {
  /** Wire id sent as the `model` field to the provider, and the AI SDK model id. */
  id: string;
  /** User-facing label. */
  name: string;
  contextWindow?: number;
  tools?: boolean;
  vision?: boolean;
}

export interface ProviderConfig {
  /** Stable id, also the secureStore key namespace (`provider.{id}.api_key`). */
  id: string;
  name: string;
  /** OpenAI-compatible base URL (no trailing `/chat/completions`). */
  baseUrl: string;
  /** Whether an API key is required to use this provider. */
  requiresKey: boolean;
  /** Built-in providers can't be deleted, only edited. */
  builtin: boolean;
  models: ProviderModel[];
  /** ISO timestamp of the last live model fetch via the provider's API. */
  modelsFetchedAt?: string;
}

const STORE_KEY = "zoc-studio.providers.v1";

/** Built-in OpenAI-compatible providers, shown by default. */
export const BUILTIN_PROVIDERS: ProviderConfig[] = [
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    requiresKey: true,
    builtin: true,
    models: [
      { id: "gpt-4o", name: "GPT-4o", contextWindow: 128_000, tools: true, vision: true },
      { id: "gpt-4o-mini", name: "GPT-4o mini", contextWindow: 128_000, tools: true, vision: true },
      { id: "o3-mini", name: "o3-mini", contextWindow: 200_000, tools: true },
    ],
  },
  {
    id: "google-ai-studio",
    name: "Google AI Studio",
    // Google's OpenAI-compatible endpoint for Gemini models.
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    requiresKey: true,
    builtin: true,
    models: [
      { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", contextWindow: 1_000_000, tools: true, vision: true },
      { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro", contextWindow: 2_000_000, tools: true, vision: true },
      { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash", contextWindow: 1_000_000, tools: true, vision: true },
    ],
  },
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    requiresKey: true,
    builtin: true,
    models: [
      { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B Versatile", contextWindow: 128_000, tools: true },
      { id: "llama-3.1-8b-instant", name: "Llama 3.1 8B Instant", contextWindow: 128_000, tools: true },
      { id: "openai/gpt-oss-120b", name: "GPT-OSS 120B", contextWindow: 128_000, tools: true },
    ],
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    baseUrl: "https://api.x.ai/v1",
    requiresKey: true,
    builtin: true,
    models: [
      { id: "grok-2-latest", name: "Grok 2", contextWindow: 131_072, tools: true },
      { id: "grok-2-vision-latest", name: "Grok 2 Vision", contextWindow: 32_768, tools: true, vision: true },
      { id: "grok-beta", name: "Grok Beta", contextWindow: 131_072, tools: true },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    requiresKey: true,
    builtin: true,
    models: [
      // The 200k figure is the standard window. Opus 5 and Sonnet 5 also offer a
      // 1M-token variant, which is opt-in per request rather than a different
      // model id — so listing it as a second row would offer a model that does
      // not exist, and pinning 1M here would size the meter against a window the
      // Run will not have.
      { id: "claude-opus-5", name: "Claude Opus 5", contextWindow: 200_000, tools: true, vision: true },
      { id: "claude-sonnet-5", name: "Claude Sonnet 5", contextWindow: 200_000, tools: true, vision: true },
      {
        id: "claude-haiku-4-5-20251001",
        name: "Claude Haiku 4.5",
        contextWindow: 200_000,
        tools: true,
        vision: true,
      },
    ],
  },
];

const listeners = new Set<() => void>();
let cached: ProviderConfig[] | null = null;

function storage(): Storage | null {
  if (typeof localStorage === "undefined") return null;
  if (typeof localStorage.getItem !== "function" || typeof localStorage.setItem !== "function") {
    return null;
  }
  return localStorage;
}

function mergeWithBuiltins(stored: ProviderConfig[]): ProviderConfig[] {
  // Start from built-ins (so new built-ins appear after an app update),
  // overlay any stored edits by id, then append custom providers.
  const byId = new Map<string, ProviderConfig>();
  for (const p of BUILTIN_PROVIDERS) byId.set(p.id, { ...p, models: [...p.models] });
  for (const p of stored) {
    if (byId.has(p.id)) {
      const base = byId.get(p.id)!;
      byId.set(p.id, {
        ...base,
        baseUrl: p.baseUrl || base.baseUrl,
        models: p.models?.length ? p.models : base.models,
        modelsFetchedAt: p.modelsFetchedAt ?? base.modelsFetchedAt,
      });
    } else {
      byId.set(p.id, { ...p, builtin: false });
    }
  }
  return Array.from(byId.values());
}

function read(): ProviderConfig[] {
  const store = storage();
  if (!store) return BUILTIN_PROVIDERS.map((p) => ({ ...p, models: [...p.models] }));
  try {
    const raw = store.getItem(STORE_KEY);
    if (!raw) return BUILTIN_PROVIDERS.map((p) => ({ ...p, models: [...p.models] }));
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return BUILTIN_PROVIDERS.map((p) => ({ ...p, models: [...p.models] }));
    return mergeWithBuiltins(parsed as ProviderConfig[]);
  } catch {
    return BUILTIN_PROVIDERS.map((p) => ({ ...p, models: [...p.models] }));
  }
}

export function loadProviders(): ProviderConfig[] {
  if (cached === null) cached = read();
  return cached;
}

export function getProvidersSnapshot(): ProviderConfig[] {
  return loadProviders();
}

export function saveProviders(providers: ProviderConfig[]): void {
  cached = providers;
  const store = storage();
  if (store) {
    try {
      store.setItem(STORE_KEY, JSON.stringify(providers));
    } catch {
      /* quota — ignore */
    }
  }
  for (const cb of listeners) cb();
}

export function subscribeProviders(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getProvider(id: string): ProviderConfig | undefined {
  return loadProviders().find((p) => p.id === id);
}

export function upsertProvider(next: ProviderConfig): void {
  const all = loadProviders();
  const idx = all.findIndex((p) => p.id === next.id);
  const out = idx === -1 ? [...all, next] : all.map((p, i) => (i === idx ? next : p));
  saveProviders(out);
}

export function removeProvider(id: string): void {
  const all = loadProviders();
  const target = all.find((p) => p.id === id);
  if (!target || target.builtin) return; // built-ins can't be deleted
  saveProviders(all.filter((p) => p.id !== id));
}

/** Slugify a display name into a stable custom-provider id. */
export function makeProviderId(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `custom-${slug || "provider"}-${Date.now().toString(36)}`;
}

/** Parse a comma/newline separated model list into ProviderModel[]. */
export function parseModelList(raw: string): ProviderModel[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => ({ id, name: id, tools: true }));
}

// ── Key state, paired with `requiresKey` (R13.2, R14.2, task 22.1) ─────────

/**
 * The keychain key format for a provider's API key.
 *
 * `provider.{id}.api_key`, unchanged from the format earlier builds saved under,
 * so a user upgrading keeps their keys (R23). The Agent_Runtime's
 * `providers/keys.ts` builds the same string for the same reason; they are two
 * readers of one convention, and the convention is what makes a key saved by the
 * renderer resolvable by the runtime.
 */
export function providerKeyName(providerId: string): string {
  return `provider.${providerId}.api_key`;
}

/** True when a provider-key change fired, rather than some unrelated secret. */
function isProviderKey(key: string): boolean {
  return key.startsWith("provider.") && key.endsWith(".api_key");
}

/**
 * Does Desktop_Core hold a key for this provider?
 *
 * A boolean, never a value. This is the entire input to R13.2's submission gate,
 * and the reason it is presence rather than validity is stated where the gate
 * lives (`features/chat/header/model-catalogue.ts`): validity cannot be known
 * without a provider call, and every guess is a way to block a Run that would
 * have worked.
 */
export async function providerHasKey(providerId: string): Promise<boolean> {
  return secureStore.has(providerKeyName(providerId));
}

/**
 * Key presence for many providers at once, keyed by provider id.
 *
 * One pass so the picker's rows are built from a single consistent reading. Asked
 * per row instead, a key saved mid-render would show against one provider and
 * not the next, and the picker would be internally inconsistent for exactly as
 * long as nobody re-rendered it.
 */
export async function providerKeyStates(
  providers: readonly ProviderConfig[] = loadProviders(),
): Promise<Map<string, boolean>> {
  const answers = await Promise.all(
    providers.map(async (provider) => [provider.id, await providerHasKey(provider.id)] as const),
  );
  return new Map(answers);
}

/**
 * Subscribe to provider-key changes only.
 *
 * A filtered view of `subscribeSecrets`, so the model picker's key badge
 * re-reads when a key is saved or cleared and stays put when an unrelated secret
 * moves. The badge refreshing without a reload is existing behaviour the cutover
 * has to keep (R13.3).
 */
export function subscribeProviderKeys(cb: (providerId: string) => void): () => void {
  return subscribeSecrets((key) => {
    if (!isProviderKey(key)) return;
    cb(key.slice("provider.".length, key.length - ".api_key".length));
  });
}
