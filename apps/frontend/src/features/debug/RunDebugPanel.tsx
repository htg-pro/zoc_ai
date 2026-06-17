import { useEffect, useState, type ReactNode } from "react";
import {
  ChevronRight,
  CircleDot,
  Bug,
  Layers,
  ListTree,
  Play,
  Trash2,
  Variable,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useApp } from "@/lib/store";
import { isTauri } from "@/lib/tauri-bridge";
import { basename } from "@/lib/paths";
import { cn } from "@/lib/utils";

export function RunDebugPanel() {
  const configs = useApp((s) => s.launchConfigs);
  const selected = useApp((s) => s.selectedDebugConfig);
  const setSelected = useApp((s) => s.setSelectedDebugConfig);
  const loadLaunchConfigs = useApp((s) => s.loadLaunchConfigs);
  const breakpoints = useApp((s) => s.breakpoints);
  const toggleBreakpoint = useApp((s) => s.toggleBreakpoint);
  const clearBreakpoints = useApp((s) => s.clearBreakpoints);
  const openFile = useApp((s) => s.openFile);

  useEffect(() => {
    void loadLaunchConfigs();
  }, [loadLaunchConfigs]);

  const bpEntries = Object.entries(breakpoints);
  const bpCount = bpEntries.reduce((n, [, lines]) => n + lines.length, 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        {configs.length > 0 ? (
          <Select value={selected ?? undefined} onValueChange={setSelected}>
            <SelectTrigger className="h-6 flex-1 text-[11px]">
              <SelectValue placeholder="Select configuration" />
            </SelectTrigger>
            <SelectContent>
              {configs.map((c) => (
                <SelectItem key={c.name} value={c.name} className="text-[11px]">
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="flex-1 truncate text-[11px] text-muted-foreground">
            No launch configurations
          </span>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 shrink-0"
          title="Debug adapter not wired yet — breakpoints & configs are ready (Phase 8 process runtime)."
          aria-label="Start debugging"
          disabled
        >
          <Play className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="border-b border-border bg-muted/20 px-2 py-1.5 text-[10.5px] leading-snug text-muted-foreground">
        <span className="inline-flex items-center gap-1 text-foreground/80">
          <Bug className="h-3 w-3" /> Debugging
        </span>{" "}
        — set breakpoints in the editor gutter and pick a configuration. Live stepping
        (variables, call stack, console) arrives with the debug-adapter runtime.
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <Section icon={CircleDot} title="Breakpoints" count={bpCount}
          action={
            bpCount > 0 ? (
              <button
                type="button"
                onClick={() => clearBreakpoints()}
                title="Remove all breakpoints"
                aria-label="Remove all breakpoints"
                className="text-muted-foreground hover:text-foreground"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            ) : null
          }
        >
          {bpCount === 0 ? (
            <Hint>Click the editor gutter (left of the line numbers) to add a breakpoint.</Hint>
          ) : (
            bpEntries.map(([file, lines]) =>
              lines.map((line) => (
                <button
                  key={`${file}:${line}`}
                  type="button"
                  onClick={() => void openFile(file)}
                  className="group flex w-full items-center gap-2 px-2 py-0.5 text-left text-[11px] hover:bg-accent/40"
                >
                  <CircleDot className="h-3 w-3 shrink-0 text-destructive" />
                  <span className="truncate font-mono">{basename(file)}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">:{line}</span>
                  <span
                    role="button"
                    aria-label="Remove breakpoint"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleBreakpoint(file, line);
                    }}
                    className="ml-auto opacity-0 group-hover:opacity-100"
                  >
                    <Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" />
                  </span>
                </button>
              )),
            )
          )}
        </Section>

        <Section icon={Variable} title="Variables">
          <Hint>{isTauri() ? "Available while paused at a breakpoint." : "Debugging runs in the desktop app."}</Hint>
        </Section>
        <Section icon={ListTree} title="Watch">
          <Hint>Add expressions to watch during a debug session.</Hint>
        </Section>
        <Section icon={Layers} title="Call Stack">
          <Hint>Shows the call stack while paused.</Hint>
        </Section>
      </ScrollArea>
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  count,
  action,
  children,
}: {
  icon: typeof Bug;
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="border-b border-border/60">
      <div className="flex items-center gap-1 px-1.5 py-1">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
        >
          <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
          <Icon className="h-3 w-3" />
          {title}
          {typeof count === "number" && count > 0 && (
            <span className="ml-1 font-mono text-[9px]">{count}</span>
          )}
        </button>
        {action}
      </div>
      {open && <div className="pb-1">{children}</div>}
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <div className="px-3 py-1 text-[10.5px] text-muted-foreground/80">{children}</div>;
}
