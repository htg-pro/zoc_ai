import { useEffect, useRef, useState } from "react";
import type { DiffPatch } from "@zoc-studio/shared-types";
import { Check, ChevronDown, FileDiff, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { parseUnifiedDiff } from "@/lib/diff-utils";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/toast";

export function DiffCard({ patch }: { patch: DiffPatch }) {
  const [open, setOpen] = useState(true);
  const [confirmReject, setConfirmReject] = useState(false);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { hunks, adds, dels } = parseUnifiedDiff(patch.unified_diff);
  const acceptedHunks = useApp((s) => s.acceptedHunks[patch.id]);
  const toggleHunk = useApp((s) => s.toggleHunk);
  const acceptAll = useApp((s) => s.acceptAllForDiff);
  const rejectAll = useApp((s) => s.rejectAllForDiff);
  const setMainView = useApp((s) => s.setMainView);

  // Always clear the pending confirm timer on unmount so we don't fire
  // setState on a torn-down component.
  useEffect(() => {
    return () => {
      if (confirmTimerRef.current !== null) {
        clearTimeout(confirmTimerRef.current);
        confirmTimerRef.current = null;
      }
    };
  }, []);

  const handleReject = () => {
    if (!confirmReject) {
      setConfirmReject(true);
      if (confirmTimerRef.current !== null) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => {
        setConfirmReject(false);
        confirmTimerRef.current = null;
      }, 3000);
      return;
    }
    if (confirmTimerRef.current !== null) {
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
    rejectAll(patch.id);
    toast.message("Patch rejected", { description: patch.file_path });
    setConfirmReject(false);
  };

  return (
    <div className="rounded-md border border-border bg-card/60">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <FileDiff className="h-3.5 w-3.5 text-primary" />
        <span className="flex-1 truncate font-mono text-xs">{patch.file_path}</span>
        <Badge variant="success">+{adds}</Badge>
        <Badge variant="destructive">−{dels}</Badge>
        <ChevronDown className={cn("h-3 w-3 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <>
          {patch.summary && (
            <div className="border-t border-border bg-muted/30 px-2.5 py-1.5 text-[11px] text-muted-foreground">
              {patch.summary}
            </div>
          )}
          <div className="max-h-72 overflow-auto border-t border-border font-mono text-[11px]">
            {hunks.map((h, hi) => {
              const accepted = acceptedHunks?.has(hi) ?? false;
              return (
                <div key={hi} className="border-b border-border/40">
                  <div className="flex items-center justify-between bg-muted/40 px-2 py-1 text-[10px] text-muted-foreground">
                    <span>{h.header || `hunk ${hi + 1}`}</span>
                    <button
                      type="button"
                      onClick={() => toggleHunk(patch.id, hi)}
                      className={cn(
                        "flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors",
                        accepted ? "bg-emerald-500/15 text-emerald-300" : "hover:bg-accent",
                      )}
                    >
                      <Check className="h-3 w-3" />
                      {accepted ? "accepted" : "accept"}
                    </button>
                  </div>
                  {h.lines.map((l, li) => (
                    <div
                      key={li}
                      className={cn(
                        "flex gap-1 px-2",
                        l.kind === "add" && "bg-emerald-500/10 text-emerald-200",
                        l.kind === "del" && "bg-red-500/10 text-red-200",
                      )}
                    >
                      <span className="w-3">
                        {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
                      </span>
                      <span className="whitespace-pre">{l.text}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
          <div className="flex items-center justify-end gap-1.5 border-t border-border px-2 py-1.5">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              onClick={() => setMainView("diff")}
            >
              Open in review
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px] text-destructive"
              onClick={handleReject}
            >
              <X className="mr-1 h-3 w-3" />
              {confirmReject ? "Click again to confirm" : "Reject"}
            </Button>
            <Button
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={async () => {
                const ok = await acceptAll(patch.id);
                if (ok) toast.success("Patch applied", { description: patch.file_path });
                else toast.error("Couldn't apply patch", { description: patch.file_path });
              }}
            >
              <Check className="mr-1 h-3 w-3" /> Apply
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
