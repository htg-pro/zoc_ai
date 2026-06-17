/**
 * Run/Debug/Task target list for the Top Bar run selector
 * (develop.md "Run, Tasks, And Debug UX → Run selector").
 *
 * Merges parsed launch configurations and discovered tasks into one ordered
 * list of runnable targets, and resolves which one is "selected" (the default
 * action of the run button). Pure and dependency-free for unit testing; the
 * component supplies the live data and performs the actual run.
 */
import type { LaunchConfig } from "./launch-configs";
import type { Task } from "./tasks";

export type RunTargetKind = "debug" | "task";

export interface RunTarget {
  id: string;
  kind: RunTargetKind;
  label: string;
  /** Secondary label: debug adapter family or task group/source. */
  detail: string;
}

const TASK_GROUP_ORDER: Record<string, number> = { build: 0, test: 1, none: 2 };

/** Build the ordered target list: debug configs first, then tasks
 *  (build → test → other), each alphabetically stable within its bucket. */
export function buildRunTargets(configs: LaunchConfig[], tasks: Task[]): RunTarget[] {
  const debug: RunTarget[] = configs.map((c) => ({
    id: `debug:${c.name}`,
    kind: "debug",
    label: c.name,
    detail: c.kind,
  }));
  const taskTargets: RunTarget[] = [...tasks]
    .sort((a, b) => {
      const ga = TASK_GROUP_ORDER[a.group] ?? 3;
      const gb = TASK_GROUP_ORDER[b.group] ?? 3;
      if (ga !== gb) return ga - gb;
      return a.label.localeCompare(b.label);
    })
    .map((t) => ({ id: t.id, kind: "task", label: t.label, detail: t.source }));
  return [...debug, ...taskTargets];
}

/** Resolve the active target: the explicit selection if still present,
 *  otherwise the first target (debug config or, failing that, first task). */
export function defaultRunTarget(
  targets: RunTarget[],
  selectedId: string | null,
): RunTarget | null {
  if (selectedId) {
    const found = targets.find((t) => t.id === selectedId);
    if (found) return found;
  }
  return targets[0] ?? null;
}

/** Split an id like "debug:Launch Program" → kind + name. */
export function parseTargetId(id: string): { kind: RunTargetKind; name: string } {
  if (id.startsWith("debug:")) return { kind: "debug", name: id.slice("debug:".length) };
  return { kind: "task", name: id };
}
