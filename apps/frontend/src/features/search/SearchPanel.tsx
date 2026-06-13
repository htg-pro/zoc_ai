import { useEffect, useState } from "react";
import type { EmbedderInfo, IndexQueryResult } from "@llama-studio/shared-types";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useApp } from "@/lib/store";
import { Badge } from "@/components/ui/badge";
import { getAgentClient } from "@/lib/agent-client";

interface Hit {
  path: string;
  line: number;
  snippet: string;
  symbol?: string | null;
  score: number;
}

function firstMeaningfulLine(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (line ?? text.trim()).slice(0, 120);
}

function toHit(r: IndexQueryResult): Hit {
  return {
    path: r.chunk.file,
    line: r.chunk.start_line,
    snippet: firstMeaningfulLine(r.chunk.text),
    symbol: r.chunk.symbol,
    score: r.score,
  };
}

export function SearchPanel() {
  const [q, setQ] = useState("");
  const openFile = useApp((s) => s.openFile);
  const sessionId = useApp((s) => s.activeSessionId);
  const [embedder, setEmbedder] = useState<EmbedderInfo | null>(null);
  const [hits, setHits] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    (async () => {
      try {
        const client = await getAgentClient();
        const status = await client.indexStatus(sessionId);
        if (!cancelled) setEmbedder(status.embedder ?? null);
      } catch {
        /* offline / not wired — silently skip the embedder note */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2 || !sessionId) {
      setHits([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    const handle = setTimeout(async () => {
      try {
        const client = await getAgentClient();
        const results = await client.indexQuery(sessionId, query, 50);
        if (cancelled) return;
        setHits(results.map(toHit));
        setError(null);
      } catch {
        if (cancelled) return;
        setHits([]);
        setError("Couldn't reach the workspace index. Is the agent running?");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [q, sessionId]);

  const trimmed = q.trim();
  const status = !trimmed
    ? "Type to search workspace"
    : loading
      ? "Searching…"
      : `${hits.length} results`;

  return (
    <div className="flex h-full flex-col">
      <div className="px-2 py-1.5">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search workspace…"
          className="h-7 text-xs"
        />
      </div>
      <div className="px-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        {status}
      </div>
      {embedder?.is_fallback && (
        <div className="mx-2 mb-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[10px] leading-snug text-amber-600 dark:text-amber-400">
          Semantic search is using the offline hash fallback — results are weaker. Configure a real
          embedding model in Settings → Indexer.
        </div>
      )}
      <ScrollArea className="flex-1">
        <div className="space-y-2 px-2 pb-3">
          {error && trimmed && (
            <div className="rounded border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
              {error}
            </div>
          )}
          {!error && !loading && hits.length === 0 && trimmed.length >= 2 && (
            <div className="rounded border border-dashed border-border p-3 text-xs text-muted-foreground">
              No matches in the indexed workspace.
            </div>
          )}
          {hits.map((h, i) => (
            <button
              key={`${h.path}:${h.line}:${i}`}
              type="button"
              onClick={() => openFile(h.path)}
              className="block w-full rounded border border-border/60 bg-card/60 p-2 text-left text-xs hover:bg-accent"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-[11px] text-foreground">{h.path}</span>
                <Badge variant="muted">{h.line}</Badge>
              </div>
              {h.symbol && (
                <div className="mt-0.5 truncate font-mono text-[10px] text-primary/80">
                  {h.symbol}
                </div>
              )}
              <code className="mt-1 block truncate font-mono text-[11px] text-muted-foreground">
                {h.snippet}
              </code>
            </button>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
