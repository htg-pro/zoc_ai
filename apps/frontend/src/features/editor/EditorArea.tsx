import { useApp } from "@/lib/store";
import { EditorTabs } from "./EditorTabs";
import { MonacoView } from "./MonacoView";
import { InlineDiffView } from "./InlineDiffView";
import { FileText, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

export function EditorArea() {
  const openFiles = useApp((s) => s.openFiles);
  const activeFile = useApp((s) => s.activeFile);
  const pendingPatches = useApp((s) => s.pendingPatches);
  const fileStatus = useApp((s) => s.fileStatus);
  const streaming = useApp((s) => s.streaming);
  const isRunning = useApp((s) => s.isRunning);
  const setMainView = useApp((s) => s.setMainView);
  const current = openFiles.find((f) => f.path === activeFile) ?? null;
  const inlinePatch = current ? pendingPatches.find((p) => p.file_path === current.path) : null;
  const agentEditing =
    !!current && (streaming || isRunning) && fileStatus[current.path] === "M" && !inlinePatch;

  if (!current) {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-col items-center justify-center gap-3 bg-background text-center">
        <FileText className="h-8 w-8 text-muted-foreground" />
        <div className="text-sm text-muted-foreground">No file open</div>
        <Button size="sm" variant="secondary" onClick={() => setMainView("sessions")}>
          Resume a session
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <EditorTabs />
      {inlinePatch ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex h-8 items-center justify-between border-b border-primary/40 bg-[hsl(var(--primary)/0.08)] px-3 text-[11.5px]">
            <span className="flex items-center gap-1.5 text-primary">
              <Sparkles className="h-3 w-3" />
              Agent proposed an edit to this file
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px] hover:bg-primary/12 hover:text-primary"
              onClick={() => setMainView("diff")}
            >
              Review all patches →
            </Button>
          </div>
          <InlineDiffView patch={inlinePatch} />
        </div>
      ) : (
        <div className="relative min-h-0 flex-1">
          <MonacoView file={current} agentEditing={agentEditing} />
          {agentEditing && (
            <span
              className="pointer-events-none absolute right-4 top-3 inline-flex items-center gap-1 rounded-full border border-primary/35 bg-[hsl(var(--primary)/0.15)] px-2 py-0.5 text-[10.5px] font-medium text-primary/90"
              aria-hidden
            >
              <Sparkles className="h-3 w-3 animate-pulse-dot" />
              Agent editing
            </span>
          )}
        </div>
      )}
    </div>
  );
}
