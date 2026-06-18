import { useEffect, useMemo, useState } from "react";
import type { Session } from "@zoc-studio/shared-types";
import { Check, ChevronsDownUp, Pencil, Pin, PinOff, Plus, Search, Trash2, X } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useApp } from "@/lib/store";
import { groupSessions } from "@/lib/session-query";
import { cn } from "@/lib/utils";

type Group = { key: "pinned" | "today" | "yesterday" | "older"; label: string; sessions: Session[] };

function modelLabel(model: string | null | undefined): string {
  if (!model) return "—";
  const clean = model.replace(/\.gguf$/i, "");
  const quantMatch = model.match(/[._-](Q\d+[_A-Z]*|F16|F32)/i);
  const paramMatch = model.match(/(\d+B|\d+M)/i);
  const quant = quantMatch ? quantMatch[1] : "";
  const param = paramMatch ? paramMatch[1] : "";
  if (param || quant) return [param, quant].filter(Boolean).join(" · ");
  return clean.length > 22 ? `${clean.slice(0, 22)}…` : clean;
}

function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function groupSessionsForPanel(
  sessions: Session[],
  pinned: Record<string, true>,
): Group[] {
  // Compute the display offset and `now` at the component/selector boundary and
  // pass them into the canonical pure `groupSessions` (which never reads the
  // host clock itself). `-getTimezoneOffset()` gives the display-tz offset in
  // minutes east of UTC.
  const now = Date.now();
  const tzOffsetMinutes = -new Date().getTimezoneOffset();
  const pinnedSet = new Set(Object.keys(pinned));

  const grouped = groupSessions(sessions, pinnedSet, now, tzOffsetMinutes);

  const byRecency = (a: Session, b: Session) =>
    new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();

  return [
    { key: "pinned", label: "Pinned", sessions: grouped.pinned.slice().sort(byRecency) },
    { key: "today", label: "Today", sessions: grouped.today.slice().sort(byRecency) },
    { key: "yesterday", label: "Yesterday", sessions: grouped.yesterday.slice().sort(byRecency) },
    { key: "older", label: "Older", sessions: grouped.earlier.slice().sort(byRecency) },
  ];
}

export function SessionsPanel() {
  const sessions = useApp((s) => s.sessions);
  const active = useApp((s) => s.activeSessionId);
  const pinned = useApp((s) => s.pinnedSessions);
  const select = useApp((s) => s.selectSession);
  const setMainView = useApp((s) => s.setMainView);
  const createSession = useApp((s) => s.createSession);
  const renameSession = useApp((s) => s.renameSession);
  const deleteSession = useApp((s) => s.deleteSession);
  const togglePin = useApp((s) => s.togglePinnedSession);
  const workspaceRoot = useApp((s) => s.workspaceRoot);

  const groups = useMemo(() => groupSessionsForPanel(sessions, pinned), [sessions, pinned]);

  const onNew = async () => {
    const root =
      workspaceRoot ??
      sessions.find((s) => s.id === active)?.workspace_root ??
      "/";
    const title = `Session ${new Date().toLocaleTimeString()}`;
    await createSession(title, root);
  };

  const onDelete = async (id: string, title: string) => {
    const ok = window.confirm(`Delete "${title}" and its chat history?`);
    if (!ok) return;
    await deleteSession(id);
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* ── header ──────────────────────────────── */}
      <div className="flex items-center justify-between px-3 pt-3">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
            Sessions
          </span>
          <span className="rounded border border-[hsl(var(--border-muted))] bg-accent px-1 font-mono text-[9.5px] leading-[15px] text-muted-foreground">
            {sessions.length}
          </span>
        </div>
        <button
          type="button"
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground/60 hover:bg-accent hover:text-foreground"
          title="Collapse all"
          aria-label="Collapse all"
        >
          <ChevronsDownUp className="h-3 w-3" />
        </button>
      </div>

      {/* ── search ──────────────────────────────── */}
      <div className="mx-3 mt-2.5 flex h-7 items-center gap-2 rounded-md border border-[hsl(var(--border-muted))] bg-[hsl(var(--background)/0.6)] px-2">
        <Search className="h-3 w-3 shrink-0 text-muted-foreground/50" />
        <span className="text-[11.5px] text-muted-foreground/50">Filter sessions…</span>
      </div>

      {/* ── new session button ──────────────────── */}
      <button
        className="mx-3 mt-2 flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md border border-[hsl(var(--border-muted))] bg-card text-[11.5px] font-medium text-muted-foreground hover:border-muted-foreground/30 hover:bg-accent"
        onClick={onNew}
      >
        <Plus className="h-3 w-3" />
        New session
      </button>

      {/* ── grouped session list ────────────────── */}
      <ScrollArea className="mt-2 min-h-0 flex-1 px-2">
        {groups.map((group) => {
          if (group.sessions.length === 0) return null;
          return (
            <div key={group.key}>
              <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-3">
                {group.key === "pinned" && <Pin className="h-2.5 w-2.5 text-muted-foreground/50" />}
                <span className="text-[9.5px] font-semibold uppercase tracking-[0.09em] text-muted-foreground/60">
                  {group.label}
                </span>
              </div>
              {group.sessions.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  isActive={s.id === active}
                  isPinned={!!pinned[s.id]}
                  onSelect={() => {
                    select(s.id);
                    setMainView("editor");
                  }}
                  onPin={() => togglePin(s.id)}
                  onRename={(title) => renameSession(s.id, title)}
                  onDelete={() => void onDelete(s.id, s.title)}
                />
              ))}
            </div>
          );
        })}
      </ScrollArea>

      {/* ── footer ──────────────────────────────── */}
      <button
        className="flex shrink-0 items-center justify-between border-t border-border px-3.5 py-2.5 text-[11.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={() => setMainView("sessions")}
      >
        <span>Open sessions view</span>
        <span className="text-xs">→</span>
      </button>
    </div>
  );
}

function SessionRow({
  session,
  isActive,
  isPinned,
  onSelect,
  onPin,
  onRename,
  onDelete,
}: {
  session: Session;
  isActive: boolean;
  isPinned: boolean;
  onSelect: () => void;
  onPin: () => void;
  onRename: (title: string) => Promise<boolean>;
  onDelete: () => void;
}) {
  const isRunning = session.status === "active";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);

  useEffect(() => {
    if (!editing) setDraft(session.title);
  }, [editing, session.title]);

  const submitRename = async () => {
    const title = draft.trim();
    if (!title || title === session.title) {
      setEditing(false);
      setDraft(session.title);
      return;
    }
    const ok = await onRename(title);
    if (ok) setEditing(false);
  };

  return (
    <div
      data-testid="session-row"
      data-session-id={session.id}
      className={cn(
        "group relative mt-0.5 rounded-lg px-2.5 py-[7px] transition-colors",
        isActive ? "bg-[hsl(var(--primary)/0.10)]" : "hover:bg-accent",
      )}
    >
      {isActive && (
        <span className="absolute left-0 top-1/2 h-[58%] w-[2px] -translate-y-1/2 rounded-r bg-primary" />
      )}

      {editing ? (
        <div className="pr-14">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submitRename();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDraft(session.title);
                setEditing(false);
              }
            }}
            autoFocus
            data-testid="session-rename-input"
            className="h-6 w-full rounded border border-[hsl(var(--border-muted))] bg-background px-1.5 text-[12.5px] text-foreground outline-none focus:border-primary"
            aria-label={`Rename ${session.title}`}
          />
        </div>
      ) : (
        <button type="button" onClick={onSelect} className="w-full text-left">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
                isRunning ? "animate-pulse-dot-green bg-success" : "bg-muted-foreground/40",
              )}
            />
            <span
              className={cn(
                "truncate text-[12.5px] font-medium",
                isActive ? "text-foreground" : "text-foreground/85",
              )}
            >
              {session.title}
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between gap-2 pl-[14px]">
            <span className="truncate rounded border border-[hsl(var(--border-muted))] bg-accent/60 px-1 py-px font-mono text-[9.5px] text-muted-foreground">
              {modelLabel(session.model)}
            </span>
            <span className="shrink-0 font-mono text-[9.5px] text-muted-foreground/60">
              {timeLabel(session.updated_at)}
            </span>
          </div>
        </button>
      )}

      {/* Hover actions */}
      <div className="absolute right-1 top-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {editing ? (
          <>
            <button
              type="button"
              className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground/60 hover:bg-accent hover:text-success"
              onClick={(e) => {
                e.stopPropagation();
                void submitRename();
              }}
              aria-label={`Save ${session.title}`}
              title="Save name"
            >
              <Check className="h-2.5 w-2.5" />
            </button>
            <button
              type="button"
              className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground/60 hover:bg-accent hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                setDraft(session.title);
                setEditing(false);
              }}
              aria-label={`Cancel rename ${session.title}`}
              title="Cancel rename"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </>
        ) : (
          <button
            type="button"
            className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground/60 hover:bg-accent hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
            aria-label={`Rename ${session.title}`}
            title="Rename session"
          >
            <Pencil className="h-2.5 w-2.5" />
          </button>
        )}
        <button
          type="button"
          className={cn(
            "flex h-5 w-5 items-center justify-center rounded text-muted-foreground/60 hover:bg-accent hover:text-foreground",
            isPinned && "text-primary",
          )}
          onClick={(e) => {
            e.stopPropagation();
            onPin();
          }}
          aria-label={isPinned ? `Unpin ${session.title}` : `Pin ${session.title}`}
          title={isPinned ? "Unpin" : "Pin"}
          disabled={editing}
        >
          {isPinned ? <PinOff className="h-2.5 w-2.5" /> : <Pin className="h-2.5 w-2.5" />}
        </button>
        <button
          type="button"
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground/60 hover:bg-accent hover:text-destructive"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label={`Delete ${session.title}`}
          title="Delete session"
          disabled={editing}
        >
          <Trash2 className="h-2.5 w-2.5" />
        </button>
      </div>
    </div>
  );
}
