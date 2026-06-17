import { useMemo } from "react";
import type { ReactNode } from "react";
import { FileText, ShieldCheck } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useApp } from "@/lib/store";
import { classifyRuleSources, summarizeRuleSources, type RuleKind } from "@/lib/rules-sources";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<RuleKind, string> = {
  zoc: "Zoc",
  cursor: "Cursor",
  agents: "AGENTS.md",
  other: "Other",
};

/**
 * Rules viewer (develop.md Phase 11). Surfaces the active project rules and
 * their sources before a run starts — opened from the "Rules" badge in the
 * composer. The backend supplies the merged rule text + source list; this
 * classifies the sources (.zoc / .cursor / AGENTS.md, nested) for display.
 */
export function RulesDialog({ children }: { children: ReactNode }) {
  const projectRules = useApp((s) => s.projectRules);
  const sources = useMemo(
    () => classifyRuleSources(projectRules?.sources ?? []),
    [projectRules?.sources],
  );

  return (
    <Dialog>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-emerald-400" />
            Project Rules
          </DialogTitle>
          <DialogDescription>
            {summarizeRuleSources(sources)} — applied to every run in this workspace.
          </DialogDescription>
        </DialogHeader>

        {sources.length > 0 ? (
          <div className="space-y-3">
            <ul className="flex flex-col gap-1">
              {sources.map((s) => (
                <li
                  key={s.path}
                  className="flex items-center gap-2 rounded border border-border bg-accent/40 px-2 py-1.5 text-xs"
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate font-mono text-[11px]">{s.path}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1">
                    <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[9px] font-medium uppercase text-primary">
                      {KIND_LABEL[s.kind]}
                    </span>
                    {s.nested && (
                      <span className="rounded bg-accent px-1.5 py-0.5 text-[9px] font-medium uppercase text-muted-foreground">
                        Nested
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            {projectRules?.rules && (
              <ScrollArea className="max-h-72 rounded border border-border bg-[#101014]">
                <pre className={cn("whitespace-pre-wrap p-3 font-mono text-[11px] text-[#D4D4D8]")}>
                  {projectRules.rules}
                </pre>
              </ScrollArea>
            )}
          </div>
        ) : (
          <div className="rounded border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            No project rules found. Add a <code className="text-xs">.zoc/rules</code> file,{" "}
            <code className="text-xs">.cursor/rules</code>, or an{" "}
            <code className="text-xs">AGENTS.md</code> to guide the agent.
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
