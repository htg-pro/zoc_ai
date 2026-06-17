import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Plus,
  Search,
  SplitSquareHorizontal,
  Terminal as TerminalIcon,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useApp } from "@/lib/store";
import {
  createTerminal,
  disposeTerminal,
  findInTerminal,
  hasTerminal,
  killTerminal,
  mountTerminal,
  setTerminalCallbacks,
  unmountTerminal,
} from "@/lib/terminal-manager";
import { cn } from "@/lib/utils";

export function TerminalPane() {
  const terminals = useApp((s) => s.terminals);
  const activeId = useApp((s) => s.activeTerminalId);
  const profiles = useApp((s) => s.terminalProfiles);
  const split = useApp((s) => s.terminalSplit);
  const newTerminal = useApp((s) => s.newTerminal);
  const closeTerminal = useApp((s) => s.closeTerminal);
  const setActiveTerminal = useApp((s) => s.setActiveTerminal);
  const renameTerminal = useApp((s) => s.renameTerminal);
  const toggleSplit = useApp((s) => s.toggleTerminalSplit);
  const workspaceRoot = useApp((s) => s.workspaceRoot);

  // Wire manager → store/editor once.
  useEffect(() => {
    setTerminalCallbacks({
      onExit: (id, code) => useApp.getState().setTerminalExited(id, code),
      onOpenLink: (path, line) => {
        const root = useApp.getState().workspaceRoot;
        const abs =
          path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || !root
            ? path
            : `${root.replace(/\/$/, "")}/${path}`;
        void useApp.getState().openFile(abs);
        void line; // line targeting lands with editor navigation (Phase 9)
      },
    });
  }, []);

  // Auto-create the first terminal when the pane first appears with none.
  useEffect(() => {
    if (terminals.length === 0) newTerminal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const profileFor = (profileId: string) => profiles.find((p) => p.id === profileId) ?? profiles[0];

  // Reconcile live instances with store metadata: create missing, dispose removed.
  useEffect(() => {
    for (const t of terminals) {
      if (!hasTerminal(t.id)) void createTerminal(t.id, profileFor(t.profileId), workspaceRoot);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminals]);

  const active = terminals.find((t) => t.id === activeId) ?? null;
  // In split view, show the active terminal + the next one.
  const secondary =
    split && active
      ? terminals[(terminals.findIndex((t) => t.id === active.id) + 1) % terminals.length]
      : null;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-[#0a0a0d]">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-card/40 px-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto" role="tablist">
          {terminals.map((t) => (
            <TerminalTab
              key={t.id}
              title={t.title}
              status={t.status}
              exitCode={t.exitCode}
              active={t.id === activeId}
              onSelect={() => setActiveTerminal(t.id)}
              onClose={() => {
                void disposeTerminal(t.id);
                closeTerminal(t.id);
              }}
              onRename={(title) => renameTerminal(t.id, title)}
            />
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <div className="flex items-center">
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              title="New Terminal"
              aria-label="New Terminal"
              onClick={() => newTerminal()}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex h-6 w-4 items-center justify-center text-muted-foreground hover:text-foreground"
                  aria-label="Select shell profile"
                  title="Select shell profile"
                >
                  <ChevronDown className="h-3 w-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {profiles.map((p) => (
                  <DropdownMenuItem key={p.id} onSelect={() => newTerminal(p.id)}>
                    <TerminalIcon className="mr-2 h-3.5 w-3.5" />
                    {p.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <Button
            size="icon"
            variant="ghost"
            className={cn("h-6 w-6", split && "text-primary")}
            title="Split Terminal"
            aria-label="Split Terminal"
            aria-pressed={split}
            onClick={toggleSplit}
            disabled={terminals.length < 2}
          >
            <SplitSquareHorizontal className="h-3.5 w-3.5" />
          </Button>
          {active && (
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 text-muted-foreground hover:text-destructive"
              title="Kill Terminal"
              aria-label="Kill Terminal"
              onClick={() => void killTerminal(active.id)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {active ? (
          <TerminalSurface key={active.id} id={active.id} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
            No terminal. Click + to open one.
          </div>
        )}
        {secondary && secondary.id !== active?.id && (
          <>
            <div className="w-px bg-border" />
            <TerminalSurface key={secondary.id} id={secondary.id} />
          </>
        )}
      </div>
    </div>
  );
}

/** Mounts a manager-owned terminal container into the DOM; unmounts (without
 *  disposing) on unmount so the session survives tab switches. Hosts a find box. */
function TerminalSurface({ id }: { id: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    let cancelled = false;
    // The instance may still be spawning; poll briefly until it exists.
    const attach = () => {
      if (cancelled) return;
      if (hasTerminal(id)) mountTerminal(id, el);
      else setTimeout(attach, 50);
    };
    attach();
    return () => {
      cancelled = true;
      unmountTerminal(id);
    };
  }, [id]);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {finding && (
        <div className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded border border-border bg-card px-1 py-0.5 shadow">
          <Search className="h-3 w-3 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") findInTerminal(id, query, e.shiftKey ? "prev" : "next");
              else if (e.key === "Escape") setFinding(false);
            }}
            placeholder="Find"
            className="h-6 w-40 text-[11px]"
          />
          <button type="button" aria-label="Close find" onClick={() => setFinding(false)}>
            <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
          </button>
        </div>
      )}
      <button
        type="button"
        aria-label="Find in terminal"
        title="Find (Ctrl/Cmd+F)"
        onClick={() => setFinding((v) => !v)}
        className={cn(
          "absolute right-2 top-2 z-20 flex h-5 w-5 items-center justify-center rounded text-muted-foreground/60 hover:bg-accent hover:text-foreground",
          finding && "hidden",
        )}
      >
        <Search className="h-3 w-3" />
      </button>
      <div
        ref={hostRef}
        className="min-h-0 flex-1"
        onKeyDownCapture={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
            e.preventDefault();
            setFinding(true);
          }
        }}
      />
    </div>
  );
}

function TerminalTab({
  title,
  status,
  exitCode,
  active,
  onSelect,
  onClose,
  onRename,
}: {
  title: string;
  status: "running" | "exited";
  exitCode: number | null;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRename: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          onRename(draft);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            onRename(draft);
            setEditing(false);
          } else if (e.key === "Escape") setEditing(false);
        }}
        className="h-6 w-28 rounded border border-primary/50 bg-background px-1 text-[11px] outline-none"
      />
    );
  }

  return (
    <div
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      onDoubleClick={() => {
        setDraft(title);
        setEditing(true);
      }}
      className={cn(
        "group flex h-6 cursor-pointer items-center gap-1.5 rounded px-2 text-[11px]",
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60",
      )}
    >
      <TerminalIcon className="h-3 w-3 shrink-0" />
      <span className="max-w-[140px] truncate">{title}</span>
      {status === "exited" && (
        <span
          className={cn("font-mono text-[9px]", exitCode === 0 ? "text-emerald-500" : "text-destructive")}
          title={`Exited with code ${exitCode ?? "?"}`}
        >
          [{exitCode ?? "?"}]
        </span>
      )}
      <button
        type="button"
        aria-label={`Close ${title}`}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="opacity-0 group-hover:opacity-100"
      >
        <X className="h-3 w-3 hover:text-foreground" />
      </button>
    </div>
  );
}
