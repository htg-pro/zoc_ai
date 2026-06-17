import { useApp } from "@/lib/store";
import { EditorTabs } from "./EditorTabs";
import { MonacoView } from "./MonacoView";
import { Breadcrumbs } from "./Breadcrumbs";
import { InlineDiffView } from "./InlineDiffView";
import { Check, FileText, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";

export function EditorArea() {
  const openFiles = useApp((s) => s.openFiles);
  const activeFile = useApp((s) => s.activeFile);
  const pendingPatches = useApp((s) => s.pendingPatches);
  const fileStatus = useApp((s) => s.fileStatus);
  const streaming = useApp((s) => s.streaming);
  const isRunning = useApp((s) => s.isRunning);
  const setMainView = useApp((s) => s.setMainView);
  const applyPatch = useApp((s) => s.applyPatch);
  const rejectPatch = useApp((s) => s.rejectPatch);
  const breadcrumbs = useApp((s) => s.editorSettings.breadcrumbs);
  const splitView = useApp((s) => s.splitView);
  const rightActiveFile = useApp((s) => s.rightActiveFile);
  const setRightActiveFile = useApp((s) => s.setRightActiveFile);
  const closeRightGroup = useApp((s) => s.closeRightGroup);
  const current = openFiles.find((f) => f.path === activeFile) ?? null;
  const rightCurrent = openFiles.find((f) => f.path === rightActiveFile) ?? null;
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
    <div className="flex h-full min-h-0 min-w-0 bg-background">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <EditorTabs />
        {breadcrumbs && <Breadcrumbs path={current.path} />}
        {inlinePatch ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex h-8 items-center justify-between border-b border-primary/40 bg-[hsl(var(--primary)/0.08)] px-3 text-[11.5px]">
              <span className="flex items-center gap-1.5 text-primary">
                <Sparkles className="h-3 w-3" />
                Proposed edit to this file
              </span>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[11px] hover:bg-primary/12 hover:text-primary"
                  onClick={() => setMainView("diff")}
                >
                  Review all →
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[11px] text-destructive"
                  onClick={() => rejectPatch(inlinePatch.id)}
                >
                  <X className="mr-1 h-3 w-3" />
                  Reject
                </Button>
                <Button
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  onClick={async () => {
                    const ok = await applyPatch(inlinePatch.id);
                    toast[ok ? "success" : "error"](
                      ok ? "Edit applied" : "Couldn't apply edit",
                      ok ? undefined : { description: `${inlinePatch.file_path} — check workspace permissions.` },
                    );
                  }}
                >
                  <Check className="mr-1 h-3 w-3" />
                  Apply
                </Button>
              </div>
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

      {splitView && rightCurrent && (
        <>
          <div className="w-px shrink-0 bg-border" />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex items-stretch">
              <div className="min-w-0 flex-1">
                <EditorTabs
                  activeFile={rightActiveFile}
                  onSelect={setRightActiveFile}
                  showActions={false}
                />
              </div>
              <button
                type="button"
                aria-label="Close split"
                title="Close split editor"
                onClick={closeRightGroup}
                className="flex w-8 items-center justify-center border-b border-border text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            {breadcrumbs && <Breadcrumbs path={rightCurrent.path} />}
            <div className="min-h-0 flex-1">
              <MonacoView file={rightCurrent} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
