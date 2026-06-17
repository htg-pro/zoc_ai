import { useCallback, useEffect, useState } from "react";
import { GitCommit as GitCommitIcon, History, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { useApp } from "@/lib/store";
import { buildTimeline, type TimelineEntry } from "@/lib/timeline";
import type { GitCommit } from "@/lib/tauri-bridge";
import { cn } from "@/lib/utils";

function relativeTime(ts: number): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}

/**
 * Timeline side view (develop.md Side Panel → Timeline). Merges Git commit
 * history with agent checkpoints into one time-sorted feed; checkpoints can be
 * restored in place.
 */
export function TimelinePanel() {
  const checkpoints = useApp((s) => s.checkpoints);
  const loadCheckpoints = useApp((s) => s.loadCheckpoints);
  const loadGitLog = useApp((s) => s.loadGitLog);
  const restoreCheckpoint = useApp((s) => s.restoreCheckpoint);
  const liveMode = useApp((s) => s.liveMode);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [busyRun, setBusyRun] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    void loadCheckpoints();
    setCommits(await loadGitLog(30));
  }, [loadCheckpoints, loadGitLog]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const entries = buildTimeline(commits, checkpoints);

  const restore = async (entry: TimelineEntry) => {
    if (!entry.runId) return;
    setBusyRun(entry.runId);
    const ok = await restoreCheckpoint(entry.runId);
    setBusyRun(null);
    toast[ok ? "success" : "error"](ok ? "Checkpoint restored" : "Couldn't restore checkpoint");
  };

  if (entries.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-xs text-muted-foreground">
        <History className="h-6 w-6 opacity-50" />
        {liveMode ? "No history yet." : "Open a workspace to see its timeline."}
      </div>
    );
  }

  return (
    <ul className="h-full min-h-0 overflow-y-auto px-1 py-1">
      {entries.map((e) => (
        <li
          key={e.id}
          className="group flex items-start gap-2 rounded px-2 py-1.5 text-[12px] hover:bg-accent"
        >
          <span className="mt-0.5 shrink-0">
            {e.kind === "commit" ? (
              <GitCommitIcon className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <History className="h-3.5 w-3.5 text-primary" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate">{e.title}</div>
            <div className="truncate text-[10.5px] text-muted-foreground">
              {e.subtitle}
              {e.ts ? ` · ${relativeTime(e.ts)}` : ""}
            </div>
          </div>
          {e.kind === "checkpoint" && e.runId && (
            <Button
              size="icon"
              variant="ghost"
              className={cn("h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100")}
              title="Restore this checkpoint"
              aria-label={`Restore ${e.title}`}
              disabled={busyRun === e.runId}
              onClick={() => void restore(e)}
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
