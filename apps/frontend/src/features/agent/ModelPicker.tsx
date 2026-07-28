import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AlertTriangle, BarChart3, ChevronDown, Cpu, KeyRound, Loader2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  getLocalModelsSnapshot,
  subscribeLocalModels,
  type LocalModel,
} from "@/lib/local-models";
import {
  getProvidersSnapshot,
  subscribeProviders,
} from "@/lib/providers";
import { secureStore, subscribeSecrets } from "@/lib/secure-store";
import { fsStat } from "@/lib/tauri-bridge";
import { useApp } from "@/lib/store";
import { localModelAvailability } from "./model-availability";
import { ModelBenchmarkDialog } from "./ModelBenchmarkDialog";

const LLAMACPP_PROVIDER = "llamacpp";

// `secureStore` writes API keys at `provider.{id}.api_key`. Mirrored from
// apps/frontend/src/features/settings/sections/Providers.tsx so the picker
// and the settings UI agree on the key namespace.
const apiKeyName = (id: string) => `provider.${id}.api_key`;

export function ModelPicker() {
  const selected = useApp((s) => s.selectedModel);
  const set = useApp((s) => s.setSelectedModel);
  const llamaStatus = useApp((s) => s.llamaCppStatus);
  const openSettings = useApp((s) => s.openSettings);
  const invalidProviders = useApp((s) => s.invalidProviders ?? {});
  const clearProviderInvalid = useApp((s) => s.clearProviderInvalid);

  // Subscribe to the local-models store so the picker re-renders the moment
  // a user adds or removes a `.gguf` in Settings → Models, without needing
  // a page reload. The snapshot is cached inside local-models so this is
  // safe for useSyncExternalStore.
  const localModelsRaw = useSyncExternalStore(
    subscribeLocalModels,
    getLocalModelsSnapshot,
    getLocalModelsSnapshot,
  );
  // Stable A–Z order so the dropdown reads the same way every render.
  const localModels = [...localModelsRaw].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );

  // Cloud providers (OpenAI, Google AI Studio, Groq, xAI, Anthropic, custom).
  const cloudProviders = useSyncExternalStore(
    subscribeProviders,
    getProvidersSnapshot,
    getProvidersSnapshot,
  );

  // Track which cloud providers actually have an API key configured. We re-read
  // on three triggers so the badge is never stale: the provider list changes,
  // a key is saved/cleared anywhere (subscribeSecrets), or the menu is opened.
  const [keyedProviders, setKeyedProviders] = useState<Record<string, boolean>>({});
  const [secretChange, setSecretChange] = useState({ version: 0, key: "" });
  const [open, setOpen] = useState(false);
  const [benchmarkOpen, setBenchmarkOpen] = useState(false);
  // R3.7 — existence of each registered `.gguf` on disk. A path we haven't
  // probed yet (or can't stat, e.g. the browser preview) defaults to "present"
  // so the picker never flashes a false "file missing" before the probe lands.
  const [fileExists, setFileExists] = useState<Record<string, boolean>>({});
  useEffect(
    () =>
      subscribeSecrets((key) =>
        setSecretChange((current) => ({ version: current.version + 1, key })),
      ),
    [],
  );

  // Probe each registered GGUF path with `fsStat` (R3.7). Only a definitive
  // `{ exists: false }` marks a model missing; a null stat (no desktop runtime)
  // leaves it "present" so cloud-only / preview users aren't blocked.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        localModels.map(async (m) => {
          try {
            const stat = await fsStat(m.path);
            return [m.path, stat ? stat.exists : true] as const;
          } catch {
            return [m.path, true] as const;
          }
        }),
      );
      if (!cancelled) setFileExists(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
    // Re-probe when the registered set changes or the menu is (re)opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localModelsRaw, open]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const out: Record<string, boolean> = {};
      for (const p of cloudProviders) {
        if (!p.requiresKey) {
          out[p.id] = true;
          continue;
        }
        const v = await secureStore.get(apiKeyName(p.id));
        out[p.id] = !!(v && v.trim());
      }
      if (!cancelled) {
        setKeyedProviders(out);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cloudProviders, secretChange.version, open]);

  // R4.5 — clear only the provider whose API key CHANGED / was re-entered.
  // A change to OpenAI must not make a still-rejected Anthropic key look valid.
  // `version === 0` means no write happened on this mount, so a persisted
  // invalid state is retained until that provider's key is actually edited.
  useEffect(() => {
    if (secretChange.version === 0) return;
    const match = /^provider\.(.+)\.api_key$/.exec(secretChange.key);
    if (match?.[1]) clearProviderInvalid(match[1]);
  }, [clearProviderInvalid, secretChange]);

  const fileExistsFn = (path: string) => fileExists[path] ?? true;

  const builtinCurrent = cloudProviders
    .flatMap((p) => p.models)
    .find((m) => m.id === selected.model);
  const localCurrent = localModels.find((m) => m.id === selected.model);
  const activeLocal = localModels.find((m) => m.id === llamaStatus?.loaded_model_id);
  const triggerLabel =
    localCurrent?.name ??
    activeLocal?.name ??
    builtinCurrent?.name ??
    selected.model ??
    "Select model";

  // Loading / error / loaded badge state for the trigger. We only show llama-
  // server state when the selection is a local model — cloud selections don't
  // touch the supervisor.
  const isLocalSelection =
    selected.provider === LLAMACPP_PROVIDER && (!!localCurrent || !!activeLocal);
  const llamaLoading =
    isLocalSelection &&
    !!llamaStatus &&
    !llamaStatus.running &&
    !llamaStatus.last_error &&
    llamaStatus.loaded_model_id !== selected.model;
  const llamaError = isLocalSelection && !!llamaStatus?.last_error;
  const canBenchmark =
    !!activeLocal &&
    llamaStatus?.running === true &&
    !!llamaStatus.base_url;
  const benchmarkModel = useMemo(
    () => (activeLocal ? { id: activeLocal.id, name: activeLocal.name } : null),
    [activeLocal],
  );

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="inline-flex h-6 max-w-[190px] items-center gap-1 rounded border border-border bg-background px-1.5 text-[11px] hover:bg-accent"
            aria-label="Choose model"
            title={llamaError ? (llamaStatus?.last_error ?? undefined) : undefined}
          >
            {llamaLoading ? (
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
            ) : llamaError ? (
              <AlertTriangle className="h-3 w-3 text-destructive" />
            ) : (
              <Cpu className="h-3 w-3 text-muted-foreground" />
            )}
            <span className="min-w-0 truncate font-mono">{triggerLabel || "Select model"}</span>
            <ChevronDown className="h-3 w-3 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {localModels.length > 0 && (
            <>
              <DropdownMenuLabel>llama.cpp (local)</DropdownMenuLabel>
              {localModels.map((m) => {
                const availability = localModelAvailability(m, llamaStatus, fileExistsFn);
                const missing = availability.kind === "unavailable";
                return (
                  <LocalModelItem
                    key={m.id}
                    model={m}
                    active={llamaStatus?.running === true && llamaStatus.loaded_model_id === m.id}
                    missing={missing}
                    onSelect={() => set({ provider: LLAMACPP_PROVIDER, model: m.id })}
                  />
                );
              })}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!canBenchmark}
                onSelect={() => setBenchmarkOpen(true)}
                className="gap-2"
              >
                <BarChart3 className="h-3.5 w-3.5" />
                <span className="flex min-w-0 flex-col">
                  <span className="text-xs">Benchmark</span>
                  <span className="truncate text-[10px] text-muted-foreground">
                    {activeLocal ? activeLocal.name : "Load a local model first"}
                  </span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {localModels.length === 0 && (
            <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
              No local <code className="font-mono">.gguf</code> registered. Add one in Settings → Models.
            </div>
          )}
          {cloudProviders.map((p, pi) => {
            const hasKey = keyedProviders[p.id] ?? !p.requiresKey;
            const keyInvalid = !!invalidProviders[p.id];
            return (
              <div key={p.id}>
                {pi > 0 && <DropdownMenuSeparator />}
                <DropdownMenuLabel className="flex items-center justify-between">
                  <span>{p.name}</span>
                  {p.requiresKey && !hasKey && (
                    <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
                      no key
                    </span>
                  )}
                  {hasKey && keyInvalid && (
                    <span className="text-[9px] uppercase tracking-wider text-destructive">
                      key invalid
                    </span>
                  )}
                </DropdownMenuLabel>
                {/* Missing key: an interactive row that opens Settings → Providers
                    (R4.4) — never a silent, unactionable hint. */}
                {p.requiresKey && !hasKey && (
                  <DropdownMenuItem
                    onSelect={() => openSettings("providers")}
                    className="gap-2 text-[11px]"
                  >
                    <KeyRound className="h-3.5 w-3.5 text-[#fbbf24]" />
                    Add {p.name} API key in Settings → Providers
                  </DropdownMenuItem>
                )}
                {/* Invalid key: name the provider and offer re-entry (R4.5). */}
                {hasKey && keyInvalid && (
                  <DropdownMenuItem
                    onSelect={() => openSettings("providers")}
                    className="gap-2 text-[11px] text-destructive"
                  >
                    <AlertTriangle className="h-3.5 w-3.5" />
                    {p.name} rejected the key — re-enter it in Settings → Providers
                  </DropdownMenuItem>
                )}
                {p.models.length === 0 && hasKey && (
                  <div className="px-2 py-1 text-[10px] text-muted-foreground">
                    No models — add some in Settings → Providers.
                  </div>
                )}
                {p.models.map((m) => (
                  <DropdownMenuItem
                    key={m.id}
                    disabled={!hasKey}
                    onSelect={(e) => {
                      if (!hasKey) {
                        e.preventDefault();
                        return;
                      }
                      set({ provider: p.id, model: m.id });
                    }}
                    className="flex flex-col items-start gap-0.5"
                  >
                    <span className="font-mono text-xs">{m.name}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {!hasKey ? (
                        <>Configure API key in Settings → Providers</>
                      ) : keyInvalid ? (
                        <span className="text-destructive">Key was rejected — re-enter it</span>
                      ) : (
                        <>
                          {m.contextWindow ? `${(m.contextWindow / 1000).toFixed(0)}k ctx` : "model"}
                          {m.tools && " · tools"}
                          {m.vision && " · vision"}
                        </>
                      )}
                    </span>
                  </DropdownMenuItem>
                ))}
              </div>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <ModelBenchmarkDialog
        open={benchmarkOpen}
        onOpenChange={setBenchmarkOpen}
        model={benchmarkModel}
        baseUrl={canBenchmark ? (llamaStatus?.base_url ?? null) : null}
      />
    </>
  );
}

function LocalModelItem({
  model,
  active,
  missing,
  onSelect,
}: {
  model: LocalModel;
  active: boolean;
  missing: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem
      disabled={missing}
      onSelect={(e) => {
        if (missing) {
          // R3.7 — a model whose `.gguf` is gone can't be loaded; keep the menu
          // open so the "file missing" state stays visible instead of silently
          // selecting an unusable model.
          e.preventDefault();
          return;
        }
        onSelect();
      }}
      className="flex flex-col items-start gap-0.5"
    >
      <span className="flex w-full items-center justify-between gap-2 font-mono text-xs">
        <span className="truncate">{model.name}</span>
        {missing ? (
          <span className="shrink-0 text-[9px] uppercase tracking-wider text-destructive">
            file missing
          </span>
        ) : active ? (
          <span className="shrink-0 text-[9px] uppercase tracking-wider text-emerald-400">
            loaded
          </span>
        ) : null}
      </span>
      <span
        className={
          missing
            ? "truncate font-mono text-[10px] text-destructive"
            : "truncate font-mono text-[10px] text-muted-foreground"
        }
        title={model.path}
      >
        {missing ? `Not found: ${model.path}` : model.path}
      </span>
    </DropdownMenuItem>
  );
}
