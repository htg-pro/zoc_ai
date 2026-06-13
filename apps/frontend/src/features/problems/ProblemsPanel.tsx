import { AlertTriangle, AlertCircle, Info } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";

const PROBLEMS = [
  {
    file: "src/features/agent/Composer.tsx",
    line: 42,
    col: 9,
    severity: "warning" as const,
    message: "'streaming' is declared but never read.",
  },
  {
    file: "services/agent/loop.py",
    line: 118,
    col: 1,
    severity: "info" as const,
    message: "TODO: hook up plan repair attempts to telemetry.",
  },
];

export function ProblemsPanel() {
  return (
    <ScrollArea className="h-full">
      <ul className="divide-y divide-border text-xs">
        {PROBLEMS.map((p, i) => {
          const Icon =
            p.severity === "warning" ? AlertTriangle : p.severity === "info" ? Info : AlertCircle;
          return (
            <li key={i} className="flex items-start gap-2 px-3 py-2 hover:bg-accent/40">
              <Icon
                className={
                  p.severity === "warning"
                    ? "h-3.5 w-3.5 text-amber-400"
                    : p.severity === "info"
                      ? "h-3.5 w-3.5 text-blue-400"
                      : "h-3.5 w-3.5 text-destructive"
                }
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-foreground">{p.message}</div>
                <div className="font-mono text-[10px] text-muted-foreground">
                  {p.file}:{p.line}:{p.col}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </ScrollArea>
  );
}
