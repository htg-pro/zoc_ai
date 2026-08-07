import { useEffect, useState } from "react";
import { History, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useApp } from "@/lib/store";

/**
 * Checkpoint history — restorable snapshots captured before each applied agent
 * run. One-click "restore to before this run" undoes the change.
 */
export function CheckpointsPanel() {
  const checkpoints = useApp((s) => s.checkpoints);
  const loadCheckpoints = useApp((s) => s.loadCheckpoints);
  const restoreCheckpoint = useApp((s) => s.restoreCheckpoint);
  const liveMode = useApp((s) => s.liveMode);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    void loadCheckpoints();
  }, [loadCheckpoints]);

  const fmt = (iso: string) => {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? "" : new Date(t).toLocaleString();
  };

  if (!liveMode) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
        Checkpoints are captured when the desktop sidecar applies agent changes.
      </div>
    );
  }

  if (checkpoints.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-xs text-muted-foreground">
        <History className="h-5 w-5 opacity-60" />
        No checkpoints yet. Applying an agent run creates a restore point here.
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <ul className="divide-y divide-border/60">
        {checkpoints.map((cp) => (
          <li key={cp.run_id} className="flex items-center gap-3 px-3 py-2">
            <History className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] text-foreground/90">
                {cp.label || "Checkpoint"}
              </div>
              <div className="font-mono text-[10.5px] text-muted-foreground">
                {fmt(cp.created_at)} · {cp.files.length} file{cp.files.length === 1 ? "" : "s"}
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 gap-1.5 px-2 text-[11px]"
              disabled={busyId !== null}
              title="Restore the workspace to before this run"
              onClick={async () => {
                setBusyId(cp.run_id);
                try {
                  await restoreCheckpoint(cp.run_id);
                } finally {
                  setBusyId(null);
                }
              }}
            >
              {busyId === cp.run_id ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" />
              )}
              Restore
            </Button>
          </li>
        ))}
      </ul>
    </ScrollArea>
  );
}
