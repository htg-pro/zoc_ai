/**
 * Timeline model (develop.md "Missing UI Checklist" → Side Panel → Timeline).
 *
 * Merges two real history sources — Git commits and agent checkpoints — into a
 * single, time-sorted feed for the Timeline side view. Pure and dependency-free
 * so the merge/sort logic is unit-testable; the panel supplies the live data.
 */
import type { GitCommit } from "./tauri-bridge";
import type { CheckpointInfo } from "@llama-studio/shared-types";

export type TimelineKind = "commit" | "checkpoint";

export interface TimelineEntry {
  id: string;
  kind: TimelineKind;
  title: string;
  subtitle: string;
  /** Epoch milliseconds. */
  ts: number;
  /** For checkpoints: the run id to restore. */
  runId?: string;
}

function commitEntry(c: GitCommit): TimelineEntry {
  return {
    id: `commit:${c.hash}`,
    kind: "commit",
    title: c.subject || "(no message)",
    subtitle: `${c.author} · ${c.short}`,
    ts: c.timestamp * 1000, // git timestamps are epoch seconds
  };
}

function checkpointEntry(c: CheckpointInfo): TimelineEntry {
  const parsed = Date.parse(c.created_at);
  return {
    id: `checkpoint:${c.run_id}`,
    kind: "checkpoint",
    title: c.label || "Checkpoint",
    subtitle: `${c.files.length} file${c.files.length === 1 ? "" : "s"}`,
    ts: Number.isNaN(parsed) ? 0 : parsed,
    runId: c.run_id,
  };
}

/** Merge commits + checkpoints into a newest-first timeline. */
export function buildTimeline(
  commits: GitCommit[],
  checkpoints: CheckpointInfo[],
): TimelineEntry[] {
  const entries = [...commits.map(commitEntry), ...checkpoints.map(checkpointEntry)];
  entries.sort((a, b) => b.ts - a.ts);
  return entries;
}
