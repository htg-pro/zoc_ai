import { FileTree } from "@/features/files/FileTree";
import { SearchPanel } from "@/features/search/SearchPanel";
import { IndexerPanel } from "@/features/indexer/IndexerPanel";
import { SessionsPanel } from "@/features/sessions/SessionsPanel";
import { useApp } from "@/lib/store";
import { parseUnifiedDiff } from "@/lib/diff-utils";

const TITLES: Record<string, string> = {
  files: "Explorer",
  search: "Search",
  indexer: "Indexer",
  sessions: "Sessions",
  settings: "Settings",
};

/** Activities whose panel renders its own header; we suppress the outer one
 *  to avoid drawing a second label. */
const SELF_HEADERED = new Set(["sessions"]);

export function SidePanel() {
  const activity = useApp((s) => s.activity);
  // The Tasks view is full-screen (TaskWorkspacePanel in the main area). A
  // compact mirror in the side panel just duplicates the kanban, so we render
  // nothing for `activity === "tasks"` here.
  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col bg-sidebar text-sidebar-foreground">
      {!SELF_HEADERED.has(activity) && TITLES[activity] && (
        <div className="flex h-8 shrink-0 items-center px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {TITLES[activity]}
        </div>
      )}
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {activity === "files" && <FileTree />}
        {activity === "search" && <SearchPanel />}
        {activity === "indexer" && <IndexerPanel />}
        {activity === "sessions" && <SessionsPanel />}
        {activity === "settings" && (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            Settings open in the main view.
          </div>
        )}
      </div>
      <StatusFooter />
    </aside>
  );
}

function StatusFooter() {
  const streaming = useApp((s) => s.streaming);
  const isRunning = useApp((s) => s.isRunning);
  const activeFile = useApp((s) => s.activeFile);
  const pendingPatches = useApp((s) => s.pendingPatches);

  const agentEditing = streaming || isRunning;
  const reviewPending = pendingPatches.length > 0;

  if (!agentEditing && !reviewPending) return null;

  if (agentEditing) {
    return (
      <div className="m-2 rounded-lg border border-[hsl(var(--border-muted))] bg-card p-2.5">
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-primary" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Agent is editing
          </span>
        </div>
        <div className="mt-1.5 truncate font-mono text-[11.5px] text-foreground">
          {activeFile ?? "—"}
        </div>
      </div>
    );
  }

  // reviewPending
  let adds = 0;
  let dels = 0;
  for (const p of pendingPatches) {
    try {
      const parsed = parseUnifiedDiff(p.unified_diff);
      adds += parsed.adds;
      dels += parsed.dels;
    } catch {
      /* malformed diff — skip */
    }
  }
  return (
    <div className="m-2 rounded-lg border border-[hsl(var(--border-muted))] bg-card p-2.5">
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-warning" />
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Review pending
        </span>
      </div>
      <div className="mt-1 font-mono text-[11.5px] text-muted-foreground">
        {pendingPatches.length} file{pendingPatches.length === 1 ? "" : "s"} ·{" "}
        <span className="text-success">+{adds}</span>{" "}
        <span className="text-destructive">−{dels}</span>
      </div>
    </div>
  );
}
