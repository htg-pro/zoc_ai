/**
 * Compact per-language LSP state displayed in the primary editor tab strip.
 * One item is derived for each distinct mapped language among open files.
 */
import { Loader2 } from "lucide-react";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { lspIndicatorViews } from "./lsp-status";
import type { LspStatusView } from "./lsp-status";

export function LspStatusIndicators() {
  const openFiles = useApp((s) => s.openFiles);
  const serverStates = useApp((s) => s.serverStates);
  const views = lspIndicatorViews(openFiles, serverStates);
  if (views.length === 0) return null;

  return (
    <div
      role="status"
      aria-label="Language server status"
      aria-live="polite"
      className="flex shrink-0 items-stretch border-l border-border"
    >
      {views.map((view) => (
        <LspIndicatorItem key={view.languageId} view={view} />
      ))}
    </div>
  );
}

function LspIndicatorItem({ view }: { view: LspStatusView }) {
  const title =
    view.state === "connected"
      ? `${view.label} language server connected`
      : view.state === "error"
        ? `${view.label} language server unavailable`
        : `${view.label} language server starting…`;

  return (
    <span
      title={title}
      aria-label={title}
      className={cn(
        "flex h-full items-center gap-1.5 px-2.5 text-[11px] text-muted-foreground",
        view.tone === "error" && "text-destructive",
      )}
    >
      {view.tone === "busy" ? (
        <Loader2 className="h-3 w-3 animate-spin text-primary" aria-hidden />
      ) : (
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            view.tone === "error" ? "bg-destructive" : "bg-emerald-400",
          )}
          aria-hidden
        />
      )}
      <span>{view.label}</span>
    </span>
  );
}
