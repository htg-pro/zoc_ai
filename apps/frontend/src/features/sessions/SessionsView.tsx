/**
 * The full-page workspace sessions surface — zoc-agent-chat-rebuild R15.3, R15.4, R35.2, task 25.2.
 *
 * Rewritten against {@link SessionRow} and {@link SessionDeleteDialog} rather than repointed. Its own
 * `SessionCard` was the second of the two row markups R35.2 asks to consolidate (the other was
 * `SessionsPanel`'s); both surfaces now render the 22.5 row.
 *
 * ## What did not consolidate
 *
 * The stats cards, the four filter tabs, and the sort toggle stay, reading `sessionStats`, `matchesFilter`,
 * `matchesSearch`, and `tabCounts` out of the kept-as-is `lib/session-query.ts`. That is why this file
 * renders {@link SessionRow} directly instead of {@link SessionList}: this surface's filter is four tabs
 * over all workspaces, and the list's is two tabs scoped to one — layering them would show the
 * intersection.
 *
 * The `window.confirm` delete gate is gone, for the reason given in `SessionDeleteDialog`. The stale-pin
 * cleanup it guarded moved onto the dialog's confirm.
 *
 * The card's model chips — provider, gguf filename, quant, param count — went with the card. R15.3 names
 * three facts for a row and none of them is the model; a Session's model belongs to the run that used it,
 * and showing it per row was what made this markup diverge from the panel's in the first place.
 */
import { useMemo, useState } from "react";
import {
  Activity,
  ArrowUpDown,
  ChevronDown,
  Coins,
  Cpu,
  Download,
  History,
  MessagesSquare,
  Pin,
  Plus,
  Search,
  TrendingUp,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import {
  matchesFilter,
  matchesSearch,
  sessionStats,
  tabCounts as computeTabCounts,
} from "@/lib/session-query";
import { SessionDeleteDialog } from "./SessionDeleteDialog";
import { SessionRow } from "./SessionRow";
import { sessionRowModel } from "./session-list-model";
import type { Session } from "@zoc-studio/shared-types";

/* ── helpers ───────────────────────────────────────────────────── */

type FilterTab = "all" | "active" | "pinned" | "archived";
type SortKey = "updated" | "created";

/* ── main component ───────────────────────────────────────────── */

export function SessionsView() {
  const sessions = useApp((s) => s.sessions);
  const activeSessionId = useApp((s) => s.activeSessionId);
  const select = useApp((s) => s.selectSession);
  const deleteSession = useApp((s) => s.deleteSession);
  const createSession = useApp((s) => s.createSession);
  const setMainView = useApp((s) => s.setMainView);
  const workspaceRoot = useApp((s) => s.workspaceRoot);
  // Pins are persisted in the store (R2.11) — not local component state — so
  // they survive navigation and reload.
  const pinnedSessions = useApp((s) => s.pinnedSessions);
  const togglePin = useApp((s) => s.togglePinnedSession);

  const [q, setQ] = useState("");
  const [tab, setTab] = useState<FilterTab>("all");
  const [sortKey, setSortKey] = useState<SortKey>("updated");

  /* ── pinned set (persisted in the store) ───────────────────── */
  const pinnedSet = useMemo(
    () => new Set(Object.keys(pinnedSessions).filter((id) => pinnedSessions[id])),
    [pinnedSessions],
  );

  /* ── filter + search (R2.6, R2.7: case-insensitive substring) ─ */
  const filtered = useMemo(
    () => sessions.filter((s) => matchesFilter(s, tab, pinnedSet) && matchesSearch(s, q)),
    [sessions, tab, pinnedSet, q],
  );

  /* ── sort ───────────────────────────────────────────────────── */
  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      const key = sortKey === "updated" ? "updated_at" : "created_at";
      return new Date(b[key]).getTime() - new Date(a[key]).getTime();
    });
    return arr;
  }, [filtered, sortKey]);

  /* ── split pinned / recent ──────────────────────────────────── */
  const pinned = sorted.filter((s) => pinnedSet.has(s.id));
  const recent = sorted.filter((s) => !pinnedSet.has(s.id));

  /* ── computed stats (R2.4) and tab counts (R2.5) ───────────── */
  const stats = useMemo(
    () => sessionStats(sessions, Date.now(), (s) => s.messages?.length ?? 0),
    [sessions],
  );
  const activeSessions = stats.activeSessions;
  const totalMessages = stats.tokensUsed;
  const uniqueModels = stats.modelsUsed;
  const tabCounts = useMemo(() => computeTabCounts(sessions, pinnedSet), [sessions, pinnedSet]);

  /* ── handlers ───────────────────────────────────────────────── */
  const [pendingDelete, setPendingDelete] = useState<Session | null>(null);

  const remove = async (sessionId: string) => {
    const deleted = await deleteSession(sessionId);
    if (deleted && pinnedSet.has(sessionId)) {
      // Clear a stale pin for the now-deleted session.
      togglePin(sessionId);
    }
  };

  const onNew = async () => {
    // No "/" fallback: a session must be scoped to a real folder (R2.x). When
    // none is resolvable the control is disabled below; guard here too.
    const root = (
      workspaceRoot ??
      sessions.find((s) => s.id === useApp.getState().activeSessionId)?.workspace_root ??
      ""
    ).trim();
    if (!root || root === "/") return;
    const created = await createSession(`Session ${new Date().toLocaleTimeString()}`, root);
    if (created) setMainView("editor");
  };

  // New Session is enabled only when a real workspace is resolvable (R2.x).
  const canCreateSession = (() => {
    const root = (
      workspaceRoot ??
      sessions.find((s) => s.id === useApp.getState().activeSessionId)?.workspace_root ??
      ""
    ).trim();
    return root !== "" && root !== "/";
  })();

  return (
    <ScrollArea className="h-full bg-background">
      <div className="mx-auto h-full max-w-[980px] px-7 pt-5 pb-6">
        {/* ── header ──────────────────────────────────────────── */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[21px] font-semibold leading-7 tracking-[-0.01em]">Sessions</h1>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              Resume any past conversation. Pinned sessions stay at the top.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 pt-0.5">
            <button className="flex h-8 items-center gap-1.5 rounded-lg border border-[hsl(var(--border-muted))] bg-card px-3 text-[12px] font-medium text-foreground hover:border-muted-foreground/30">
              <Download className="h-3.5 w-3.5 text-muted-foreground" />
              Import
            </button>
            <button
              className="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[12px] font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => void onNew()}
              disabled={!canCreateSession}
              title={canCreateSession ? "New session" : "Open a workspace first to start a session"}
            >
              <Plus className="h-3.5 w-3.5" />
              New session
            </button>
          </div>
        </div>

        {/* ── stats grid ──────────────────────────────────────── */}
        <div className="mt-4 grid grid-cols-4 gap-2.5">
          <StatsCard
            label="Active sessions"
            icon={<MessagesSquare className="h-3.5 w-3.5 text-muted-foreground/40" />}
            value={activeSessions}
            dot
            sub={`+${Math.max(1, Math.floor(activeSessions * 0.15))} since yesterday`}
          />
          <StatsCard
            label="Runs this week"
            icon={<Activity className="h-3.5 w-3.5 text-muted-foreground/40" />}
            value={Math.max(1, totalMessages)}
            sub={
              <span className="flex items-center gap-1 text-emerald-400">
                <TrendingUp className="h-2.5 w-2.5" />
                trending
              </span>
            }
          />
          <StatsCard
            label="Models used"
            icon={<Cpu className="h-3.5 w-3.5 text-muted-foreground/40" />}
            value={uniqueModels || 1}
            sub="all local · llamacpp"
            monoSub
          />
          <StatsCard
            label="Tokens used"
            icon={<Coins className="h-3.5 w-3.5 text-muted-foreground/40" />}
            value="—"
            sub="avg — / run"
            monoSub
          />
        </div>

        {/* ── filter tabs + search + sort ─────────────────────── */}
        <div className="mt-3.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-0.5 rounded-lg border border-[hsl(var(--border-muted))] bg-[hsl(var(--background)/0.6)] p-0.5">
            {(["all", "active", "pinned", "archived"] as FilterTab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  "flex h-[26px] items-center gap-1.5 rounded-md px-2.5 text-[11.5px] font-medium capitalize transition-colors",
                  t === tab
                    ? "bg-primary/14 text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t}
                <span
                  className={cn(
                    "font-mono text-[9.5px]",
                    t === tab ? "text-primary" : "text-muted-foreground/50",
                  )}
                >
                  {tabCounts[t]}
                </span>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex h-[30px] w-[280px] items-center gap-2 rounded-lg border border-[hsl(var(--border-muted))] bg-[hsl(var(--background)/0.6)] px-2.5">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search sessions…"
                className="h-full flex-1 bg-transparent text-[11.5px] text-foreground placeholder:text-muted-foreground/50 outline-none"
              />
            </div>
            <button
              onClick={() => setSortKey((k) => (k === "updated" ? "created" : "updated"))}
              className="flex h-[30px] shrink-0 items-center gap-1.5 rounded-lg border border-[hsl(var(--border-muted))] bg-[hsl(var(--background)/0.6)] px-2.5 hover:border-muted-foreground/30"
            >
              <ArrowUpDown className="h-3 w-3 text-muted-foreground" />
              <span className="text-[11.5px] text-muted-foreground">
                {sortKey === "updated" ? "Last updated" : "Created"}
              </span>
              <ChevronDown className="h-3 w-3 text-muted-foreground/50" />
            </button>
          </div>
        </div>

        {/* ── session list ────────────────────────────────────── */}
        <div className="mt-4 space-y-2 pb-3">
          {/* Pinned section */}
          {pinned.length > 0 && (
            <>
              <SectionLabel icon={<Pin className="h-2.5 w-2.5" />} label="Pinned" />
              <ul role="list" aria-label="Pinned sessions">
                {pinned.map((s) => (
                  <SessionRow
                    key={s.id}
                    row={sessionRowModel(s, pinnedSessions)}
                    active={s.id === activeSessionId}
                    // This surface lists across every workspace, so the basename is what tells two
                    // same-titled Sessions apart (R15.3).
                    showWorkspace
                    onSelect={() => {
                      select(s.id);
                      setMainView("editor");
                    }}
                    onTogglePin={() => togglePin(s.id)}
                    onDelete={() => {
                      setPendingDelete(s);
                    }}
                  />
                ))}
              </ul>
            </>
          )}

          {/* Recent section */}
          {recent.length > 0 && (
            <>
              <SectionLabel
                icon={<History className="h-2.5 w-2.5" />}
                label="Recent"
                className={pinned.length > 0 ? "mt-4" : undefined}
              />
              <ul role="list" aria-label="Recent sessions">
                {recent.map((s) => (
                  <SessionRow
                    key={s.id}
                    row={sessionRowModel(s, pinnedSessions)}
                    active={s.id === activeSessionId}
                    showWorkspace
                    onSelect={() => {
                      select(s.id);
                      setMainView("editor");
                    }}
                    onTogglePin={() => togglePin(s.id)}
                    onDelete={() => {
                      setPendingDelete(s);
                    }}
                  />
                ))}
              </ul>
            </>
          )}

          {/* Empty state */}
          {filtered.length === 0 && (
            <div className="rounded-[10px] border border-[hsl(var(--border-muted))] bg-card px-4 py-8 text-center text-sm text-muted-foreground">
              No sessions match your search.
            </div>
          )}
        </div>
      </div>

      <SessionDeleteDialog
        session={pendingDelete}
        onCancel={() => {
          setPendingDelete(null);
        }}
        onConfirm={(sessionId) => {
          setPendingDelete(null);
          void remove(sessionId);
        }}
      />
    </ScrollArea>
  );
}

/* ── StatsCard ─────────────────────────────────────────────────── */

function StatsCard({
  label,
  icon,
  value,
  dot,
  sub,
  monoSub,
}: {
  label: string;
  icon: React.ReactNode;
  value: number | string;
  dot?: boolean;
  sub: React.ReactNode;
  monoSub?: boolean;
}) {
  return (
    <div className="rounded-[10px] border border-[hsl(var(--border-muted))] bg-card px-3.5 py-3">
      <div className="flex items-center justify-between">
        <span className="text-[9.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {label}
        </span>
        {icon}
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        {dot && (
          <span className="pulse-status-dot h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
        )}
        <span className="font-mono text-[17px] font-semibold leading-none">{value}</span>
      </div>
      <p className={cn("mt-1.5 text-[10px] text-muted-foreground/60", monoSub && "font-mono")}>
        {sub}
      </p>
    </div>
  );
}

/* ── SectionLabel ──────────────────────────────────────────────── */

function SectionLabel({
  icon,
  label,
  className,
}: {
  icon: React.ReactNode;
  label: string;
  className?: string;
}) {
  return (
    <div className={cn("mb-2 flex items-center gap-1.5", className)}>
      <span className="text-muted-foreground/50">{icon}</span>
      <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground/50">
        {label}
      </span>
    </div>
  );
}
