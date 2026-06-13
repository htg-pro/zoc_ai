import { useEffect, useState } from "react";
import type {
  EmbedderInfo,
  EmbeddingProvider,
  EmbeddingSettings,
  IndexConfig,
} from "@llama-studio/shared-types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { getAgentClient } from "@/lib/agent-client";
import { useApp } from "@/lib/store";

interface ProviderChoice {
  value: EmbeddingProvider;
  label: string;
  description: string;
  defaultModel?: string;
  modelEditable: boolean;
}

const PROVIDER_CHOICES: ProviderChoice[] = [
  {
    value: "auto",
    label: "Auto",
    description: "Prefer a local llama.cpp embedding model, fall back to OpenAI, then the hash stub.",
    modelEditable: false,
  },
  {
    value: "openai",
    label: "OpenAI",
    description: "Cloud — requires an OpenAI API key.",
    defaultModel: "text-embedding-3-small",
    modelEditable: true,
  },
  {
    value: "llamacpp",
    label: "llama.cpp (local)",
    description: "Embeddings server exposed by a local llama.cpp build.",
    defaultModel: "nomic-embed-text",
    modelEditable: true,
  },
  {
    value: "hash",
    label: "Hash fallback",
    description: "Deterministic, dependency-free. Search works but quality is modest.",
    modelEditable: false,
  },
];

const PROVIDER_BY_VALUE = new Map(PROVIDER_CHOICES.map((c) => [c.value, c]));

const parseGlobs = (s: string): string[] =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const globsKey = (g: string[]): string => g.join(",");

const extractErrorDetail = (message: string): string => {
  const match = message.match(/\{.*\}/s);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as { detail?: unknown };
      if (typeof parsed.detail === "string") return parsed.detail;
    } catch {
      // fall through to the raw message
    }
  }
  return message;
};

export function IndexerSection() {
  const sessionId = useApp((s) => s.activeSessionId);
  const [root, setRoot] = useState("");
  const [exclude, setExclude] = useState("");
  const [watch, setWatch] = useState(false);
  const [indexInitial, setIndexInitial] = useState<IndexConfig | null>(null);
  const [savingIndex, setSavingIndex] = useState(false);
  const [rootError, setRootError] = useState<string | null>(null);

  const [provider, setProvider] = useState<EmbeddingProvider>("auto");
  const [model, setModel] = useState("");
  const [initial, setInitial] = useState<EmbeddingSettings | null>(null);
  const [active, setActive] = useState<EmbedderInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadActiveEmbedder = async () => {
    if (!sessionId) {
      setActive(null);
      return;
    }
    try {
      const client = await getAgentClient();
      const status = await client.indexStatus(sessionId);
      setActive(status.embedder ?? null);
    } catch {
      setActive(null);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const client = await getAgentClient();
        const snap = await client.getSettings();
        if (cancelled) return;
        setProvider(snap.embedding.provider);
        setModel(snap.embedding.model ?? "");
        setInitial(snap.embedding);
      } catch (err) {
        if (!cancelled) {
          toast.error(`Couldn't load settings: ${(err as Error).message}`);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
      if (!cancelled) await loadActiveEmbedder();
      if (!cancelled && sessionId) {
        try {
          const client = await getAgentClient();
          const cfg = await client.getIndexConfig(sessionId);
          if (cancelled) return;
          setRoot(cfg.workspace_root);
          setExclude(globsKey(cfg.exclude_globs));
          setWatch(cfg.watch);
          setIndexInitial(cfg);
        } catch (err) {
          if (!cancelled) {
            toast.error(`Couldn't load workspace config: ${(err as Error).message}`);
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const choice = PROVIDER_BY_VALUE.get(provider) ?? PROVIDER_CHOICES[0];
  const effectiveModel = model.trim() || choice.defaultModel || "";
  const dirty =
    initial !== null &&
    (provider !== initial.provider || (model.trim() || null) !== (initial.model ?? null));

  const indexDirty =
    indexInitial !== null &&
    (root.trim() !== indexInitial.workspace_root ||
      globsKey(parseGlobs(exclude)) !== globsKey(indexInitial.exclude_globs) ||
      watch !== indexInitial.watch);

  const saveWorkspace = async () => {
    if (!sessionId) return;
    setSavingIndex(true);
    setRootError(null);
    try {
      const client = await getAgentClient();
      const cfg = await client.updateIndexConfig(sessionId, {
        workspace_root: root.trim() || undefined,
        exclude_globs: parseGlobs(exclude),
        watch,
      });
      setRoot(cfg.workspace_root);
      setExclude(globsKey(cfg.exclude_globs));
      setWatch(cfg.watch);
      setIndexInitial(cfg);
      toast.success("Workspace settings saved — reindex started");
      void loadActiveEmbedder();
    } catch (err) {
      const detail = extractErrorDetail((err as Error).message);
      setRootError(detail);
      toast.error(`Save failed: ${detail}`);
    } finally {
      setSavingIndex(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const client = await getAgentClient();
      const snap = await client.updateSettings({
        embedding: { provider, model: model.trim() || null },
      });
      setProvider(snap.embedding.provider);
      setModel(snap.embedding.model ?? "");
      setInitial(snap.embedding);
      toast.success("Embedding settings saved — reindex started in background");
      void loadActiveEmbedder();
    } catch (err) {
      toast.error(`Save failed: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Indexer</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Control which folders are scanned and which embedding model is used for semantic search.
        </p>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>Workspace</CardTitle>
          <CardDescription>Root folder, exclusions, and file watcher.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {!sessionId && (
            <p className="text-xs text-muted-foreground">
              Open or create a session to configure its workspace index.
            </p>
          )}
          <div className="grid gap-1.5">
            <Label>Workspace root</Label>
            <Input
              value={root}
              onChange={(e) => {
                setRoot(e.target.value);
                if (rootError) setRootError(null);
              }}
              className="font-mono"
              aria-invalid={rootError !== null}
              disabled={!sessionId || indexInitial === null}
            />
            {rootError && <p className="text-xs text-destructive">{rootError}</p>}
          </div>
          <div className="grid gap-1.5">
            <Label>Exclude globs</Label>
            <Input
              value={exclude}
              onChange={(e) => setExclude(e.target.value)}
              className="font-mono"
              placeholder="comma-separated"
              disabled={!sessionId || indexInitial === null}
            />
            <p className="text-xs text-muted-foreground">
              Comma-separated names or globs (e.g. <span className="font-mono">node_modules</span>,{" "}
              <span className="font-mono">*.log</span>). Matched files are skipped during indexing.
            </p>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label>Watch for changes</Label>
              <p className="text-xs text-muted-foreground">Re-index on file save.</p>
            </div>
            <Switch
              checked={watch}
              onCheckedChange={setWatch}
              disabled={!sessionId || indexInitial === null}
            />
          </div>
          <div className="flex justify-end">
            <Button onClick={saveWorkspace} disabled={savingIndex || !sessionId || !indexDirty}>
              {savingIndex ? "Saving…" : "Save"}
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Embeddings</CardTitle>
          <CardDescription>Used for semantic chunk retrieval.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {active && (
            <div
              className={
                active.is_fallback
                  ? "rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs"
                  : "rounded-md border border-border bg-muted/40 p-3 text-xs"
              }
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Currently active</span>
                <span className="font-mono">
                  {active.model ? `${active.kind} · ${active.model}` : active.kind} ({active.dim}-dim)
                </span>
              </div>
              {active.is_fallback && (
                <p className="mt-2 text-amber-600 dark:text-amber-400">
                  No real embedding model is configured, so semantic search is running on the
                  deterministic <span className="font-mono">hash</span> fallback — results will be
                  much weaker. Run llama-server with an embedding model like{" "}
                  <code className="font-mono">nomic-embed-text.gguf</code>, or add an OpenAI
                  key, then choose that provider below.
                </p>
              )}
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="embedding-provider">Provider</Label>
            <Select
              value={provider}
              onValueChange={(v) => {
                const next = v as EmbeddingProvider;
                setProvider(next);
                const target = PROVIDER_BY_VALUE.get(next);
                if (target && !target.modelEditable) setModel("");
              }}
              disabled={loading}
            >
              <SelectTrigger id="embedding-provider">
                <SelectValue placeholder="Select a provider" />
              </SelectTrigger>
              <SelectContent>
                {PROVIDER_CHOICES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{choice.description}</p>
          </div>
          {choice.modelEditable && (
            <div className="grid gap-1.5">
              <Label htmlFor="embedding-model">Model</Label>
              <Input
                id="embedding-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={choice.defaultModel ?? "Provider default"}
                className="font-mono"
                disabled={loading}
              />
              <p className="text-xs text-muted-foreground">
                Leave blank to use the default ({choice.defaultModel ?? "provider default"}).
                Active: <span className="font-mono">{effectiveModel || "—"}</span>
              </p>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Changing the embedder triggers a reindex automatically — existing vectors are
            incompatible with a different model.
          </p>
        </CardContent>
      </Card>
      <div className="flex justify-end">
        <Button onClick={save} disabled={saving || loading || !dirty}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
