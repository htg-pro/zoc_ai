/**
 * Persisted list of locally-installed llama.cpp `.gguf` weights and the
 * per-task default model assignments.
 *
 * ## Two stores, one of them authoritative — zoc-agent-chat-rebuild R13.6, task 22.1
 *
 * The list now lives in **Desktop_Core config** (`~/.zoc-studio/desktop.json`,
 * through `local_models_get` / `local_models_set`). R13.6 requires the
 * hardware-fit state to come from Desktop_Core, and two stores for one list
 * guarantees they disagree — the picker would offer a model the fit probe has
 * never seen, or hide one it can measure.
 *
 * `localStorage` survives for two jobs and neither of them is durability:
 *
 *   1. **The synchronous snapshot.** `getLocalModelsSnapshot` feeds
 *      `useSyncExternalStore`, which cannot await. Desktop_Core is read once at
 *      boot by {@link hydrateLocalModels} and the answer is cached here.
 *   2. **The browser preview**, which has no Desktop_Core at all.
 *
 * So the ordering rule is: Desktop_Core wins when it answers, the cache answers
 * when it cannot, and a first boot with a `localStorage` list and an empty
 * Desktop_Core list migrates rather than discards (R23.5).
 *
 * The task-default assignments stay in `localStorage`: they are a UI preference,
 * no other process reads them, and nothing about them is a fact about this
 * machine.
 */

import {
  isTauri,
  localModelHardwareFit,
  localModelsGet,
  localModelsSet,
  type HardwareFit,
} from "./tauri-bridge";

export type { HardwareFit };

export interface LocalModel {
  /** Stable id used as the value in selects and the dedup key. */
  id: string;
  /** User-facing display name. */
  name: string;
  /** Absolute path to the `.gguf` file on disk. */
  path: string;
  /**
   * Number of transformer layers to offload to GPU when llama-server loads
   * this model. Higher = more VRAM, faster inference. `99` is the llama.cpp
   * convention for "offload everything". Treated as `99` when missing so
   * pre-existing entries upgrade transparently.
   */
  n_gpu_layers?: number;
  /**
   * Context window in tokens. Surfaced to the memory indicator and
   * passed to llama-server as `--ctx-size`. Treated as
   * `DEFAULT_CONTEXT_WINDOW` (8192) when missing so old localStorage
   * entries keep working — pick a higher value in Settings → Models if
   * the model supports it (e.g. 32768 for Qwen2.5-Coder).
   */
  n_ctx?: number;
  /**
   * Number of CPU threads for computation. Passed to llama-server as
   * `--threads`. Defaults to `DEFAULT_N_THREADS` (8) when missing.
   */
  n_threads?: number;
  /**
   * Logical batch size for prompt processing. Passed to llama-server as
   * `--batch-size`. Defaults to `DEFAULT_N_BATCH` (2048) when missing.
   */
  n_batch?: number;
  /**
   * Enable Flash Attention optimization. Passed to llama-server as
   * `--flash-attn`. Defaults to `DEFAULT_FLASH_ATTN` (false) when missing.
   */
  flash_attn?: boolean;
  /**
   * Host address for llama-server to bind. Defaults to `DEFAULT_HOST`
   * ("127.0.0.1") when missing.
   */
  host?: string;
  /**
   * Port for llama-server to listen on. Defaults to `DEFAULT_PORT`
   * (8080) when missing.
   */
  port?: number;
  /** Default sampling temperature sent to `/v1/chat/completions`. */
  temperature?: number;
  /** Default nucleus sampling value sent to `/v1/chat/completions`. */
  top_p?: number;
  /** Default top-k sampling value sent to llama-server. */
  top_k?: number;
  /** Default repetition penalty sent to `/v1/chat/completions`. */
  repeat_penalty?: number;
  /** Default completion cap sent as `max_tokens`. */
  max_tokens?: number;
  /**
   * The per-model Readiness_Deadline override, in seconds (R3.4, R3.10). Absent
   * means the 120-second default applies (R3.11). This is the exact key the
   * deadline-expiry error names; 300 suits a 70B Q4 cold load
   * (`RECOMMENDED_LARGE_MODEL_DEADLINE_SECS` in `llama_server.rs`).
   */
  readiness_deadline_secs?: number;
}

/** The Readiness_Deadline applied when a `LocalModel` carries no override (R3.11). */
export const DEFAULT_READINESS_DEADLINE_SECS = 120;
/** The value the deadline-expiry error recommends for large quantised models. */
export const RECOMMENDED_LARGE_MODEL_DEADLINE_SECS = 300;

/** The effective Readiness_Deadline for a model, in seconds. */
export function readinessDeadlineSecs(model: Pick<LocalModel, "readiness_deadline_secs">): number {
  const override = model.readiness_deadline_secs;
  return typeof override === "number" && override > 0
    ? override
    : DEFAULT_READINESS_DEADLINE_SECS;
}

/** llama.cpp's "offload all layers" sentinel, applied when a LocalModel
 *  doesn't carry an explicit `n_gpu_layers`. */
export const DEFAULT_N_GPU_LAYERS = 99;

/** Default context window when a `LocalModel` doesn't pin one. Most
 *  llama.cpp builds default to 4096–8192 unless the user opts higher. */
export const DEFAULT_CONTEXT_WINDOW = 8192;
export const DEFAULT_N_THREADS = 8;
export const DEFAULT_N_BATCH = 2048;
export const DEFAULT_FLASH_ATTN = false;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8080;
export const DEFAULT_TEMPERATURE = 0.2;
export const DEFAULT_TOP_P = 0.95;
export const DEFAULT_TOP_K = 40;
export const DEFAULT_REPEAT_PENALTY = 1.1;
export const DEFAULT_MAX_TOKENS = 4096;

const MODELS_KEY = "zoc-studio.local-models.v1";
const DEFAULTS_KEY = "zoc-studio.task-defaults.v1";

// Pub/sub so other surfaces (e.g. the right-panel ModelPicker) can react
// when the Settings page adds or removes a local model. localStorage only
// fires `storage` events in *other* tabs, so we publish manually too.
const modelListeners = new Set<() => void>();

export function subscribeLocalModels(cb: () => void): () => void {
  modelListeners.add(cb);
  if (typeof window !== "undefined") {
    const onStorage = (e: StorageEvent) => {
      if (e.key === MODELS_KEY) {
        cachedModels = readModels();
        cb();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      modelListeners.delete(cb);
      window.removeEventListener("storage", onStorage);
    };
  }
  return () => {
    modelListeners.delete(cb);
  };
}

function emitLocalModelsChanged(): void {
  for (const cb of modelListeners) cb();
}

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function storage(): Storage | null {
  if (typeof localStorage === "undefined") return null;
  if (
    typeof localStorage.getItem !== "function" ||
    typeof localStorage.setItem !== "function"
  ) {
    return null;
  }
  return localStorage;
}

// Cached snapshot so `useSyncExternalStore` gets a stable reference between
// reads — re-parsing localStorage on every call would return a new array
// each time and crash the consumer with "getSnapshot should be cached".
let cachedModels: LocalModel[] | null = null;

function readModels(): LocalModel[] {
  const store = storage();
  if (!store) return [];
  return safeParse<LocalModel[]>(store.getItem(MODELS_KEY), []);
}

export function loadLocalModels(): LocalModel[] {
  if (cachedModels === null) cachedModels = readModels();
  return cachedModels;
}

/** Snapshot getter for `useSyncExternalStore`. */
export function getLocalModelsSnapshot(): LocalModel[] {
  return loadLocalModels();
}

export function saveLocalModels(models: LocalModel[]): void {
  cachedModels = models;
  writeCache(models);
  // Durability is Desktop_Core's now (R13.6). Scheduled rather than awaited so
  // the existing synchronous callers — Settings → Models, the onboarding wizard —
  // keep their signature and their optimistic UI, and `localModelsSet` swallows
  // its own failures, so nothing here can reject unhandled. A caller that needs
  // to know the write landed awaits {@link persistLocalModels} instead.
  void localModelsSet(models);
  emitLocalModelsChanged();
}

// ── Desktop_Core-backed persistence (R13.6, R23.5, task 22.1) ──────────────

/**
 * Is this a `LocalModel`? The three fields a row cannot render without.
 *
 * Narrowing at the boundary rather than trusting the file: `desktop.json` is a
 * plain text file a user can edit, and a malformed entry should cost that entry
 * rather than the whole list — which is what an unchecked cast would do the
 * moment a component read `.path` off `undefined`.
 */
export function isLocalModel(value: unknown): value is LocalModel {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<LocalModel>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.name === "string" &&
    typeof candidate.path === "string" &&
    candidate.path.length > 0
  );
}

/**
 * Load the list from Desktop_Core, seeding the synchronous cache.
 *
 * Called once at boot. Three cases, and the third is the one that needs stating:
 *
 * - Desktop_Core has entries → they win, and the cache is replaced.
 * - Not in the desktop shell → the `localStorage` cache stands as-is.
 * - Desktop_Core is empty **and** the cache is not → a pre-22.1 install, whose
 *   models only exist in `localStorage`. They are written up to Desktop_Core
 *   rather than dropped (R23.5): a user who installed a 30 GB model should not
 *   have to find it again because the store moved.
 *
 * An empty answer on both sides is not a migration and not an error; it is a
 * fresh install.
 */
export async function hydrateLocalModels(): Promise<LocalModel[]> {
  if (!isTauri()) return loadLocalModels();

  const raw = await localModelsGet();
  if (raw === null) return loadLocalModels();

  const stored = raw.filter(isLocalModel);
  if (stored.length > 0) {
    cachedModels = stored;
    writeCache(stored);
    emitLocalModelsChanged();
    return stored;
  }

  const shadowed = loadLocalModels();
  if (shadowed.length > 0) {
    await localModelsSet(shadowed);
    return shadowed;
  }

  cachedModels = [];
  writeCache([]);
  return [];
}

/**
 * Write the list to Desktop_Core and await the result.
 *
 * The awaited counterpart to {@link saveLocalModels}, for the caller that has to
 * report whether the write landed — Settings' "model added" confirmation, and
 * the onboarding step that cannot move on from a model it failed to record.
 */
export async function persistLocalModels(models: LocalModel[]): Promise<LocalModel[]> {
  cachedModels = models;
  writeCache(models);
  const written = await localModelsSet(models);
  emitLocalModelsChanged();
  return written === null ? models : written.filter(isLocalModel);
}

function writeCache(models: LocalModel[]): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(MODELS_KEY, JSON.stringify(models));
  } catch {
    /* quota etc — the Desktop_Core copy is the durable one */
  }
}

/**
 * Desktop_Core's fit verdict for one model on this machine (R13.6).
 *
 * `null` outside the desktop shell, and `null` is rendered as *no fit state* by
 * the picker rather than as an optimistic one — a guess presented as a
 * measurement is the failure mode this probe exists to remove.
 *
 * The offload count passed is the model's effective one, so the verdict is
 * judged against video memory exactly when the model would actually use it.
 */
export async function localModelFit(
  model: Pick<LocalModel, "path" | "n_gpu_layers">,
): Promise<HardwareFit | null> {
  return localModelHardwareFit(model.path, model.n_gpu_layers ?? DEFAULT_N_GPU_LAYERS);
}

/** Fit verdicts by model id, for the picker's one-pass render. */
export async function localModelFits(
  models: readonly LocalModel[],
): Promise<Map<string, HardwareFit>> {
  const entries = await Promise.all(
    models.map(async (model) => [model.id, await localModelFit(model)] as const),
  );
  const fits = new Map<string, HardwareFit>();
  for (const [id, fit] of entries) {
    if (fit !== null) fits.set(id, fit);
  }
  return fits;
}

export function loadTaskDefaults(): Record<string, string> {
  const store = storage();
  if (!store) return {};
  return safeParse<Record<string, string>>(store.getItem(DEFAULTS_KEY), {});
}

export function saveTaskDefaults(map: Record<string, string>): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(DEFAULTS_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

/** Derive a friendly default name from a path, e.g.
 *  `/models/Qwen2.5-Coder-32B-Q4_K_M.gguf` → `Qwen2.5-Coder-32B-Q4_K_M`. */
export function deriveNameFromPath(path: string): string {
  const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const base = path.split(sep).pop() ?? path;
  return base.replace(/\.gguf$/i, "");
}

export function makeModelId(path: string): string {
  // Hashing is overkill — the absolute path itself is already unique. We
  // just base64-ish encode it so it survives use as a Select item value.
  if (typeof btoa === "function") {
    try {
      return `local:${btoa(unescape(encodeURIComponent(path)))}`;
    } catch {
      /* fall through */
    }
  }
  return `local:${path}`;
}
