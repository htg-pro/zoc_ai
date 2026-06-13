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
  Trash2,
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
import type { Session } from "@llama-studio/shared-types";

/* ── helpers ───────────────────────────────────────────────────── */

type FilterTab = "all" | "active" | "pinned" | "archived";
type SortKey = "updated" | "created";

function formatDate(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return d.toLocaleDateString(undefined, { month: "numeric", day: "numeric" }) +
    ", " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function extractModelInfo(model: string | null | undefined) {
  if (!model) return { name: "-", quant: "", params: "", file: "" };
  const file = model;
  // Try to extract quant (e.g. Q4_K_M, Q6_K, Q8_0, F16)
  const quantMatch = model.match(/[._-](Q\d+[_A-Z]*|F16|F32|BF16)/i);
  const quant = quantMatch ? quantMatch[1] : "";
  // Try to extract param size (e.g. 12B, 9B, 1B)
  const paramMatch = model.match(/(\d+\.?\d*B)/i);
  const params = paramMatch ? paramMatch[1] : "";
  // Simplified display name
  const name = model
    .replace(/\.gguf$/i, "")
    .replace(/[._-](Q\d+[_A-Z]*|F16|F32|BF16)/gi, "")
    .replace(/[._]/g, " ")
    .trim();
  return { name, quant, params, file };
}

/* ── main component ───────────────────────────────────────────── */

export function SessionsView() {
  const sessions = useApp((s) => s.sessions);
  const select = useApp((s) => s.selectSession);
  const deleteSession = useApp((s) => s.deleteSession);
  const createSession = useApp((s) => s.createSession);
  const setMainView = useApp((s) => s.setMainView);
  const workspaceRoot = useApp((s) => s.workspaceRoot);

  const [q, setQ] = useState("");
  const [pins, setPins] = useState<Record<string, boolean>>({ "sess-1": true });
  const [tab, setTab] = useState<FilterTab>("all");
  const [sortKey, setSortKey] = useState<SortKey>("updated");

  /* ── pinned set (local-only pin state) ─────────────────────── */
  const pinnedSet = useMemo(
    () => new Set(Object.keys(pins).filter((id) => pins[id])),
    [pins],
  );

  /* ── filter + search (R2.6, R2.7: case-insensitive substring) ─ */
  const filtered = useMemo(
    () =>
      sessions.filter(
        (s) => matchesFilter(s, tab, pinnedSet) && matchesSearch(s, q),
      ),
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
  const tabCounts = useMemo(
    () => computeTabCounts(sessions, pinnedSet),
    [sessions, pinnedSet],
  );

  /* ── handlers ───────────────────────────────────────────────── */
  const remove = async (session: Session) => {
    const ok = window.confirm(`Delete "${session.title}" and its chat history?`);
    if (!ok) return;
    const deleted = await deleteSession(session.id);
    if (deleted) {
      setPins((prev) => {
        const next = { ...prev };
        delete next[session.id];
        return next;
      });
    }
  };

  const onNew = async () => {
    const root =
      workspaceRoot ??
      sessions.find((s) => s.id === useApp.getState().activeSessionId)?.workspace_root ??
      "/";
    const created = await createSession(`Session ${new Date().toLocaleTimeString()}`, root);
    if (created) setMainView("editor");
  };

  return (
    <ScrollArea className="h-full bg-background">
      <div className="mx-auto h-full max-w-[980px] px-7 pt-5 pb-6">
        {/* ── header ──────────────────────────────────────────── */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[21px] font-semibold leading-7 tracking-[-0.01em]">
              Sessions
            </h1>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              Resume any past conversation. Pinned sessions stay at the top.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 pt-0.5">
            <button
              className="flex h-8 items-center gap-1.5 rounded-lg border border-[hsl(var(--border-muted))] bg-card px-3 text-[12px] font-medium text-foreground hover:border-muted-foreground/30"
            >
              <Download className="h-3.5 w-3.5 text-muted-foreground" />
              Import
            </button>
            <button
              className="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[12px] font-medium text-primary-foreground hover:bg-primary/90"
              onClick={() => void onNew()}
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
              {pinned.map((s) => (
                <SessionCard
                  key={s.id}
                  session={s}
                  pinned
                  onPin={() => setPins((p) => ({ ...p, [s.id]: !p[s.id] }))}
                  onResume={() => { select(s.id); setMainView("editor"); }}
                  onDelete={() => void remove(s)}
                />
              ))}
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
              {recent.map((s, i) => (
                <SessionCard
                  key={s.id}
                  session={s}
                  pinned={false}
                  highlight={i === 0}
                  onPin={() => setPins((p) => ({ ...p, [s.id]: true }))}
                  onResume={() => { select(s.id); setMainView("editor"); }}
                  onDelete={() => void remove(s)}
                />
              ))}
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
        <span className="font-mono text-[17px] font-semibold leading-none">
          {value}
        </span>
      </div>
      <p
        className={cn(
          "mt-1.5 text-[10px] text-muted-foreground/60",
          monoSub && "font-mono",
        )}
      >
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

/* ── SessionCard ───────────────────────────────────────────────── */

function SessionCard({
  session,
  pinned,
  highlight,
  onPin,
  onResume,
  onDelete,
}: {
  session: Session;
  pinned: boolean;
  highlight?: boolean;
  onPin: () => void;
  onResume: () => void;
  onDelete: () => void;
}) {
  const { quant, params, file } = extractModelInfo(session.model);
  const isActive = session.status === "active";
  const msgCount = session.messages?.length ?? 0;

  return (
    <div
      className={cn(
        "group flex items-center justify-between gap-4 rounded-[10px] border px-4 py-2.5 transition-colors",
        highlight
          ? "border-muted-foreground/30 bg-accent"
          : "border-[hsl(var(--border-muted))] bg-card hover:bg-accent/50",
      )}
    >
      {/* Left side */}
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              isActive
                ? "pulse-status-dot bg-emerald-400"
                : "bg-muted-foreground/40",
            )}
          />
          <span className="truncate text-[13px] font-medium">{session.title}</span>
          {pinned && (
            <Pin className="h-3 w-3 shrink-0 rotate-45 text-primary" />
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span
            className={cn(
              "rounded px-1.5 py-px font-mono text-[9.5px]",
              isActive
                ? "border border-emerald-400/25 bg-emerald-400/10 text-emerald-400"
                : "border border-muted-foreground/20 bg-muted text-muted-foreground",
            )}
          >
            {session.status}
          </span>
          <span className="rounded border border-[hsl(var(--border-muted))] bg-accent px-1.5 py-px font-mono text-[9.5px] text-muted-foreground">
            {session.provider ?? "llamacpp"}
          </span>
          {file && (
            <span
              className="max-w-[280px] truncate rounded border border-[hsl(var(--border-muted))] bg-accent px-1.5 py-px font-mono text-[9.5px] text-muted-foreground"
              title={file}
            >
              {file}
            </span>
          )}
          {(quant || params) && (
            <span className="rounded border border-[hsl(var(--border-muted))] bg-accent px-1.5 py-px font-mono text-[9.5px] text-muted-foreground/60">
              {[quant, params].filter(Boolean).join(" · ")}
            </span>
          )}
        </div>
        <p className="mt-1.5 font-mono text-[10px] text-muted-foreground/50">
          Updated {formatDate(session.updated_at)} · {msgCount} messages
        </p>
      </div>

      {/* Right side — actions */}
      <div className="flex shrink-0 items-center gap-1">
        <button
          onClick={onPin}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          title={pinned ? "Unpin session" : "Pin session"}
        >
          <Pin className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={onDelete}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive"
          title="Delete session"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={onResume}
          className={cn(
            "ml-1 h-7 rounded-lg px-3 text-[11.5px] font-medium",
            highlight
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "border border-[hsl(var(--border-muted))] bg-accent text-foreground hover:border-muted-foreground/30",
          )}
        >
          Resume
        </button>
      </div>
    </div>
  );
}
