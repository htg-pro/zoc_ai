import { useMemo } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Info, Loader2, Wand2 } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useApp } from "@/lib/store";
import { isTauri } from "@/lib/tauri-bridge";
import { countBySeverity, type CheckKind, type Diagnostic, type Severity } from "@/lib/problem-matchers";
import { basename, joinPath } from "@/lib/paths";
import { revealPosition, requestReveal } from "@/lib/editor-actions";
import { buildFixErrorsPrompt, errorCount } from "./fix-errors-prompt";
import { cn } from "@/lib/utils";

const SEVERITY_ICON: Record<Severity, { Icon: typeof AlertTriangle; className: string }> = {
  error: { Icon: AlertCircle, className: "text-destructive" },
  warning: { Icon: AlertTriangle, className: "text-amber-400" },
  info: { Icon: Info, className: "text-blue-400" },
  hint: { Icon: Info, className: "text-muted-foreground" },
};

const CHECKS: { kind: CheckKind; label: string; cwd?: string }[] = [
  { kind: "tsc", label: "tsc", cwd: "apps/frontend" },
  { kind: "eslint", label: "eslint", cwd: "apps/frontend" },
  { kind: "ruff", label: "ruff" },
  { kind: "cargo", label: "cargo" },
];

export function ProblemsPanel() {
  const diagnostics = useApp((s) => s.diagnostics);
  const runDiagnostics = useApp((s) => s.runDiagnostics);
  const clearDiagnostics = useApp((s) => s.clearDiagnostics);
  const openFile = useApp((s) => s.openFile);
  const workspaceRoot = useApp((s) => s.workspaceRoot);
  const activeFile = useApp((s) => s.activeFile);
  const setInput = useApp((s) => s.setInput);
  const setAgentMode = useApp((s) => s.setAgentMode);

  const all = useMemo<Diagnostic[]>(() => Object.values(diagnostics).flat(), [diagnostics]);
  const byFile = useMemo(() => {
    const map = new Map<string, Diagnostic[]>();
    for (const d of all) {
      const arr = map.get(d.file) ?? [];
      arr.push(d);
      map.set(d.file, arr);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [all]);

  const { errors, warnings } = countBySeverity(all);

  const resolveAbs = (file: string): string =>
    file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file)
      ? file
      : workspaceRoot
        ? joinPath(workspaceRoot, file)
        : file;

  // R3.1–R3.4: open the file and navigate to (line, column). When the file is
  // already the active editor, reveal immediately (no reload, R3.4); otherwise
  // buffer the target so MonacoView reveals once the file mounts/activates.
  const openAt = (file: string, line: number, column: number) => {
    const abs = resolveAbs(file);
    if (abs === activeFile) {
      void openFile(abs);
      revealPosition(line, column);
      return;
    }
    requestReveal(abs, line, column);
    void openFile(abs);
  };

  // R6: hand a file's error-severity diagnostics to the agent as an editable,
  // unsent Composer draft in Agent mode. Sends nothing.
  const runAgentToFix = (file: string, items: Diagnostic[]) => {
    setInput(buildFixErrorsPrompt(file, items));
    setAgentMode("agent");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        <span className="mr-1 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <AlertCircle className="h-3 w-3 text-destructive" />
            {errors}
          </span>
          <span className="flex items-center gap-1">
            <AlertTriangle className="h-3 w-3 text-amber-400" />
            {warnings}
          </span>
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          {CHECKS.map((c) => (
            <RunButton key={c.kind} label={c.label} onClick={() => void runDiagnostics(c.kind, c.cwd)} />
          ))}
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-[10px]"
            onClick={() => clearDiagnostics()}
            disabled={all.length === 0}
          >
            Clear
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {all.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-4 py-10 text-center">
            <CheckCircle2 className="h-6 w-6 text-emerald-500/70" />
            <div className="text-xs text-muted-foreground">No problems detected</div>
            <div className="text-[10px] text-muted-foreground/70">
              {isTauri() ? "Run a checker above to populate this list." : "Validation runs in the desktop app."}
            </div>
          </div>
        ) : (
          <div className="py-1">
            {byFile.map(([file, items]) => {
              const nErrors = errorCount(items);
              return (
                <div key={file} className="mb-1">
                  <div className="flex w-full items-center gap-1.5 px-2 py-1 hover:bg-accent/40">
                    <button
                      type="button"
                      onClick={() => openAt(file, items[0]?.line ?? 1, items[0]?.column ?? 1)}
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    >
                      <span className="truncate font-mono text-[11px] text-foreground">{basename(file)}</span>
                      <span className="truncate text-[10px] text-muted-foreground">{file}</span>
                    </button>
                    {nErrors >= 1 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-5 shrink-0 gap-1 px-1.5 text-[10px] text-primary hover:bg-primary/12"
                        title={`Pre-fill the Composer to ask the agent to fix ${nErrors} error${nErrors === 1 ? "" : "s"}`}
                        onClick={() => runAgentToFix(file, items)}
                      >
                        <Wand2 className="h-3 w-3" />
                        Run agent to fix {nErrors} error{nErrors === 1 ? "" : "s"}
                      </Button>
                    )}
                    <Badge variant="muted" className="shrink-0">
                      {items.length}
                    </Badge>
                  </div>
                  {items.map((d, i) => {
                    const { Icon, className } = SEVERITY_ICON[d.severity];
                    return (
                      <button
                        key={`${d.line}:${d.column}:${i}`}
                        type="button"
                        onClick={() => openAt(d.file, d.line, d.column)}
                        className="flex w-full items-start gap-2 px-3 py-1 pl-5 text-left hover:bg-accent/40"
                      >
                        <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", className)} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs text-foreground">{d.message}</span>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {d.source}
                            {d.code ? `(${d.code})` : ""} · {d.line}:{d.column}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

function RunButton({ label, onClick }: { label: string; onClick: () => void }) {
  const running = useApp((s) => s.logs[s.logs.length - 1]?.message === `Running ${label} check…`);
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-6 px-1.5 font-mono text-[10px]"
      onClick={onClick}
      title={`Run ${label}`}
    >
      {running ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
      {label}
    </Button>
  );
}
