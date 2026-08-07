/**
 * The pure Terminal_Surface header projection (R8.6, R13) — zoc-agent-chat-rebuild R1.3, R2.3,
 * task 25.1.
 *
 * The header reports the resolved workspace root as the working directory, an occupancy banner
 * naming the holding run only while that run is non-terminal, and the exit status when the process
 * exited non-zero.
 *
 * ## Why this takes a `TerminalHolder` rather than a `RunRecord`
 *
 * It used to take the legacy `RunRecord`, which is what coupled `features/terminal` to
 * `features/agent` — the panel 26.1 deletes. Importing that type into `lib` would have carried the
 * tangle across rather than cutting it: `RunRecord` pulls in `AgentMode`, `ReportedStage`, and
 * through the reducer half of `run-lifecycle`, the whole `AgentEvent` union.
 *
 * The projection reads **three** fields — the run's id, its mode, and whether it has settled — so
 * that is what it now asks for. The caller owns the phase vocabulary and does the mapping, which is
 * the inversion task 25.1 asks for: the surviving feature declares what it needs, and the dying one
 * adapts to it. `features/agent/terminal-header.ts` is that adapter, and it dies with its tree.
 */

/** The holding run, reduced to what the banner actually shows. */
export interface TerminalHolder {
  runId: string;
  /** Names the holding run in the banner — never a generic "Agent". */
  mode: string;
  /** True once the run reached a terminal phase; a settled run no longer holds the terminal. */
  settled: boolean;
}

export interface TerminalHeader {
  /** The resolved Workspace_Root, or null when unbound (R13.1). */
  cwd: string | null;
  /** Occupancy banner while a non-terminal run holds the terminal (R13.3, R13.4). */
  occupancy: { runId: string; label: string } | null;
  /** Exit status shown when the process exited non-zero (R13.5). */
  exit: { code: number } | null;
}

export function terminalHeader(input: {
  resolvedRoot: string | null;
  holder: TerminalHolder | null;
  exitCode: number | null;
}): TerminalHeader {
  const holder = input.holder;
  const occupancy =
    holder && !holder.settled
      ? {
          runId: holder.runId,
          // Name the actual holding run (its mode), never a generic "Agent".
          label: `${holder.mode} run is using this terminal`,
        }
      : null;
  return {
    cwd: input.resolvedRoot,
    occupancy,
    exit: input.exitCode !== null && input.exitCode !== 0 ? { code: input.exitCode } : null,
  };
}
