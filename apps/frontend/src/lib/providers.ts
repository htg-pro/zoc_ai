/**
 * Cloud provider catalogue + persistence.
 *
 * Replaces the static MOCK_PROVIDERS list with an editable catalogue that
 * covers OpenAI, Google AI Studio (Gemini), Groq, xAI, Anthropic, plus any
 * number of user-added custom providers. Most providers here are reached
 * through an OpenAI-compatible `/chat/completions` endpoint (Google, Groq
 * and xAI all ship one); Anthropic is routed through its native Messages API.
 *
 * - Provider config (base URL, model list, custom providers) is persisted in
 *   localStorage so it survives reloads in the browser preview.
 * - API keys are NOT stored here — they live in `secureStore` under
 *   `provider.{id}.api_key` (OS keychain in the desktop shell).
 */

export interface ProviderModel {
  /** Wire id sent as the `model` field to the provider. */
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
      { id: "claude-3-5-sonnet-latest", name: "Claude 3.5 Sonnet", contextWindow: 200_000, tools: true, vision: true },
      { id: "claude-3-5-haiku-latest", name: "Claude 3.5 Haiku", contextWindow: 200_000, tools: true },
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
