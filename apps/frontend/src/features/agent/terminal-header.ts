/**
 * terminal-header.ts — the pure Terminal_Surface header projection (R8.6, R13).
 *
 * The header reports the resolved workspace root as the working directory, an
 * occupancy banner naming the holding run only while that run is non-terminal,
 * and the exit status when the process exited non-zero.
 */
import { type RunRecord, isTerminalPhase } from "./run-lifecycle";

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
  holder: RunRecord | null;
  exitCode: number | null;
}): TerminalHeader {
  const holder = input.holder;
  const occupancy =
    holder && !isTerminalPhase(holder.phase)
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
