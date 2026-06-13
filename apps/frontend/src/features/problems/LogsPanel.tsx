import { ScrollArea } from "@/components/ui/scroll-area";

const LOGS = [
  { ts: "12:04:21", level: "info", msg: "Agent sidecar bound to 127.0.0.1:8765" },
  { ts: "12:04:22", level: "info", msg: "Indexer started watching /home/me/llama-studio" },
  { ts: "12:05:01", level: "info", msg: "Session sess-1 opened (model=qwen2.5-coder-32b)" },
  { ts: "12:05:07", level: "info", msg: "Plan drafted with 5 steps" },
  { ts: "12:05:09", level: "info", msg: "tool_call fs.write succeeded (4823 bytes)" },
  { ts: "12:05:11", level: "debug", msg: "Diff streamed: 2 patches, 12 add / 1 del" },
];

const COLORS: Record<string, string> = {
  debug: "text-muted-foreground",
  info: "text-foreground",
  warn: "text-amber-400",
  error: "text-destructive",
};

export function LogsPanel() {
  return (
    <ScrollArea className="h-full">
      <pre className="px-3 py-2 font-mono text-[11px] leading-relaxed">
        {LOGS.map((l, i) => (
          <div key={i}>
            <span className="text-muted-foreground">[{l.ts}] </span>
            <span className={(COLORS[l.level] ?? "") + " uppercase"}>{l.level.padEnd(5, " ")}</span>
            <span> {l.msg}</span>
          </div>
        ))}
      </pre>
    </ScrollArea>
  );
}
