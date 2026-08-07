/**
 * Local models on Desktop_Core config — zoc-agent-chat-rebuild task 22.1 (R13.6, R23.5).
 *
 * The list moved out of `localStorage` and into `~/.zoc-studio/desktop.json`
 * because R13.6 puts the hardware-fit verdict on Desktop_Core, and a picker whose
 * models and whose fit probe read different stores can offer a model the probe has
 * never seen. What the tests below pin is the *ordering rule* that move implies:
 * Desktop_Core wins when it answers, the cache answers when it cannot, and a
 * pre-move install migrates rather than losing a 30 GB download.
 *
 * Each test re-imports the module, because the synchronous snapshot
 * `useSyncExternalStore` needs is a module-scope cache — and a cache shared across
 * tests would make them pass in one order and fail in another.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  localModelsGet: vi.fn(),
  localModelsSet: vi.fn(),
  localModelHardwareFit: vi.fn(),
}));

vi.mock("@/lib/tauri-bridge", () => bridge);

const MODELS_KEY = "zoc-studio.local-models.v1";

const realLocalStorage = globalThis.localStorage;

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

const model = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  path: `/models/${id}.gguf`,
  ...extra,
});

type Module = typeof import("@/lib/local-models");

async function load(): Promise<Module> {
  vi.resetModules();
  return import("@/lib/local-models");
}

beforeEach(() => {
  vi.stubGlobal("localStorage", fakeStorage());
  bridge.isTauri.mockReturnValue(true);
  bridge.localModelsGet.mockReset();
  bridge.localModelsSet.mockReset();
  bridge.localModelHardwareFit.mockReset();
  bridge.localModelsGet.mockResolvedValue([]);
  bridge.localModelsSet.mockImplementation((models: unknown[]) => Promise.resolve(models));
  bridge.localModelHardwareFit.mockResolvedValue(null);
});

afterEach(() => {
  vi.stubGlobal("localStorage", realLocalStorage);
});

describe("Feature: zoc-agent-chat-rebuild, task 22.1: hydrating from Desktop_Core", () => {
  it("prefers Desktop_Core's list and seeds the synchronous snapshot with it", async () => {
    const stored = [model("local:a"), model("local:b", { n_gpu_layers: 20 })];
    bridge.localModelsGet.mockResolvedValue(stored);
    localStorage.setItem(MODELS_KEY, JSON.stringify([model("local:stale")]));

    const models = await load();
    const hydrated = await models.hydrateLocalModels();

    expect(hydrated.map((m) => m.id)).toEqual(["local:a", "local:b"]);
    // The snapshot is what `useSyncExternalStore` reads, and it cannot await —
    // so hydration has to leave the cache holding Desktop_Core's answer.
    expect(models.getLocalModelsSnapshot().map((m) => m.id)).toEqual(["local:a", "local:b"]);
    expect(JSON.parse(localStorage.getItem(MODELS_KEY) ?? "[]")).toHaveLength(2);
  });

  it("migrates a pre-22.1 localStorage list up to Desktop_Core rather than dropping it (R23.5)", async () => {
    const shadowed = [model("local:downloaded")];
    localStorage.setItem(MODELS_KEY, JSON.stringify(shadowed));
    bridge.localModelsGet.mockResolvedValue([]);

    const models = await load();
    const hydrated = await models.hydrateLocalModels();

    expect(bridge.localModelsSet).toHaveBeenCalledWith(shadowed);
    expect(hydrated.map((m) => m.id)).toEqual(["local:downloaded"]);
  });

  it("treats both stores empty as a fresh install, not a migration", async () => {
    const models = await load();
    await models.hydrateLocalModels();

    expect(bridge.localModelsSet).not.toHaveBeenCalled();
    expect(models.getLocalModelsSnapshot()).toEqual([]);
  });

  it("drops a malformed entry instead of the whole list", async () => {
    bridge.localModelsGet.mockResolvedValue([
      model("local:good"),
      { id: "local:no-path", name: "broken" },
      null,
      "not a model",
      { name: "no id", path: "/models/x.gguf" },
    ]);

    const models = await load();
    const hydrated = await models.hydrateLocalModels();

    // `desktop.json` is a text file a user can edit. One bad entry should cost
    // that entry, where an unchecked cast costs the picker its first render.
    expect(hydrated.map((m) => m.id)).toEqual(["local:good"]);
  });

  it("leaves the cache alone outside the desktop shell", async () => {
    bridge.isTauri.mockReturnValue(false);
    localStorage.setItem(MODELS_KEY, JSON.stringify([model("local:preview")]));

    const models = await load();
    const hydrated = await models.hydrateLocalModels();

    expect(hydrated.map((m) => m.id)).toEqual(["local:preview"]);
    expect(bridge.localModelsGet).not.toHaveBeenCalled();
  });

  it("keeps the cache when Desktop_Core cannot answer at all", async () => {
    bridge.localModelsGet.mockResolvedValue(null);
    localStorage.setItem(MODELS_KEY, JSON.stringify([model("local:cached")]));

    const models = await load();
    const hydrated = await models.hydrateLocalModels();

    expect(hydrated.map((m) => m.id)).toEqual(["local:cached"]);
    expect(bridge.localModelsSet).not.toHaveBeenCalled();
  });
});

describe("Feature: zoc-agent-chat-rebuild, task 22.1: writing the list", () => {
  it("keeps saveLocalModels synchronous and still writes through to Desktop_Core", async () => {
    const models = await load();
    const next = [model("local:new", { readiness_deadline_secs: 300 })];

    models.saveLocalModels(next as never);

    // Existing callers — Settings → Models, the onboarding wizard — call this
    // synchronously and rely on the optimistic snapshot. Durability rides along.
    expect(models.getLocalModelsSnapshot()).toEqual(next);
    expect(bridge.localModelsSet).toHaveBeenCalledWith(next);
  });

  it("notifies subscribers on both the sync and the awaited write", async () => {
    const models = await load();
    const seen = vi.fn();
    models.subscribeLocalModels(seen);

    models.saveLocalModels([model("local:a")] as never);
    await models.persistLocalModels([model("local:a"), model("local:b")] as never);

    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("returns what Desktop_Core wrote, not what the caller hoped it wrote", async () => {
    bridge.localModelsSet.mockResolvedValue([model("local:a")]);
    const models = await load();

    const written = await models.persistLocalModels([model("local:a"), model("local:b")] as never);

    expect(written.map((m) => m.id)).toEqual(["local:a"]);
  });

  it("falls back to the caller's list when there is no Desktop_Core to answer", async () => {
    bridge.localModelsSet.mockResolvedValue(null);
    const models = await load();

    const written = await models.persistLocalModels([model("local:a")] as never);

    expect(written.map((m) => m.id)).toEqual(["local:a"]);
  });
});

describe("Feature: zoc-agent-chat-rebuild, task 22.1: the hardware-fit probe (R13.6)", () => {
  it("judges against the offload count the model would actually load with", async () => {
    const models = await load();

    await models.localModelFit({ path: "/models/a.gguf" });
    // The default is llama.cpp's "offload everything", so the verdict is judged
    // against video memory — which is the case a RAM-only reading gets wrong on a
    // 64 GB machine with 4 GB of VRAM.
    expect(bridge.localModelHardwareFit).toHaveBeenCalledWith(
      "/models/a.gguf",
      models.DEFAULT_N_GPU_LAYERS,
    );

    await models.localModelFit({ path: "/models/b.gguf", n_gpu_layers: 0 });
    expect(bridge.localModelHardwareFit).toHaveBeenLastCalledWith("/models/b.gguf", 0);
  });

  it("omits a model with no verdict rather than inventing one", async () => {
    bridge.localModelHardwareFit.mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith("a.gguf")
          ? {
              state: "tight",
              reason: "Little headroom after loading.",
              model_size_gb: 7,
              required_gb: 8.75,
              total_memory_gb: 16,
              available_memory_gb: 9,
              vram_gb: null,
              n_gpu_layers: 99,
              gpu_bound: false,
            }
          : null,
      ),
    );
    const models = await load();

    const fits = await models.localModelFits([model("local:a"), model("local:b")] as never);

    // "fits" for an unmeasurable model would be a guess presented as a
    // measurement; an absent entry renders as no fit state at all.
    expect(fits.get("local:a")?.state).toBe("tight");
    expect(fits.has("local:b")).toBe(false);
  });
});
