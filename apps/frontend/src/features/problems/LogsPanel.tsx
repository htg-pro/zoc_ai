import { useEffect, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { useApp, type LogLevel } from "@/lib/store";

const COLORS: Record<LogLevel, string> = {
  debug: "text-muted-foreground",
  info: "text-foreground",
  warning: "text-amber-400",
  error: "text-destructive",
};

function clock(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour12: false });
}

export function LogsPanel() {
  const logs = useApp((s) => s.logs);
  const clearLogs = useApp((s) => s.clearLogs);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [logs]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border px-2 py-1">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {logs.length} log line{logs.length === 1 ? "" : "s"}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5 text-[10px]"
          onClick={clearLogs}
          disabled={logs.length === 0}
        >
          Clear
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {logs.length === 0 ? (
          <div className="px-3 py-10 text-center text-xs text-muted-foreground">
            No log output yet. Sidecar and agent events appear here as they happen.
          </div>
        ) : (
          <pre className="px-3 py-2 font-mono text-[11px] leading-relaxed">
            {logs.map((l, i) => (
              <div key={i}>
                <span className="text-muted-foreground">[{clock(l.ts)}] </span>
                <span className={(COLORS[l.level] ?? "") + " uppercase"}>{l.level.padEnd(7, " ")}</span>
                <span> {l.message}</span>
              </div>
            ))}
            <div ref={endRef} />
          </pre>
        )}
      </ScrollArea>
    </div>
  );
}
