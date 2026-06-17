import { useMemo } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Info, Loader2 } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useApp } from "@/lib/store";
import { isTauri } from "@/lib/tauri-bridge";
import { countBySeverity, type CheckKind, type Diagnostic, type Severity } from "@/lib/problem-matchers";
import { basename, joinPath } from "@/lib/paths";
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

  const open = (file: string) => {
    const abs = file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file)
      ? file
      : workspaceRoot
        ? joinPath(workspaceRoot, file)
        : file;
    void openFile(abs);
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
            {byFile.map(([file, items]) => (
              <div key={file} className="mb-1">
                <button
                  type="button"
                  onClick={() => open(file)}
                  className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-accent/40"
                >
                  <span className="truncate font-mono text-[11px] text-foreground">{basename(file)}</span>
                  <span className="truncate text-[10px] text-muted-foreground">{file}</span>
                  <Badge variant="muted" className="ml-auto shrink-0">
                    {items.length}
                  </Badge>
                </button>
                {items.map((d, i) => {
                  const { Icon, className } = SEVERITY_ICON[d.severity];
                  return (
                    <button
                      key={`${d.line}:${d.column}:${i}`}
                      type="button"
                      onClick={() => open(d.file)}
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
            ))}
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
