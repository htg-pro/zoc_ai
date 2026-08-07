import { useMemo, useState } from "react";
import { ChevronRight, Download, Route } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  buildRunTrace,
  criticalPath,
  formatDuration,
  formatOffset,
  serializeTrace,
  traceFilename,
  type RunTrace,
  type StageSegment,
  type TraceEvent,
} from "./run-trace";

/**
 * Run trace viewer (§16.1).
 *
 * A stage band across the top, the full ordered event list below it, and a
 * "Critical path" toggle that highlights the events accounting for most of the
 * wall clock. Export writes the whole trace as JSON.
 */
export function RunTracePanel({
  runId,
  events,
  onExport = downloadTrace,
}: {
  runId: string;
  events: readonly Record<string, unknown>[];
  /** Injected in tests so the export path is observable without a download. */
  onExport?: (trace: RunTrace) => void;
}) {
  const trace = useMemo(() => buildRunTrace(runId, events as never[]), [runId, events]);
  const [showCriticalPath, setShowCriticalPath] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);

  const critical = useMemo(
    () => (showCriticalPath ? new Set(criticalPath(trace)) : new Set<number>()),
    [showCriticalPath, trace],
  );

  if (trace.events.length === 0) {
    return (
      <div
        data-testid="run-trace-empty"
        className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground"
      >
        No trace for this run yet.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="run-trace-panel">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1.5">
        <span className="font-mono text-[11px] text-muted-foreground">{trace.runId}</span>
        <span className="text-[11px]">{formatDuration(trace.durationMs)}</span>
        <span className="text-[11px] text-muted-foreground">{trace.events.length} events</span>
        {trace.totalTokens > 0 && (
          <span className="text-[11px] text-muted-foreground">
            {trace.totalTokens.toLocaleString()} tokens
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant={showCriticalPath ? "secondary" : "ghost"}
            aria-pressed={showCriticalPath}
            onClick={() => setShowCriticalPath((on) => !on)}
            title="Highlight the events that consumed most of the run"
          >
            <Route className="mr-1 h-3.5 w-3.5" />
            Critical path
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onExport(trace)}>
            <Download className="mr-1 h-3.5 w-3.5" />
            Export JSON
          </Button>
        </div>
      </header>

      <StageBand segments={trace.segments} totalMs={trace.durationMs} />

      <ul className="min-h-0 flex-1 overflow-y-auto text-[11.5px]" data-testid="trace-events">
        {trace.events.map((event) => (
          <TraceRow
            key={event.seq}
            event={event}
            highlighted={critical.has(event.seq)}
            open={expanded === event.seq}
            onToggle={() => setExpanded(expanded === event.seq ? null : event.seq)}
          />
        ))}
      </ul>
    </div>
  );
}

function StageBand({ segments, totalMs }: { segments: readonly StageSegment[]; totalMs: number }) {
  return (
    <div className="border-b border-border px-2 py-2" data-testid="stage-band">
      <div className="flex h-4 w-full overflow-hidden rounded bg-muted">
        {segments.map((segment, index) => (
          <div
            key={`${segment.stage}-${index}`}
            // A zero-duration segment still deserves a sliver so a fast stage is
            // visible rather than silently absent.
            style={{
              width: `${Math.max(1.5, segment.ratio * 100)}%`,
              backgroundColor: segment.color,
            }}
            title={`${segment.stage} · ${formatDuration(segment.durationMs)} · ${
              segment.eventCount
            } event${segment.eventCount === 1 ? "" : "s"} · ${segment.tokenCount.toLocaleString()} tokens`}
            data-stage={segment.stage}
          />
        ))}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
        {segments.map((segment, index) => (
          <span
            key={`legend-${segment.stage}-${index}`}
            className="flex items-center gap-1 text-[10px] text-muted-foreground"
          >
            <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: segment.color }} />
            {segment.stage} {formatDuration(segment.durationMs)} ·{" "}
            {segment.tokenCount.toLocaleString()} tok
          </span>
        ))}
        <span className="ml-auto text-[10px] text-muted-foreground">
          total {formatDuration(totalMs)}
        </span>
      </div>
    </div>
  );
}

function TraceRow({
  event,
  highlighted,
  open,
  onToggle,
}: {
  event: TraceEvent;
  highlighted: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <li
      className={cn("border-b border-border/40", highlighted && "bg-[var(--zoc-ember)]/10")}
      data-critical={highlighted || undefined}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-accent/50"
      >
        <ChevronRight
          className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")}
        />
        <span className="w-8 shrink-0 font-mono text-[10px] text-muted-foreground">
          {event.seq}
        </span>
        <span className="w-14 shrink-0 font-mono text-[10px] text-muted-foreground">
          {formatOffset(event.offsetMs)}
        </span>
        <span
          className="w-24 shrink-0 truncate font-mono text-[10.5px]"
          style={{ color: stageTint(event.stage) }}
        >
          {event.type}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{event.summary}</span>
        {event.durationMs > 0 && (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
            {formatDuration(event.durationMs)}
          </span>
        )}
      </button>
      {open && (
        <pre className="max-h-64 overflow-auto border-t border-border/40 bg-muted/30 px-3 py-2 font-mono text-[10.5px] leading-relaxed">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      )}
    </li>
  );
}

function stageTint(stage: string): string {
  return stageColorCache[stage] ?? "#A1A1AA";
}

// Small local lookup so the row does not re-import the palette per render.
const stageColorCache: Record<string, string> = {
  INTAKE: "#60a5fa",
  ANALYZE: "#a78bfa",
  PLAN: "#fbbf24",
  APPLY: "#4ade80",
  VERIFY: "#2dd4bf",
  SUMMARY: "#a1a1aa",
};

/**
 * Save the trace as a JSON file.
 *
 * Uses an object URL rather than a Tauri save dialog so it works identically in
 * the browser preview; the browser's own download UI picks the location.
 */
function downloadTrace(trace: RunTrace): void {
  try {
    const blob = new Blob([serializeTrace(trace)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = traceFilename(trace.runId);
    anchor.click();
    URL.revokeObjectURL(url);
  } catch {
    /* download unavailable (headless) — nothing useful to surface */
  }
}
