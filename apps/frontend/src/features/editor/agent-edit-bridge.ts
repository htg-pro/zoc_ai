import type { SearchReplaceEdit } from "./AgentEditAnimator";

export interface AgentReviewEdit {
  path: string;
  diff: string;
  adds: number;
  dels: number;
}

export interface AgentEditApplication extends AgentReviewEdit {
  runId: string;
  edits: SearchReplaceEdit[];
}

export type AgentEditTarget = (
  application: AgentEditApplication,
) => void | Promise<void>;

const staged = new Map<string, AgentReviewEdit[]>();
const targets = new Map<number, { path: string; apply: AgentEditTarget }>();
let nextTargetId = 1;

/** Stage only the review files the user selected; no editor changes happen yet. */
export function stageAgentEditBatch(runId: string, files: readonly AgentReviewEdit[]): void {
  staged.set(
    runId,
    files.map((file) => ({ ...file })),
  );
}

/** Drop a staged batch when review is discarded, rejected, or fails. */
export function cancelAgentEditBatch(runId: string): void {
  staged.delete(runId);
}

/**
 * Release a staged batch after the gateway emits its post-commit summary.
 * Only a currently mounted matching editor receives each file; unopened files
 * will load their already-updated content from disk normally when opened.
 */
export function commitAgentEditBatch(runId: string): number {
  const files = staged.get(runId);
  if (!files) return 0;
  staged.delete(runId);

  let dispatched = 0;
  for (const file of files) {
    const edits = searchReplaceEditsFromUnifiedDiff(file.diff);
    if (edits.length === 0) continue;
    const target = [...targets.values()].find((candidate) =>
      sameWorkspacePath(candidate.path, file.path),
    );
    if (!target) continue;
    dispatched += 1;
    void Promise.resolve(target.apply({ ...file, runId, edits })).catch((error: unknown) => {
      console.warn("Failed to animate an applied agent edit.", error);
    });
  }
  return dispatched;
}

/** Register one mounted Monaco target. The first path match owns a dispatch. */
export function registerAgentEditTarget(path: string, apply: AgentEditTarget): () => void {
  const id = nextTargetId++;
  targets.set(id, { path, apply });
  return () => {
    targets.delete(id);
  };
}

/** Convert standard unified-diff hunks into ordered SearchReplace operations. */
export function searchReplaceEditsFromUnifiedDiff(diff: string): SearchReplaceEdit[] {
  const lines = diff.split("\n");
  const edits: SearchReplaceEdit[] = [];

  for (let index = 0; index < lines.length; index++) {
    const header = lines[index];
    if (!header.startsWith("@@")) continue;
    const match = header.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (!match) continue;
    const oldStart = Number.parseInt(match[1], 10);
    const oldParts: string[] = [];
    const newParts: string[] = [];
    let previous: "old" | "new" | "both" | null = null;

    index += 1;
    while (index < lines.length && !lines[index].startsWith("@@")) {
      const raw = lines[index];
      if (raw === "" && index === lines.length - 1) break;
      if (raw === "\\ No newline at end of file") {
        if (previous === "old" || previous === "both") stripFinalNewline(oldParts);
        if (previous === "new" || previous === "both") stripFinalNewline(newParts);
        index += 1;
        continue;
      }
      if (raw.startsWith("-")) {
        oldParts.push(`${raw.slice(1)}\n`);
        previous = "old";
      } else if (raw.startsWith("+")) {
        newParts.push(`${raw.slice(1)}\n`);
        previous = "new";
      } else if (raw.startsWith(" ")) {
        const text = `${raw.slice(1)}\n`;
        oldParts.push(text);
        newParts.push(text);
        previous = "both";
      } else {
        // Ignore file metadata between hunks rather than treating it as code.
        previous = null;
      }
      index += 1;
    }
    index -= 1;

    const search = oldParts.join("");
    const replace = newParts.join("");
    if (search === replace) continue;
    edits.push({
      search,
      replace,
      ...(search.length === 0 ? { startLineNumber: Math.max(1, oldStart) } : {}),
    });
  }

  return edits;
}

/** Test-only reset for module-level staging/registration state. */
export function resetAgentEditBridgeForTests(): void {
  staged.clear();
  targets.clear();
  nextTargetId = 1;
}

function stripFinalNewline(parts: string[]): void {
  const last = parts.length - 1;
  if (last >= 0 && parts[last].endsWith("\n")) parts[last] = parts[last].slice(0, -1);
}

function normalizePath(path: string): string {
  return path.trim().replace(/^file:\/\//, "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function sameWorkspacePath(openPath: string, eventPath: string): boolean {
  let open = normalizePath(openPath);
  let event = normalizePath(eventPath);
  if (/^[A-Za-z]:\//.test(open) || /^[A-Za-z]:\//.test(event)) {
    open = open.toLocaleLowerCase("en-US");
    event = event.toLocaleLowerCase("en-US");
  }
  return open === event || open.endsWith(`/${event}`) || event.endsWith(`/${open}`);
}
