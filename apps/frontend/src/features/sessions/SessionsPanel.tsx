import { useMemo } from "react";
import type { Session } from "@llama-studio/shared-types";
import { ChevronsDownUp, Pin, PinOff, Plus, Search, Trash2 } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useApp } from "@/lib/store";
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

function groupSessions(sessions: Session[], pinned: Record<string, true>): Group[] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86_400_000;

  const pinnedList: Session[] = [];
  const today: Session[] = [];
  const yesterday: Session[] = [];
  const older: Session[] = [];

  for (const s of sessions) {
    if (pinned[s.id]) {
      pinnedList.push(s);
      continue;
    }
    const t = new Date(s.updated_at).getTime();
    if (t >= startOfToday) today.push(s);
    else if (t >= startOfYesterday) yesterday.push(s);
    else older.push(s);
  }

  const byRecency = (a: Session, b: Session) =>
    new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  pinnedList.sort(byRecency);
  today.sort(byRecency);
  yesterday.sort(byRecency);
  older.sort(byRecency);

  return [
    { key: "pinned", label: "Pinned", sessions: pinnedList },
    { key: "today", label: "Today", sessions: today },
    { key: "yesterday", label: "Yesterday", sessions: yesterday },
    { key: "older", label: "Older", sessions: older },
  ];
}

export function SessionsPanel() {
  const sessions = useApp((s) => s.sessions);
  const active = useApp((s) => s.activeSessionId);
  const pinned = useApp((s) => s.pinnedSessions);
  const select = useApp((s) => s.selectSession);
  const setMainView = useApp((s) => s.setMainView);
  const createSession = useApp((s) => s.createSession);
  const deleteSession = useApp((s) => s.deleteSession);
  const togglePin = useApp((s) => s.togglePinnedSession);
  const workspaceRoot = useApp((s) => s.workspaceRoot);

  const groups = useMemo(() => groupSessions(sessions, pinned), [sessions, pinned]);

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
  onDelete,
}: {
  session: Session;
  isActive: boolean;
  isPinned: boolean;
  onSelect: () => void;
  onPin: () => void;
  onDelete: () => void;
}) {
  const isRunning = session.status === "active";
  return (
    <div
      className={cn(
        "group relative mt-0.5 rounded-lg px-2.5 py-[7px] transition-colors",
        isActive ? "bg-[hsl(var(--primary)/0.10)]" : "hover:bg-accent",
      )}
    >
      {isActive && (
        <span className="absolute left-0 top-1/2 h-[58%] w-[2px] -translate-y-1/2 rounded-r bg-primary" />
      )}

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

      {/* Hover actions */}
      <div className="absolute right-1 top-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
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
        >
          <Trash2 className="h-2.5 w-2.5" />
        </button>
      </div>
    </div>
  );
}
