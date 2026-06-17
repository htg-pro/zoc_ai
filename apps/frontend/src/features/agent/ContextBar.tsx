import { Brain, ListChecks } from "lucide-react";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { contextUsage } from "@/lib/context-usage";
import { todoProgress } from "@/lib/plan-progress";
import type { TodoItem } from "@llama-studio/shared-types";

export function ContextBar() {
  const contextStatus = useApp((s) => s.contextStatus);
  const streaming = useApp((s) => s.streaming);
  // Latest agent-authored to-do list drives the run progress summary (R9.1-9.6).
  const todos = useApp((s) => {
    for (let i = s.agentItems.length - 1; i >= 0; i--) {
      const item = s.agentItems[i];
      if (item.type === "todos") return item.todos as TodoItem[];
    }
    return null;
  });

  if (!contextStatus) {
    return null;
  }

  const { tokens_used, context_window } = contextStatus;

  // R4.12 / R4.15: ratio = consumed/limit; warning state at >= 90%.
  const usage = contextUsage(tokens_used, context_window);
  const progress = todoProgress(todos);

  const formatTokens = (num: number) => {
    if (num >= 1000) {
      return `${(num / 1000).toFixed(1).replace(/\.0$/, "")}k`;
    }
    return num.toString();
  };

  const tokSpeed = streaming ? "14 tok/s" : "0 tok/s";

  return (
    <>
      {progress.total > 0 && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-t border-[#1E1E23] bg-[#101014]">
          <ListChecks className="w-3.5 h-3.5 shrink-0 text-[#71717A]" />
          <span className="font-mono text-[11px] shrink-0 text-[#A1A1AA]">
            {progress.done}/{progress.total} tasks
          </span>
          <span className="flex-1 h-1 rounded-full bg-[#26262B] overflow-hidden">
            <span
              className="block h-full rounded-full bg-[#9B6AF1] transition-all duration-500"
              style={{ width: `${Math.round(progress.ratio * 100)}%` }}
            />
          </span>
          <span className="font-mono text-[11px] text-[#71717A] shrink-0">
            {Math.round(progress.ratio * 100)}%
          </span>
        </div>
      )}
      <div
      className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-t border-[#1E1E23] bg-[#101014]"
      data-context-warning={usage.warning ? "true" : "false"}
    >
      <Brain
        className={cn(
          "w-3.5 h-3.5 shrink-0",
          usage.warning ? "text-warning" : "text-[#71717A]",
        )}
      />
      <span
        className={cn(
          "font-mono text-[11px] shrink-0",
          usage.warning ? "text-warning" : "text-[#A1A1AA]",
        )}
        title={
          usage.warning
            ? `Context almost full — ${usage.percent}% of the window used`
            : `${usage.percent}% of the context window used`
        }
      >
        {formatTokens(tokens_used)} / {formatTokens(context_window)} context
      </span>
      <span className="w-16 h-1 rounded-full bg-[#26262B] overflow-hidden shrink-0">
        <span
          className={cn(
            "block h-full rounded-full transition-all duration-500",
            usage.warning ? "bg-warning" : "bg-[#9B6AF1]",
          )}
          style={{ width: `${usage.percent}%` }}
        />
      </span>
      <span className="ml-auto font-mono text-[11px] text-[#71717A] shrink-0">
        {tokSpeed}
      </span>
    </div>
    </>
  );
}
