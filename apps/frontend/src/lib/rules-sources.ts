/**
 * Rule-source classification (develop.md Phase 11).
 *
 * The agent's project rules can come from several conventions: Zoc's own
 * `.zoc/rules`, Cursor's `.cursor/rules` (compatibility), and `AGENTS.md`
 * files. Rules can also be *nested* — placed in a subdirectory so they apply to
 * that part of the tree. This pure module turns a list of discovered rule file
 * paths into a structured, displayable model so the Rules UI can show exactly
 * what will be active before a run starts. The backend remains the source of
 * truth for the merged rule text; this just classifies the sources.
 */

export type RuleKind = "zoc" | "cursor" | "agents" | "other";

export interface RuleSource {
  /** Workspace-relative path to the rule file. */
  path: string;
  kind: RuleKind;
  /** True when the rule lives in a subdirectory (applies to a subtree). */
  nested: boolean;
  /** A short human label, e.g. "AGENTS.md" or ".cursor/rules". */
  label: string;
}

function sep(p: string): "/" | "\\" {
  return p.includes("\\") && !p.includes("/") ? "\\" : "/";
}

function basename(p: string): string {
  const s = sep(p);
  const parts = p.split(s).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function depthBeforeMarker(rel: string, marker: string): number {
  // Count path segments before the marker segment.
  const s = sep(rel);
  const idx = rel.toLowerCase().indexOf(marker.toLowerCase());
  if (idx < 0) return 0;
  return rel.slice(0, idx).split(s).filter(Boolean).length;
}

/** Classify a single workspace-relative rule path. */
export function classifyRuleSource(rel: string): RuleSource {
  // Strip a leading "./", "/", or ".\" but NOT the dot of a dotfile like ".zoc".
  const normalized = rel.replace(/^(?:\.?[/\\])+/, "");
  const base = basename(normalized).toLowerCase();

  if (base === "agents.md") {
    const s = sep(normalized);
    const nested = normalized.split(s).filter(Boolean).length > 1;
    return { path: rel, kind: "agents", nested, label: "AGENTS.md" };
  }
  if (normalized.toLowerCase().includes(".cursor/rules") || normalized.toLowerCase().includes(".cursor\\rules")) {
    return {
      path: rel,
      kind: "cursor",
      nested: depthBeforeMarker(normalized, ".cursor") > 0,
      label: ".cursor/rules",
    };
  }
  if (normalized.toLowerCase().includes(".zoc/rules") || normalized.toLowerCase().includes(".zoc\\rules")) {
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
 * Classify and order a set of rule paths. Order: zoc → cursor → agents → other,
 * root rules before nested ones, then alphabetical — the order they're most
 * usefully shown (and roughly the order of precedence).
 */
export function classifyRuleSources(paths: string[]): RuleSource[] {
  const KIND_ORDER: Record<RuleKind, number> = { zoc: 0, cursor: 1, agents: 2, other: 3 };
  return paths
    .map(classifyRuleSource)
    .sort((a, b) => {
      if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
      if (a.nested !== b.nested) return a.nested ? 1 : -1;
      return a.path.localeCompare(b.path);
    });
}

/** A one-line summary for the Rules badge/tooltip. */
export function summarizeRuleSources(sources: RuleSource[]): string {
  if (sources.length === 0) return "No project rules";
  const nested = sources.filter((s) => s.nested).length;
  const base = `${sources.length} rule source${sources.length === 1 ? "" : "s"}`;
  return nested > 0 ? `${base} (${nested} nested)` : base;
}
