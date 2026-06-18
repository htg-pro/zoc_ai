import type { DiffPatch } from "@zoc-studio/shared-types";
import { parseUnifiedDiff } from "@/lib/diff-utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

export function InlineDiffView({ patch }: { patch: DiffPatch }) {
  const { hunks } = parseUnifiedDiff(patch.unified_diff);
  return (
    <ScrollArea className="flex-1">
      <div className="font-mono text-[12.5px] leading-relaxed">
        {hunks.map((h, hi) => (
          <div key={hi} className="border-b border-border/40">
            <div className="bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground">{h.header}</div>
            {h.lines.map((l, li) => (
              <div
                key={li}
                className={cn(
                  "flex gap-2 px-3",
                  l.kind === "add" && "bg-emerald-500/10 text-emerald-200",
                  l.kind === "del" && "bg-red-500/10 text-red-200 line-through",
                )}
              >
                <span className="w-8 select-none text-right text-[10px] text-muted-foreground/70">
                  {l.oldNum ?? ""}
                </span>
                <span className="w-8 select-none text-right text-[10px] text-muted-foreground/70">
                  {l.newNum ?? ""}
                </span>
                <span className="w-3 select-none">
                  {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
                </span>
                <span className="whitespace-pre">{l.text}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}
