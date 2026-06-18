/**
 * Persisted list of locally-installed llama.cpp `.gguf` weights and the
 * per-task default model assignments. Both are kept in localStorage so they
 * survive reloads in the browser preview; the desktop shell will route the
 * same shapes through Tauri config in a later phase.
 */

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
  const store = storage();
  if (store) {
    try {
      store.setItem(MODELS_KEY, JSON.stringify(models));
    } catch {
      /* quota etc — silently ignore */
    }
  }
  emitLocalModelsChanged();
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
