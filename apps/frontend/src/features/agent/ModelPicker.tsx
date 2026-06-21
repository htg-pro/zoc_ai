import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AlertTriangle, BarChart3, ChevronDown, Cpu, Loader2 } from "lucide-react";
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
import { useApp } from "@/lib/store";
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
  const [secretsVersion, setSecretsVersion] = useState(0);
  const [open, setOpen] = useState(false);
  const [benchmarkOpen, setBenchmarkOpen] = useState(false);
  useEffect(() => subscribeSecrets(() => setSecretsVersion((v) => v + 1)), []);
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
      if (!cancelled) setKeyedProviders(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [cloudProviders, secretsVersion, open]);

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
              {localModels.map((m) => (
                <LocalModelItem
                  key={m.id}
                  model={m}
                  active={llamaStatus?.running === true && llamaStatus.loaded_model_id === m.id}
                  onSelect={() => set({ provider: LLAMACPP_PROVIDER, model: m.id })}
                />
              ))}
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
                </DropdownMenuLabel>
                {p.models.length === 0 && (
                  <div className="px-2 py-1 text-[10px] text-muted-foreground">
                    No models — add some in Settings → Providers.
                  </div>
                )}
                {p.models.map((m) => (
                  <DropdownMenuItem
                    key={m.id}
                    onSelect={(e) => {
                      if (!hasKey) {
                        // Don't silently no-op: keep the menu open so the
                        // "configure key" hint stays visible.
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
  onSelect,
}: {
  model: LocalModel;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem onSelect={onSelect} className="flex flex-col items-start gap-0.5">
      <span className="flex w-full items-center justify-between gap-2 font-mono text-xs">
        <span className="truncate">{model.name}</span>
        {active && (
          <span className="shrink-0 text-[9px] uppercase tracking-wider text-emerald-400">
            loaded
          </span>
        )}
      </span>
      <span
        className="truncate font-mono text-[10px] text-muted-foreground"
        title={model.path}
      >
        {model.path}
      </span>
    </DropdownMenuItem>
  );
}
