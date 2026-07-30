/**
 * Rule-source classification, runtime copy — zoc-agent-chat-rebuild R30.1, R30.3.
 *
 * A deliberate copy of `apps/frontend/src/lib/rules-sources.ts`, made under the
 * additive-copy rule in the plan's *Cutover discipline*. The renderer's Rules
 * display and the runtime's prompt assembly must not be able to disagree about
 * which sources apply or in what order, and the only way to guarantee that with a
 * process boundary in between is for both to run the same total order.
 *
 * Why a copy rather than a shared package: the classifier is pure string work
 * over paths, and the two consumers are a React app and a `pkg`-bundled Node
 * binary whose build cannot take a dynamic `require` (R4.3). A new workspace
 * package to hold ninety lines of `sort` comparator would add a build edge to
 * both for no behavioural gain. `rules-sources.contract.test.ts` pins the two
 * implementations to the same ordering, so drift is a failing test rather than a
 * silently different prompt.
 *
 * The ordering is also the *precedence*: later sources are appended after earlier
 * ones, so a nested `AGENTS.md` cannot outrank a root `.zoc/rules` file.
 */

export type RuleKind = "zoc" | "cursor" | "agents" | "other";

export interface RuleSource {
  /** Workspace-relative path to the rule file. */
  readonly path: string;
  readonly kind: RuleKind;
  /** True when the rule lives in a subdirectory, so it applies to a subtree. */
  readonly nested: boolean;
  /** A short human label, e.g. `AGENTS.md` or `.cursor/rules`. */
  readonly label: string;
}

/** `zoc` → `cursor` → `agents` → `other`. Zoc's own convention wins. */
const KIND_ORDER: Readonly<Record<RuleKind, number>> = Object.freeze({
  zoc: 0,
  cursor: 1,
  agents: 2,
  other: 3,
});

/**
 * Which separator a path uses.
 *
 * A path is treated as Windows-style only when it has backslashes and no forward
 * slashes: a mixed path is far more likely a POSIX path containing an escaped
 * character than a genuine Windows path, and guessing the other way would split
 * one segment into two.
 */
function sep(path: string): "/" | "\\" {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

function basename(path: string): string {
  const parts = path.split(sep(path)).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Segments before the marker segment — 0 means the marker sits at the root. */
function depthBeforeMarker(rel: string, marker: string): number {
  const index = rel.toLowerCase().indexOf(marker.toLowerCase());
  if (index < 0) return 0;
  return rel.slice(0, index).split(sep(rel)).filter(Boolean).length;
}

function containsMarker(lower: string, marker: string): boolean {
  return lower.includes(`${marker}/rules`) || lower.includes(`${marker}\\rules`);
}

/** Classify one workspace-relative rule path. */
export function classifyRuleSource(rel: string): RuleSource {
  // Strip a leading "./", "/", or ".\" but *not* the dot of a dotfile like
  // ".zoc" — stripping that would reclassify every Zoc rule as `other`.
  const normalized = rel.replace(/^(?:\.?[/\\])+/, "");
  const lower = normalized.toLowerCase();
  const base = basename(normalized).toLowerCase();

  if (base === "agents.md") {
    const nested = normalized.split(sep(normalized)).filter(Boolean).length > 1;
    return { path: rel, kind: "agents", nested, label: "AGENTS.md" };
  }
  if (containsMarker(lower, ".cursor")) {
    return {
      path: rel,
      kind: "cursor",
      nested: depthBeforeMarker(normalized, ".cursor") > 0,
      label: ".cursor/rules",
    };
  }
  if (containsMarker(lower, ".zoc")) {
    return {
      path: rel,
      kind: "zoc",
      nested: depthBeforeMarker(normalized, ".zoc") > 0,
      label: ".zoc/rules",
    };
  }
  return { path: rel, kind: "other", nested: false, label: basename(normalized) };
}

/**
 * Classify and order a set of rule paths.
 *
 * Order: kind, then root before nested, then path alphabetically. The final tie
 * break is `localeCompare` on the full path, matching the renderer exactly — a
 * plain `<` comparison would order differently for non-ASCII paths and the two
 * sides would silently disagree.
 */
export function classifyRuleSources(paths: readonly string[]): RuleSource[] {
  return paths.map(classifyRuleSource).sort((a, b) => {
    if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (a.nested !== b.nested) return a.nested ? 1 : -1;
    return a.path.localeCompare(b.path);
  });
}
