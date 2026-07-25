import { CheckCircle2, ChevronDown, Layers, Loader2, PauseCircle, Square, XCircle } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  activeRuns,
  isTerminal,
  orderRuns,
  runCountBadge,
  runDuration,
  runLabel,
  type RunPhase,
  type TrackedRun,
} from "./agent-runs";

function PhaseIcon({ phase }: { phase: RunPhase }) {
  switch (phase) {
    case "running":
      return <Loader2 className="h-3 w-3 animate-spin text-[#9B6AF1]" />;
    case "paused":
      return <PauseCircle className="h-3 w-3 text-[#71717A]" />;
    case "done":
      return <CheckCircle2 className="h-3 w-3 text-[var(--zoc-success)]" />;
    default:
      return <XCircle className="h-3 w-3 text-[var(--zoc-error)]" />;
  }
}

/**
 * Run switcher for the agent panel header (§12.3).
 *
 * Shows how many runs are executing and lets the user focus one. Finished runs
 * stay in the list (collapsed to a summary line) so their output remains
 * reachable after they complete.
 */
export function AgentRunSwitcher({
  runs = [],
  focusedRunId = null,
  maxConcurrentRuns = 3,
  onFocus,
  onStop,
  now = Date.now(),
}: {
  runs?: readonly TrackedRun[];
  focusedRunId?: string | null;
  maxConcurrentRuns?: number;
  onFocus: (runId: string) => void;
  onStop?: (runId: string) => void;
  now?: number;
}) {
  // A single run needs no switcher — the panel header already describes it.
  // Defaulting `runs` also keeps the panel renderable under a narrow store
  // double that does not provide the multi-run slice.
  if (runs.length <= 1) return null;

  const ordered = orderRuns(runs);
  const badge = runCountBadge(runs);
  const running = activeRuns(runs).length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="run-switcher"
          aria-label={`Switch run (${running} active)`}
          className="inline-flex h-6 items-center gap-1 rounded border border-[#26262B] bg-[#15151A] px-1.5 text-[10.5px] text-[#A1A1AA] hover:bg-[#1E1E23] hover:text-[#EDEDF0]"
          title={`${running} of ${maxConcurrentRuns} concurrent runs active`}
        >
          <Layers className="h-3 w-3" />
          Runs
          {badge && (
            <span
              data-testid="run-count-badge"
              className="ml-0.5 rounded-full bg-[#9B6AF1]/20 px-1 font-mono text-[9.5px] text-[#9B6AF1]"
            >
              {badge}
            </span>
          )}
          <ChevronDown className="h-3 w-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {running} active · limit {maxConcurrentRuns}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {ordered.map((run) => (
          <DropdownMenuItem
            key={run.runId}
            onSelect={() => onFocus(run.runId)}
            className="flex items-start gap-2"
          >
            <span className="mt-0.5 shrink-0">
              <PhaseIcon phase={run.phase} />
            </span>
            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  "block truncate text-[12px]",
                  run.runId === focusedRunId && "font-medium text-foreground",
                  isTerminal(run) && "text-muted-foreground",
                )}
              >
                {runLabel(run)}
              </span>
              <span className="block text-[10px] text-muted-foreground">
                {run.mode} · {run.stage ?? run.phase} · {runDuration(run, now)}
              </span>
            </span>
            {onStop && !isTerminal(run) && (
              <button
                type="button"
                aria-label={`Stop ${runLabel(run)}`}
                title="Stop this run"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onStop(run.runId);
                }}
                className="mt-0.5 shrink-0 rounded p-0.5 text-[var(--zoc-error)] hover:bg-[var(--zoc-error)]/15"
              >
                <Square className="h-2.5 w-2.5 fill-current" />
              </button>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
