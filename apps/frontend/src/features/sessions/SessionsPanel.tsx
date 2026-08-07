/**
 * The workspace sessions side panel — zoc-agent-chat-rebuild R15.3, R15.4, R35.2, task 25.2.
 *
 * Rewritten against {@link SessionRow} and {@link SessionDeleteDialog} rather than repointed. It used to
 * carry its own `SessionRow` — an inline rename editor plus hover pin/delete buttons — which was one of the
 * two row markups R35.2 asks to consolidate; the other was `SessionsView`'s `SessionCard`. Both now render
 * the 22.5 row, so a change to how a Session presents itself lands in one file.
 *
 * ## What did not consolidate
 *
 * The recency grouping stays here, reading `groupSessions` out of the kept-as-is `lib/session-query.ts`.
 * That is why this file renders {@link SessionRow} directly instead of {@link SessionList}: the list owns a
 * search box, filter tabs, and its own scope-partition-sort pipeline, so one list per group would give four
 * search boxes and would re-sort groups that are already ordered. The rows are what R35.2 is about.
 *
 * The `window.confirm` delete gate is gone. It was untrappable, unstylable, and absent from the
 * accessibility tree, so the R15.4 confirmation could not be asserted through it at all.
 */
import { useMemo, useState } from "react";
import type { Session } from "@zoc-studio/shared-types";
import { ChevronsDownUp, Pin, Plus, Search } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useApp } from "@/lib/store";
import { groupSessions } from "@/lib/session-query";
import { SessionDeleteDialog } from "./SessionDeleteDialog";
import { SessionRow } from "./SessionRow";
import { sessionRowModel } from "./session-list-model";

type Group = {
  key: "pinned" | "today" | "yesterday" | "older";
  label: string;
  sessions: Session[];
};

function groupSessionsForPanel(sessions: Session[], pinned: Record<string, true>): Group[] {
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
  const [pendingDelete, setPendingDelete] = useState<Session | null>(null);

  const onNew = async () => {
    // No "/" fallback: a session needs a real folder (R2.x). Disabled below when
    // none is resolvable; guard here too.
    const root = (
      workspaceRoot ??
      sessions.find((s) => s.id === active)?.workspace_root ??
      ""
    ).trim();
    if (!root || root === "/") return;
    const title = `Session ${new Date().toLocaleTimeString()}`;
    await createSession(title, root);
  };

  const canCreateSession = (() => {
    const root = (
      workspaceRoot ??
      sessions.find((s) => s.id === active)?.workspace_root ??
      ""
    ).trim();
    return root !== "" && root !== "/";
  })();

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
        className="mx-3 mt-2 flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md border border-[hsl(var(--border-muted))] bg-card text-[11.5px] font-medium text-muted-foreground hover:border-muted-foreground/30 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
        onClick={onNew}
        disabled={!canCreateSession}
        title={canCreateSession ? "New session" : "Open a workspace first to start a session"}
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
              <ul role="list" aria-label={group.label}>
                {group.sessions.map((s) => (
                  <SessionRow
                    key={s.id}
                    row={sessionRowModel(s, pinned)}
                    active={s.id === active}
                    // Rows here span every workspace the store knows about, so the basename is what tells
                    // two same-titled Sessions apart (R15.3).
                    showWorkspace
                    onSelect={() => {
                      select(s.id);
                      setMainView("editor");
                    }}
                    onTogglePin={() => togglePin(s.id)}
                    onRename={(title) => void renameSession(s.id, title)}
                    onDelete={() => {
                      setPendingDelete(s);
                    }}
                  />
                ))}
              </ul>
            </div>
          );
        })}
      </ScrollArea>

      <SessionDeleteDialog
        session={pendingDelete}
        onCancel={() => {
          setPendingDelete(null);
        }}
        onConfirm={(sessionId) => {
          setPendingDelete(null);
          void deleteSession(sessionId);
        }}
      />

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
