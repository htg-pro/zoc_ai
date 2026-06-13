import { useEffect, useMemo, useState } from "react";
import { FolderOpen, Plus, Save, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { MOCK_PROVIDERS } from "@/lib/mock-data";
import {
  deriveNameFromPath,
  loadLocalModels,
  loadTaskDefaults,
  makeModelId,
  saveLocalModels,
  saveTaskDefaults,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_N_GPU_LAYERS,
  DEFAULT_N_THREADS,
  DEFAULT_N_BATCH,
  DEFAULT_FLASH_ATTN,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_TEMPERATURE,
  DEFAULT_TOP_P,
  DEFAULT_TOP_K,
  DEFAULT_REPEAT_PENALTY,
  DEFAULT_MAX_TOKENS,
  type LocalModel,
} from "@/lib/local-models";
import { isTauri, pickGgufFile } from "@/lib/tauri-bridge";

const TASKS = [
  { key: "chat", label: "Chat / general", default: "qwen2.5-coder-32b" },
  { key: "edit", label: "Code editing", default: "qwen2.5-coder-32b" },
  { key: "review", label: "Code review", default: "claude-3-5-sonnet" },
  { key: "test", label: "Test generation", default: "gpt-4o-mini" },
  { key: "explain", label: "Explanations", default: "gpt-4o-mini" },
];

export function ModelsSection() {
  const [localModels, setLocalModels] = useState<LocalModel[]>(() => loadLocalModels());
  const [defaults, setDefaults] = useState<Record<string, string>>(() => loadTaskDefaults());

  // Persist on every change so the user doesn't have to hit a global "Save".
  useEffect(() => saveLocalModels(localModels), [localModels]);
  useEffect(() => saveTaskDefaults(defaults), [defaults]);

  const providerModels = useMemo(
    () =>
      MOCK_PROVIDERS.flatMap((p) =>
        p.models.map((m) => ({
          id: m.model_id,
          name: m.display_name,
          provider: p.display_name,
        })),
      ),
    [],
  );

  const localOptions = useMemo(
    () =>
      localModels.map((m) => ({
        id: m.id,
        name: m.name,
        provider: "llama.cpp (local)",
      })),
    [localModels],
  );

  const allOptions = useMemo(
    () => [...localOptions, ...providerModels],
    [localOptions, providerModels],
  );

  const addLocalModel = (model: LocalModel) => {
    setLocalModels((prev) => {
      if (prev.some((m) => m.id === model.id)) {
        toast.message("Model already added", { description: model.path });
        return prev;
      }
      toast.success(`Added ${model.name}`);
      return [...prev, model];
    });
  };

  const removeLocalModel = (id: string) => {
    setLocalModels((prev) => prev.filter((m) => m.id !== id));
    setDefaults((prev) => {
      // If a task was pointing at the deleted model, clear the override so
      // the Select falls back to its hardcoded default instead of showing
      // a dangling value.
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(prev)) if (v !== id) next[k] = v;
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Models</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick a default model for each task type. The agent honours these unless overridden in a session.
        </p>
      </header>

      <LocalModelsCard
        models={localModels}
        onAdd={addLocalModel}
        onRemove={removeLocalModel}
      />

      <Card>
        <CardHeader>
          <CardTitle>Defaults per task</CardTitle>
          <CardDescription>Falls back to chat default if a task is unset.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {TASKS.map((t) => {
            const value = defaults[t.key] ?? t.default;
            return (
              <div key={t.key} className="grid grid-cols-[10rem_1fr] items-center gap-3">
                <Label>{t.label}</Label>
                <Select
                  value={value}
                  onValueChange={(v) => setDefaults((prev) => ({ ...prev, [t.key]: v }))}
                >
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {allOptions.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.name}
                        <span className="ml-2 text-[10px] text-muted-foreground">{m.provider}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}

function LocalModelsCard({
  models,
  onAdd,
  onRemove,
}: {
  models: LocalModel[];
  onAdd: (m: LocalModel) => void;
  onRemove: (id: string) => void;
}) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  // GPU offload layers. llama.cpp interprets `99` as "offload everything",
  // which is the right default for users on a discrete GPU with enough VRAM.
  // Drop it lower if the model doesn't fit; set to 0 to keep everything on
  // CPU.
  const [nGpuLayers, setNGpuLayers] = useState<number>(DEFAULT_N_GPU_LAYERS);
  // Context window in tokens (`--ctx-size`). 8k matches the safe llama.cpp
  // default; bump to 32k+ for models that support it (e.g. Qwen2.5-Coder
  // up to 128k). Drives the memory indicator's denominator and what the
  // sidecar passes to llama-server at load time.
  const [nCtx, setNCtx] = useState<number>(DEFAULT_CONTEXT_WINDOW);
  // CPU threads for computation (`--threads`). Defaults to 8.
  const [nThreads, setNThreads] = useState<number>(DEFAULT_N_THREADS);
  // Logical batch size for prompt processing (`--batch-size`). Defaults to 2048.
  const [nBatch, setNBatch] = useState<number>(DEFAULT_N_BATCH);
  // Flash Attention optimization (`--flash-attn`). Disabled by default.
  const [flashAttn, setFlashAttn] = useState<boolean>(DEFAULT_FLASH_ATTN);
  // Host address for llama-server to bind (`--host`). Defaults to 127.0.0.1.
  const [host, setHost] = useState<string>(DEFAULT_HOST);
  // Port for llama-server to listen on (`--port`). Defaults to 8080.
  const [port, setPort] = useState<number>(DEFAULT_PORT);
  const [temperature, setTemperature] = useState<number>(DEFAULT_TEMPERATURE);
  const [topP, setTopP] = useState<number>(DEFAULT_TOP_P);
  const [topK, setTopK] = useState<number>(DEFAULT_TOP_K);
  const [repeatPenalty, setRepeatPenalty] = useState<number>(DEFAULT_REPEAT_PENALTY);
  const [maxTokens, setMaxTokens] = useState<number>(DEFAULT_MAX_TOKENS);
  // Tracks whether the user has manually edited the name field so we stop
  // overwriting their value as they continue typing the path.
  const [nameTouched, setNameTouched] = useState(false);

  const browse = async () => {
    if (!isTauri()) {
      toast.message("File picker requires the desktop app", {
        description: "Paste an absolute path manually for now.",
      });
      return;
    }
    const picked = await pickGgufFile(path || null);
    if (picked) {
      setPath(picked);
      if (!nameTouched) setName(deriveNameFromPath(picked));
    }
  };

  const onPathChange = (next: string) => {
    setPath(next);
    if (!nameTouched) setName(deriveNameFromPath(next));
  };

  const onNameChange = (next: string) => {
    setName(next);
    setNameTouched(true);
  };

  const save = () => {
    const trimmedPath = path.trim();
    const trimmedName = name.trim() || deriveNameFromPath(trimmedPath);
    if (!trimmedPath) {
      toast.error("Pick or paste a .gguf file path first.");
      return;
    }
    if (!/\.gguf$/i.test(trimmedPath)) {
      toast.error("Path must end in .gguf");
      return;
    }
    const clampedLayers = Math.max(0, Math.min(999, Math.floor(nGpuLayers)));
    const clampedCtx = Math.max(512, Math.min(2_000_000, Math.floor(nCtx)));
    const clampedThreads = Math.max(1, Math.min(256, Math.floor(nThreads)));
    const clampedBatch = Math.max(1, Math.min(65536, Math.floor(nBatch)));
    const clampedPort = Math.max(1, Math.min(65535, Math.floor(port)));
    const tempValue = Number.isFinite(temperature) ? temperature : DEFAULT_TEMPERATURE;
    const topPValue = Number.isFinite(topP) ? topP : DEFAULT_TOP_P;
    const topKValue = Number.isFinite(topK) ? topK : DEFAULT_TOP_K;
    const repeatValue = Number.isFinite(repeatPenalty) ? repeatPenalty : DEFAULT_REPEAT_PENALTY;
    const maxTokensValue = Number.isFinite(maxTokens) ? maxTokens : DEFAULT_MAX_TOKENS;
    const clampedTemperature = Math.max(0, Math.min(5, tempValue));
    const clampedTopP = Math.max(0, Math.min(1, topPValue));
    const clampedTopK = Math.max(0, Math.min(10_000, Math.floor(topKValue)));
    const clampedRepeatPenalty = Math.max(0.5, Math.min(2, repeatValue));
    const clampedMaxTokens = Math.max(1, Math.min(2_000_000, Math.floor(maxTokensValue)));
    onAdd({
      id: makeModelId(trimmedPath),
      name: trimmedName,
      path: trimmedPath,
      n_gpu_layers: clampedLayers,
      n_ctx: clampedCtx,
      n_threads: clampedThreads,
      n_batch: clampedBatch,
      flash_attn: flashAttn,
      host: host,
      port: clampedPort,
      temperature: clampedTemperature,
      top_p: clampedTopP,
      top_k: clampedTopK,
      repeat_penalty: clampedRepeatPenalty,
      max_tokens: clampedMaxTokens,
    });
    setPath("");
    setName("");
    setNGpuLayers(DEFAULT_N_GPU_LAYERS);
    setNCtx(DEFAULT_CONTEXT_WINDOW);
    setNThreads(DEFAULT_N_THREADS);
    setNBatch(DEFAULT_N_BATCH);
    setFlashAttn(DEFAULT_FLASH_ATTN);
    setHost(DEFAULT_HOST);
    setPort(DEFAULT_PORT);
    setTemperature(DEFAULT_TEMPERATURE);
    setTopP(DEFAULT_TOP_P);
    setTopK(DEFAULT_TOP_K);
    setRepeatPenalty(DEFAULT_REPEAT_PENALTY);
    setMaxTokens(DEFAULT_MAX_TOKENS);
    setNameTouched(false);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Local llama.cpp models
          <Badge variant="success">local</Badge>
        </CardTitle>
        <CardDescription>
          Register `.gguf` weights you've downloaded. Saved paths show up in the per-task picker below.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-1.5">
          <Label htmlFor="gguf-path">.gguf file path</Label>
          <div className="flex gap-1.5">
            <Input
              id="gguf-path"
              value={path}
              onChange={(e) => onPathChange(e.target.value)}
              placeholder="/models/Qwen2.5-Coder-32B-Q4_K_M.gguf"
              className="font-mono text-xs"
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
              }}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void browse()}
              title="Browse for a .gguf file"
            >
              <FolderOpen className="mr-1 h-3 w-3" /> Browse
            </Button>
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="gguf-name">Display name</Label>
          <Input
            id="gguf-name"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="Auto-filled from filename"
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="gguf-ngl">GPU layers (VRAM offload)</Label>
          <Input
            id="gguf-ngl"
            type="number"
            min={0}
            max={999}
            value={Number.isFinite(nGpuLayers) ? nGpuLayers : DEFAULT_N_GPU_LAYERS}
            onChange={(e) => setNGpuLayers(Number(e.target.value))}
            className="font-mono"
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
          />
          <p className="text-[10px] text-muted-foreground">
            How many transformer layers llama.cpp offloads to GPU. {DEFAULT_N_GPU_LAYERS} means
            "offload everything" (fastest, most VRAM). Drop it lower if the model OOMs.
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="gguf-ctx">Context window (tokens)</Label>
          <Input
            id="gguf-ctx"
            type="number"
            min={512}
            max={2_000_000}
            step={1024}
            value={Number.isFinite(nCtx) ? nCtx : DEFAULT_CONTEXT_WINDOW}
            onChange={(e) => setNCtx(Number(e.target.value))}
            className="font-mono"
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
          />
          <p className="text-[10px] text-muted-foreground">
            Passed to llama-server as <code className="font-mono">--ctx-size</code> and shown in
            the chat-box memory indicator. Defaults to {DEFAULT_CONTEXT_WINDOW}; raise to 32 768 or
            higher for long-context models like Qwen2.5-Coder.
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="gguf-threads">CPU threads</Label>
          <Input
            id="gguf-threads"
            type="number"
            min={1}
            max={256}
            value={Number.isFinite(nThreads) ? nThreads : DEFAULT_N_THREADS}
            onChange={(e) => setNThreads(Number(e.target.value))}
            className="font-mono"
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
          />
          <p className="text-[10px] text-muted-foreground">
            Passed to llama-server as <code className="font-mono">--threads</code>. Number of CPU
            threads for computation. Defaults to {DEFAULT_N_THREADS}.
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="gguf-batch">Batch size</Label>
          <Input
            id="gguf-batch"
            type="number"
            min={1}
            max={65536}
            value={Number.isFinite(nBatch) ? nBatch : DEFAULT_N_BATCH}
            onChange={(e) => setNBatch(Number(e.target.value))}
            className="font-mono"
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
          />
          <p className="text-[10px] text-muted-foreground">
            Passed to llama-server as <code className="font-mono">--batch-size</code>. Logical
            batch size for prompt processing. Defaults to {DEFAULT_N_BATCH}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            id="gguf-flash-attn"
            type="checkbox"
            checked={flashAttn}
            onChange={(e) => setFlashAttn(e.target.checked)}
            className="h-4 w-4"
          />
          <Label htmlFor="gguf-flash-attn" className="cursor-pointer">
            Enable Flash Attention
          </Label>
        </div>
        <p className="text-[10px] text-muted-foreground">
          Passed to llama-server as <code className="font-mono">--flash-attn</code>. Flash Attention
          optimization. May improve performance on compatible hardware.
        </p>
        <div className="grid gap-1.5">
          <Label htmlFor="gguf-host">Host address</Label>
          <Input
            id="gguf-host"
            type="text"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            className="font-mono"
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
          />
          <p className="text-[10px] text-muted-foreground">
            Passed to llama-server as <code className="font-mono">--host</code>. Use 127.0.0.1 for
            localhost only or 0.0.0.0 for all interfaces. Defaults to {DEFAULT_HOST}.
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="gguf-port">Port</Label>
          <Input
            id="gguf-port"
            type="number"
            min={1}
            max={65535}
            value={Number.isFinite(port) ? port : DEFAULT_PORT}
            onChange={(e) => setPort(Number(e.target.value))}
            className="font-mono"
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
          />
          <p className="text-[10px] text-muted-foreground">
            Passed to llama-server as <code className="font-mono">--port</code>. Port for
            llama-server to listen on. Defaults to {DEFAULT_PORT}.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="gguf-temperature">Temperature</Label>
            <Input
              id="gguf-temperature"
              type="number"
              min={0}
              max={5}
              step={0.05}
              value={Number.isFinite(temperature) ? temperature : DEFAULT_TEMPERATURE}
              onChange={(e) => setTemperature(Number(e.target.value))}
              className="font-mono"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="gguf-top-p">Top-p</Label>
            <Input
              id="gguf-top-p"
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={Number.isFinite(topP) ? topP : DEFAULT_TOP_P}
              onChange={(e) => setTopP(Number(e.target.value))}
              className="font-mono"
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="gguf-repeat-penalty">Repeat penalty</Label>
            <Input
              id="gguf-repeat-penalty"
              type="number"
              min={0.5}
              max={2}
              step={0.05}
              value={Number.isFinite(repeatPenalty) ? repeatPenalty : DEFAULT_REPEAT_PENALTY}
              onChange={(e) => setRepeatPenalty(Number(e.target.value))}
              className="font-mono"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="gguf-top-k">Top-k</Label>
            <Input
              id="gguf-top-k"
              type="number"
              min={0}
              max={10_000}
              step={1}
              value={Number.isFinite(topK) ? topK : DEFAULT_TOP_K}
              onChange={(e) => setTopK(Number(e.target.value))}
              className="font-mono"
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="gguf-max-tokens">Max tokens</Label>
            <Input
              id="gguf-max-tokens"
              type="number"
              min={1}
              max={2_000_000}
              step={256}
              value={Number.isFinite(maxTokens) ? maxTokens : DEFAULT_MAX_TOKENS}
              onChange={(e) => setMaxTokens(Number(e.target.value))}
              className="font-mono"
            />
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground">
          Sent with each local chat request to llama-server through the sidecar.
        </p>
        <div className="flex justify-end">
          <Button size="sm" onClick={save}>
            <Plus className="mr-1 h-3 w-3" /> Add model
          </Button>
        </div>

        {models.length > 0 && (
          <div className="mt-2 space-y-1.5 border-t border-border pt-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Saved models
            </div>
            <ul className="space-y-1.5">
              {models.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-border bg-card/40 px-2.5 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-xs font-medium">{m.name}</span>
                      <span className="text-[10px] text-muted-foreground">
                        ngl={m.n_gpu_layers ?? DEFAULT_N_GPU_LAYERS}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        ctx={m.n_ctx ?? DEFAULT_CONTEXT_WINDOW}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        top-k={m.top_k ?? DEFAULT_TOP_K}
                      </span>
                    </div>
                    <div className="truncate font-mono text-[10px] text-muted-foreground">
                      {m.path}
                    </div>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    aria-label={`Remove ${m.name}`}
                    onClick={() => onRemove(m.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {models.length === 0 && (
          <div className="flex items-center gap-1.5 rounded border border-dashed border-border px-2.5 py-2 text-[11px] text-muted-foreground">
            <Save className="h-3 w-3" />
            No local models saved yet.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
