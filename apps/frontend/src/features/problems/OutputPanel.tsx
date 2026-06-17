import { useEffect, useMemo, useRef, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useApp, OUTPUT_CHANNELS, type OutputChannel } from "@/lib/store";

export function OutputPanel() {
  const channels = useApp((s) => s.outputChannels);
  const clearOutput = useApp((s) => s.clearOutput);
  const [channel, setChannel] = useState<OutputChannel>("Tasks");
  const endRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => channels[channel] ?? [], [channels, channel]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lines]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-2 py-1">
        <Select value={channel} onValueChange={(v) => setChannel(v as OutputChannel)}>
          <SelectTrigger className="h-6 w-44 text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OUTPUT_CHANNELS.map((c) => (
              <SelectItem key={c} value={c} className="text-[11px]">
                {c}
                {channels[c]?.length ? ` (${channels[c].length})` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-6 px-1.5 text-[10px]"
          onClick={() => clearOutput(channel)}
          disabled={lines.length === 0}
        >
          Clear
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {lines.length === 0 ? (
          <div className="px-3 py-10 text-center text-xs text-muted-foreground">
            No output on the {channel} channel yet.
          </div>
        ) : (
          <pre className="whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-relaxed">
            {lines.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
            <div ref={endRef} />
          </pre>
        )}
      </ScrollArea>
    </div>
  );
}
