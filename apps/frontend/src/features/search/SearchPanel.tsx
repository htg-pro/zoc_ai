import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  Regex,
  Replace,
  Sparkles,
  Undo2,
  WholeWord,
} from "lucide-react";
import type { EmbedderInfo, IndexQueryResult } from "@llama-studio/shared-types";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useApp } from "@/lib/store";
import { getAgentClient } from "@/lib/agent-client";
import { isTauri, type FileReplace, type SearchOptions, type SearchResults } from "@/lib/tauri-bridge";
import { basename } from "@/lib/paths";
import { cn } from "@/lib/utils";

type Mode = "text" | "semantic";

function splitGlobs(s: string): string[] {
  return s
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);
}

export function SearchPanel() {
  const tauri = isTauri();
  const [mode, setMode] = useState<Mode>(tauri ? "text" : "semantic");
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <ModeTab active={mode === "text"} onClick={() => setMode("text")} disabled={!tauri}>
          Text
        </ModeTab>
        <ModeTab active={mode === "semantic"} onClick={() => setMode("semantic")}>
          <Sparkles className="mr-1 h-3 w-3" />
          Semantic
        </ModeTab>
      </div>
      {mode === "text" ? <TextSearch /> : <SemanticSearch />}
    </div>
  );
}

function ModeTab({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex items-center rounded px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-40",
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function Toggle({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "flex h-5 w-5 items-center justify-center rounded border text-muted-foreground transition-colors",
        active
          ? "border-primary/50 bg-primary/15 text-primary"
          : "border-transparent hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function HighlightedLine({ text, start, end }: { text: string; start: number; end: number }) {
  const a = text.slice(0, start);
  const m = text.slice(start, end);
  const b = text.slice(end);
  return (
    <code className="block truncate font-mono text-[11px] text-muted-foreground">
      {a}
      <mark className="rounded-sm bg-warning/30 px-0.5 text-foreground">{m}</mark>
      {b}
    </code>
  );
}

function TextSearch() {
  const openFile = useApp((s) => s.openFile);
  const searchWorkspace = useApp((s) => s.searchWorkspace);
  const previewReplace = useApp((s) => s.previewReplace);
  const applyReplace = useApp((s) => s.applyReplace);
  const undoLastReplace = useApp((s) => s.undoLastReplace);
  const canUndo = useApp((s) => s.lastReplaceUndo !== null);

  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [isRegex, setIsRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [includes, setIncludes] = useState("");
  const [excludes, setExcludes] = useState("");

  const [results, setResults] = useState<SearchResults | null>(null);
  const [previews, setPreviews] = useState<FileReplace[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  const options: SearchOptions = useMemo(
    () => ({
      query,
      is_regex: isRegex,
      case_sensitive: caseSensitive,
      whole_word: wholeWord,
      includes: splitGlobs(includes),
      excludes: splitGlobs(excludes),
      use_gitignore: true,
    }),
    [query, isRegex, caseSensitive, wholeWord, includes, excludes],
  );

  const replacing = showReplace && replacement.length > 0;

  useEffect(() => {
    if (query.trim().length < 1) {
      setResults(null);
      setPreviews(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const handle = setTimeout(async () => {
      const res = await searchWorkspace(options);
      if (cancelled) return;
      setResults(res);
      if (replacing) {
        const pv = await previewReplace({ ...options, replacement });
        if (!cancelled) setPreviews(pv);
      } else {
        setPreviews(null);
      }
      setLoading(false);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [options, replacing, replacement, searchWorkspace, previewReplace, query]);

  const fileCount = results?.files.length ?? 0;
  const total = results?.total ?? 0;
  const status = !query.trim()
    ? "Type to search the workspace"
    : loading
      ? "Searching…"
      : `${total} result${total === 1 ? "" : "s"} in ${fileCount} file${fileCount === 1 ? "" : "s"}${
          results?.truncated ? " (truncated)" : ""
        }`;

  const doReplaceAll = async () => {
    setBusy(true);
    await applyReplace({ ...options, replacement });
    setBusy(false);
  };
  const doReplaceFile = async (file: string) => {
    setBusy(true);
    await applyReplace({ ...options, replacement, paths: [file] });
    setBusy(false);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-1.5 px-2 py-2">
        <div className="flex items-start gap-1">
          <button
            type="button"
            onClick={() => setShowReplace((v) => !v)}
            className="mt-1 text-muted-foreground hover:text-foreground"
            title="Toggle Replace"
            aria-label="Toggle replace"
          >
            <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", showReplace && "rotate-90")} />
          </button>
          <div className="flex-1 space-y-1.5">
            <div className="relative">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                className="h-7 pr-[68px] text-xs"
              />
              <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
                <Toggle active={caseSensitive} label="Match Case" onClick={() => setCaseSensitive((v) => !v)}>
                  <CaseSensitive className="h-3.5 w-3.5" />
                </Toggle>
                <Toggle active={wholeWord} label="Match Whole Word" onClick={() => setWholeWord((v) => !v)}>
                  <WholeWord className="h-3.5 w-3.5" />
                </Toggle>
                <Toggle active={isRegex} label="Use Regular Expression" onClick={() => setIsRegex((v) => !v)}>
                  <Regex className="h-3.5 w-3.5" />
                </Toggle>
              </div>
            </div>
            {showReplace && (
              <div className="flex items-center gap-1">
                <Input
                  value={replacement}
                  onChange={(e) => setReplacement(e.target.value)}
                  placeholder="Replace"
                  className="h-7 text-xs"
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 shrink-0"
                  title="Replace All"
                  aria-label="Replace All"
                  disabled={busy || total === 0 || !replacement}
                  onClick={() => void doReplaceAll()}
                >
                  <Replace className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={() => setShowOptions((v) => !v)}
          className="flex items-center gap-1 pl-5 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className={cn("h-3 w-3 transition-transform", !showOptions && "-rotate-90")} />
          Files to include / exclude
        </button>
        {showOptions && (
          <div className="space-y-1 pl-5">
            <Input
              value={includes}
              onChange={(e) => setIncludes(e.target.value)}
              placeholder="files to include, e.g. src/**, *.ts"
              className="h-6 font-mono text-[11px]"
            />
            <Input
              value={excludes}
              onChange={(e) => setExcludes(e.target.value)}
              placeholder="files to exclude, e.g. *.test.ts"
              className="h-6 font-mono text-[11px]"
            />
          </div>
        )}
      </div>

      <div className="flex items-center justify-between px-2 pb-1">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{status}</span>
        {canUndo && (
          <Button
            size="sm"
            variant="ghost"
            className="h-5 px-1.5 text-[10px]"
            onClick={() => void undoLastReplace()}
          >
            <Undo2 className="mr-1 h-3 w-3" /> Undo replace
          </Button>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1 px-2 pb-3">
          {results?.files.map((fm) => {
            const isCollapsed = collapsed[fm.file];
            const filePreview = previews?.find((p) => p.file === fm.file);
            return (
              <div key={fm.file} className="rounded border border-border/60 bg-card/40">
                <div className="flex items-center gap-1 px-1.5 py-1">
                  <button
                    type="button"
                    onClick={() => setCollapsed((c) => ({ ...c, [fm.file]: !c[fm.file] }))}
                    className="flex min-w-0 flex-1 items-center gap-1 text-left"
                  >
                    <ChevronRight
                      className={cn("h-3 w-3 shrink-0 transition-transform", !isCollapsed && "rotate-90")}
                    />
                    <span className="truncate font-mono text-[11px] text-foreground" title={fm.file}>
                      {basename(fm.file)}
                    </span>
                    <Badge variant="muted" className="ml-auto shrink-0">
                      {fm.matches.length}
                    </Badge>
                  </button>
                  {replacing && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-5 w-5 shrink-0"
                      title="Replace in this file"
                      aria-label={`Replace in ${basename(fm.file)}`}
                      disabled={busy}
                      onClick={() => void doReplaceFile(fm.file)}
                    >
                      <Replace className="h-3 w-3" />
                    </Button>
                  )}
                </div>
                {!isCollapsed && (
                  <div className="space-y-0.5 px-1.5 pb-1.5">
                    {filePreview
                      ? filePreview.previews.map((lp) => (
                          <div key={lp.line} className="rounded px-1 py-0.5 text-[11px]">
                            <span className="mr-1 font-mono text-[10px] text-muted-foreground">
                              {lp.line}
                            </span>
                            <code className="block truncate font-mono text-destructive line-through">
                              {lp.before}
                            </code>
                            <code className="block truncate font-mono text-success">{lp.after}</code>
                          </div>
                        ))
                      : fm.matches.map((m, i) => (
                          <button
                            key={`${m.line}:${m.column}:${i}`}
                            type="button"
                            onClick={() => void openFile(fm.file)}
                            className="flex w-full items-baseline gap-1.5 rounded px-1 py-0.5 text-left hover:bg-accent"
                          >
                            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                              {m.line}
                            </span>
                            <HighlightedLine text={m.text} start={m.start} end={m.end} />
                          </button>
                        ))}
                  </div>
                )}
              </div>
            );
          })}
          {!loading && query.trim() && total === 0 && (
            <div className="rounded border border-dashed border-border p-3 text-xs text-muted-foreground">
              No results found.
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

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

function SemanticSearch() {
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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-2 py-1.5">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search workspace…"
          className="h-7 text-xs"
        />
      </div>
      <div className="px-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground">{status}</div>
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
                <div className="mt-0.5 truncate font-mono text-[10px] text-primary/80">{h.symbol}</div>
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
