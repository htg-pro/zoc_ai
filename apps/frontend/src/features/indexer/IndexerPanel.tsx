import { useCallback, useEffect, useState } from "react";
import { Database, RefreshCw, Activity } from "lucide-react";
import type { IndexStatus } from "@llama-studio/shared-types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { getAgentClient } from "@/lib/agent-client";
import { MOCK_INDEX_STATUS } from "@/lib/mock-data";
import { useApp } from "@/lib/store";
import { track } from "@/lib/telemetry";

export function IndexerPanel() {
  const sessionId = useApp((s) => s.activeSessionId);
  const [status, setStatus] = useState<IndexStatus>(MOCK_INDEX_STATUS);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!sessionId) return;
    try {
      const client = await getAgentClient();
      const s = await client.indexStatus(sessionId);
      setStatus(s);
      setLive(true);
      setError(null);
    } catch (err) {
      setLive(false);
      setError((err as Error).message);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const rebuild = async () => {
    if (!sessionId) return;
    setBusy(true);
    try {
      const client = await getAgentClient();
      const next = await client.indexRebuild(sessionId);
      setStatus(next);
      await track("indexer.rebuilt", { root: status.workspace_root });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col px-3 py-2 text-xs">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-primary" />
          <span className="font-medium">Workspace index</span>
          {!live && <Badge variant="warning">offline</Badge>}
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[11px]"
          onClick={rebuild}
          disabled={busy || !live}
        >
          <RefreshCw className={busy ? "mr-1 h-3 w-3 animate-spin" : "mr-1 h-3 w-3"} /> Reindex
        </Button>
      </div>
      <Separator className="my-2" />
      <dl className="grid grid-cols-2 gap-y-1.5 text-[11px]">
        <dt className="text-muted-foreground">Root</dt>
        <dd className="truncate font-mono">{status.workspace_root}</dd>
        <dt className="text-muted-foreground">Files</dt>
        <dd className="font-mono">{status.file_count.toLocaleString()}</dd>
        <dt className="text-muted-foreground">Chunks</dt>
        <dd className="font-mono">{status.chunk_count.toLocaleString()}</dd>
        <dt className="text-muted-foreground">Last indexed</dt>
        <dd className="font-mono">
          {status.last_indexed_at ? new Date(status.last_indexed_at).toLocaleTimeString() : "—"}
        </dd>
        <dt className="text-muted-foreground">Watching</dt>
        <dd>
          <Badge variant={status.watching ? "success" : "muted"}>
            <Activity className="h-3 w-3" />
            {status.watching ? "Live" : "Off"}
          </Badge>
        </dd>
      </dl>
      <Separator className="my-3" />
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Embedding</div>
      {(() => {
        const emb = status.embedder;
        if (!emb) {
          return (
            <div className="mt-1 rounded border border-border bg-card/60 p-2 text-[11px] text-muted-foreground">
              Embedder unavailable.
            </div>
          );
        }
        const label = emb.model ? `${emb.kind} · ${emb.model}` : emb.kind;
        return (
          <div className="mt-1 rounded border border-border bg-card/60 p-2 text-[11px]">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-mono" title={label}>
                {label}
              </span>
              <Badge variant={emb.is_fallback ? "warning" : "success"}>
                {emb.is_fallback ? "offline fallback" : `${emb.dim}-dim`}
              </Badge>
            </div>
            {emb.is_fallback && (
              <p className="mt-1 text-muted-foreground">
                No real embedding model is configured — semantic search is running on the
                deterministic hash fallback, which gives weaker results. Run llama-server with an
                embedding model like <code className="font-mono">nomic-embed-text.gguf</code>, or set an OpenAI
                key, then pick a provider in Settings → Indexer.
              </p>
            )}
          </div>
        );
      })()}
      {error && (
        <p className="mt-2 text-[10px] text-amber-400">{error}</p>
      )}
    </div>
  );
}
