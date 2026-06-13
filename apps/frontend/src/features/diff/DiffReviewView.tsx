import { useState } from "react";
import {
  AlignLeft,
  Check,
  ChevronDown,
  ChevronUp,
  CircleDot,
  CircleSlash,
  Columns,
  FileDiff,
  ShieldAlert,
  Undo2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useApp } from "@/lib/store";
import { changePosition, nextIndex, parseUnifiedDiff, prevIndex, reviewSummary } from "@/lib/diff-utils";
import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/toast";

type Mode = "inline" | "split";

export function DiffReviewView() {
  const patches = useApp((s) => s.pendingPatches);
  const accept = useApp((s) => s.acceptAllForDiff);
  const reject = useApp((s) => s.rejectAllForDiff);
  const acceptedHunks = useApp((s) => s.acceptedHunks);
  const acceptHunk = useApp((s) => s.acceptHunk);
  const rejectHunk = useApp((s) => s.rejectHunk);
  const openFile = useApp((s) => s.openFile);
  const setMainView = useApp((s) => s.setMainView);
  const [active, setActive] = useState(patches[0]?.id ?? "");
  const [mode, setMode] = useState<Mode>("inline");
  const [confirm, setConfirm] = useState(false);

  const current = patches.find((p) => p.id === active) ?? patches[0];
  const currentIndex = current ? patches.findIndex((p) => p.id === current.id) : -1;
  // R5.5/5.6/5.9/5.10: navigation clamps at the first/last change.
  const goPrev = () => {
    const idx = prevIndex(currentIndex, patches.length);
    if (idx >= 0) setActive(patches[idx].id);
  };
  const goNext = () => {
    const idx = nextIndex(currentIndex, patches.length);
    if (idx >= 0) setActive(patches[idx].id);
  };
  const position = changePosition(currentIndex, patches.length);

  if (!current) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No pending patches.
      </div>
    );
  }

  const applyAll = () => {
    const ids = patches.map((p) => p.id);
    ids.forEach(accept);
    toast.success(`Applied ${ids.length} patch${ids.length === 1 ? "" : "es"}`);
    setConfirm(false);
  };

  const accepted = acceptedHunks[current.id] ?? new Set<number>();
  const { hunks: currentHunks, adds: currentAdds, dels: currentDels } = parseUnifiedDiff(
    current.unified_diff,
  );

  return (
    <div className="flex h-full bg-background">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border">
        <div className="flex items-center justify-between px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          <span title="Review pending">
            {(() => {
              const s = reviewSummary(patches);
              return (
                <>
                  {s.files} file{s.files === 1 ? "" : "s"}
                  <span className="ml-1.5 text-success">+{s.adds}</span>
                  <span className="ml-1 text-destructive">-{s.dels}</span>
                </>
              );
            })()}
          </span>
          <Button size="sm" className="h-6 px-2 text-[11px]" onClick={() => setConfirm(true)}>
            Apply all
          </Button>
        </div>
        <ScrollArea className="flex-1">
          <ul className="px-1.5 pb-3">
            {patches.map((p) => {
              const { adds, dels, hunks } = parseUnifiedDiff(p.unified_diff);
              const isActive = current.id === p.id;
              const acc = (acceptedHunks[p.id] ?? new Set<number>()).size;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => setActive(p.id)}
                    className={cn(
                      "flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs hover:bg-accent",
                      isActive && "bg-accent",
                    )}
                  >
                    <FileDiff className="h-3 w-3 text-primary" />
                    <span className="truncate font-mono text-[11px]">{p.file_path}</span>
                    <span className="ml-auto flex items-center gap-1">
                      <Badge variant="success">+{adds}</Badge>
                      <Badge variant="destructive">−{dels}</Badge>
                      {acc > 0 && (
                        <Badge variant="secondary" className="text-[10px]">
                          {acc}/{hunks.length}
                        </Badge>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        {/* Mockup 3: top review toolbar */}
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-[hsl(var(--surface))] px-3">
          <span className="text-[12.5px] font-medium text-foreground/85">Reviewing changes</span>
          <span className="rounded border border-[hsl(var(--border-muted))] bg-card px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">
            {position.n} of {position.m}
          </span>
          <div className="mx-0.5 h-4 w-px bg-[hsl(var(--border-muted))]" />
          <span className="truncate font-mono text-[11.5px] text-muted-foreground">
            {current.file_path}
          </span>
          <span className="rounded border border-[hsl(var(--border-muted))] bg-card px-1.5 py-0.5 font-mono text-[10.5px]">
            <span className="text-success">+{currentAdds}</span>{" "}
            <span className="text-destructive">−{currentDels}</span>
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              size="icon"
              variant="outline"
              className="h-[26px] w-[26px] border-[hsl(var(--border-muted))]"
              onClick={goPrev}
              disabled={currentIndex <= 0}
              aria-label="Previous change"
              title="Previous change"
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="icon"
              variant="outline"
              className="h-[26px] w-[26px] border-[hsl(var(--border-muted))]"
              onClick={goNext}
              disabled={currentIndex < 0 || currentIndex >= patches.length - 1}
              aria-label="Next change"
              title="Next change"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
            <div className="mx-0.5 h-4 w-px bg-[hsl(var(--border-muted))]" />
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[12px]"
              onClick={() => {
                void openFile(current.file_path);
                setMainView("editor");
              }}
            >
              Open file
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 border-[hsl(var(--border-muted))] px-2.5 text-[12px]"
              onClick={() => reject(current.id)}
            >
              <Undo2 className="h-3 w-3" />
              Undo file
            </Button>
            <Button
              size="sm"
              className="h-7 gap-1.5 px-2.5 text-[12px]"
              onClick={() => {
                accept(current.id);
                toast.success("Patch applied", {
                  description: `${current.file_path} (${accepted.size || currentHunks.length} hunk${
                    (accepted.size || currentHunks.length) === 1 ? "" : "s"
                  })`,
                });
              }}
            >
              <Check className="h-3 w-3" />
              Apply file
            </Button>
          </div>
        </div>

        {/* Mode toggle + hunk counter row (kept for inline/split + hunk progress) */}
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
          <div className="flex min-w-0 items-center gap-2">
            <FileDiff className="h-4 w-4 text-primary" />
            {current.summary && (
              <span className="truncate text-xs text-muted-foreground">{current.summary}</span>
            )}
            <Badge variant="secondary" className="ml-1 text-[10px]">
              {accepted.size}/{currentHunks.length} hunks
            </Badge>
          </div>
          <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
            <TabsList className="h-7">
              <TabsTrigger value="inline" className="px-2">
                <AlignLeft className="mr-1 h-3 w-3" /> Inline
              </TabsTrigger>
              <TabsTrigger value="split" className="px-2">
                <Columns className="mr-1 h-3 w-3" /> Split
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <ScrollArea className="flex-1">
          {mode === "inline" ? (
            <InlineMode
              diffId={current.id}
              diff={current.unified_diff}
              accepted={accepted}
              onAccept={(i) => acceptHunk(current.id, i)}
              onReject={(i) => rejectHunk(current.id, i)}
            />
          ) : (
            <SplitMode
              diffId={current.id}
              diff={current.unified_diff}
              accepted={accepted}
              onAccept={(i) => acceptHunk(current.id, i)}
              onReject={(i) => rejectHunk(current.id, i)}
            />
          )}
        </ScrollArea>
      </section>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-amber-400" />
              Apply all patches?
            </DialogTitle>
            <DialogDescription>
              {patches.length} files will be modified. This will write to disk through the agent
              and respect your permission grants.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button onClick={applyAll}>Apply {patches.length}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface HunkProps {
  diffId: string;
  diff: string;
  accepted: Set<number>;
  onAccept: (i: number) => void;
  onReject: (i: number) => void;
}

function HunkActions({
  index,
  accepted,
  onAccept,
  onReject,
}: {
  index: number;
  accepted: boolean;
  onAccept: (i: number) => void;
  onReject: (i: number) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <span
        className={cn(
          "flex items-center gap-1 text-[10px] uppercase tracking-wider",
          accepted ? "text-emerald-400" : "text-muted-foreground",
        )}
      >
        {accepted ? <CircleDot className="h-3 w-3" /> : <CircleSlash className="h-3 w-3" />}
        {accepted ? "Accepted" : "Pending"}
      </span>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-2 text-[11px] text-destructive"
        onClick={() => onReject(index)}
        aria-label={`Reject hunk ${index + 1}`}
      >
        <X className="mr-1 h-3 w-3" />
        Reject hunk
      </Button>
      <Button
        size="sm"
        variant={accepted ? "secondary" : "default"}
        className="h-6 px-2 text-[11px]"
        onClick={() => onAccept(index)}
        aria-label={`Accept hunk ${index + 1}`}
      >
        <Check className="mr-1 h-3 w-3" />
        {accepted ? "Accepted" : "Accept hunk"}
      </Button>
    </div>
  );
}

function InlineMode({ diff, accepted, onAccept, onReject }: HunkProps) {
  const { hunks } = parseUnifiedDiff(diff);
  return (
    <div className="font-mono text-[12.5px]">
      {hunks.map((h, hi) => {
        const isAccepted = accepted.has(hi);
        return (
          <div
            key={hi}
            className={cn("border-b border-border/50", isAccepted && "ring-1 ring-inset ring-emerald-500/30")}
          >
            <div className="flex items-center justify-between bg-muted/40 px-3 py-1">
              <span className="text-[11px] text-muted-foreground">{h.header || `Hunk ${hi + 1}`}</span>
              <HunkActions
                index={hi}
                accepted={isAccepted}
                onAccept={onAccept}
                onReject={onReject}
              />
            </div>
            {h.lines.map((l, li) => (
              <div
                key={li}
                className={cn(
                  "flex gap-2 px-3",
                  l.kind === "add" && "bg-emerald-500/10 text-emerald-200",
                  l.kind === "del" && "bg-red-500/10 text-red-200",
                )}
              >
                <span className="w-8 select-none text-right text-[10px] text-muted-foreground/60">
                  {l.oldNum ?? ""}
                </span>
                <span className="w-8 select-none text-right text-[10px] text-muted-foreground/60">
                  {l.newNum ?? ""}
                </span>
                <span className="w-3 select-none">
                  {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
                </span>
                <span className="whitespace-pre">{l.text}</span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function SplitMode({ diff, accepted, onAccept, onReject }: HunkProps) {
  const { hunks } = parseUnifiedDiff(diff);
  return (
    <div className="font-mono text-[12.5px]">
      {hunks.map((h, hi) => {
        const isAccepted = accepted.has(hi);
        return (
          <div
            key={hi}
            className={cn("border-b border-border/50", isAccepted && "ring-1 ring-inset ring-emerald-500/30")}
          >
            <div className="flex items-center justify-between bg-muted/40 px-3 py-1">
              <span className="text-[11px] text-muted-foreground">{h.header || `Hunk ${hi + 1}`}</span>
              <HunkActions
                index={hi}
                accepted={isAccepted}
                onAccept={onAccept}
                onReject={onReject}
              />
            </div>
            <div className="grid grid-cols-2 divide-x divide-border">
              {(["left", "right"] as const).map((side) => (
                <div key={side}>
                  <div className="bg-muted/20 px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                    {side === "left" ? "Before" : "After"}
                  </div>
                  {h.lines
                    .filter((l) => (side === "left" ? l.kind !== "add" : l.kind !== "del"))
                    .map((l, li) => (
                      <div
                        key={li}
                        className={cn(
                          "flex gap-2 px-3",
                          side === "left" && l.kind === "del" && "bg-red-500/10 text-red-200",
                          side === "right" && l.kind === "add" && "bg-emerald-500/10 text-emerald-200",
                        )}
                      >
                        <span className="w-8 select-none text-right text-[10px] text-muted-foreground/60">
                          {side === "left" ? l.oldNum : l.newNum}
                        </span>
                        <span className="whitespace-pre">{l.text}</span>
                      </div>
                    ))}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
