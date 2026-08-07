/** Rules editor state, validation, and origin-safe persistence — zoc-agent-chat-rebuild R30. */
/** Feature: zoc-agent-chat-rebuild, task 34.1 (R30.1, R30.2, R30.3, R30.4, R30.5). */

import type { RuleDocument } from "@zoc-studio/shared-types";

export const RULE_SELECTION_STORAGE_PREFIX = "zoc.rules.enabled.v1:";

export interface RuleParseError {
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

function locationOf(text: string, index: number): Pick<RuleParseError, "line" | "column"> {
  const before = text.slice(0, Math.max(0, index));
  const lines = before.split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

/** Validate the only structured rule syntax we accept: optional YAML-like frontmatter. */
export function parseRuleContent(content: string): RuleParseError | null {
  const nul = content.indexOf("\u0000");
  if (nul >= 0) {
    return { message: "The source is not UTF-8 text.", ...locationOf(content, nul) };
  }

  const lines = content.split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") return null;
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (close < 0)
    return { message: "Frontmatter is missing its closing --- marker.", line: 1, column: 1 };
  for (let index = 1; index < close; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
    if (/^\s*[A-Za-z0-9_.-]+\s*:/u.test(line)) continue;
    return {
      message: "Frontmatter entries must use key: value syntax.",
      line: index + 1,
      column: line.search(/\S/u) + 1,
    };
  }
  return null;
}

export function displayedRuleError(document: RuleDocument): RuleParseError | null {
  if (typeof document.error === "string" && document.error.length > 0) {
    return { message: document.error, line: 1, column: 1 };
  }
  return typeof document.content === "string" ? parseRuleContent(document.content) : null;
}

export type RuleEnableMap = Readonly<Record<string, boolean>>;

export function enabledFor(path: string, enabled: RuleEnableMap): boolean {
  return enabled[path] !== false;
}

export function completeEnableMap(
  documents: readonly RuleDocument[],
  saved: RuleEnableMap,
): Record<string, boolean> {
  return Object.fromEntries(
    documents.map((document) => [document.path, enabledFor(document.path, saved)]),
  );
}

export function loadRuleEnableMap(workspaceRoot: string | null): Record<string, boolean> {
  if (workspaceRoot === null || typeof localStorage === "undefined") return {};
  try {
    const raw = JSON.parse(
      localStorage.getItem(`${RULE_SELECTION_STORAGE_PREFIX}${workspaceRoot}`) ?? "{}",
    ) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
      ),
    );
  } catch {
    return {};
  }
}

export function persistRuleEnableMap(workspaceRoot: string | null, enabled: RuleEnableMap): void {
  if (workspaceRoot === null || typeof localStorage === "undefined") return;
  localStorage.setItem(`${RULE_SELECTION_STORAGE_PREFIX}${workspaceRoot}`, JSON.stringify(enabled));
}

/** Resolve a workspace-relative source without permitting an edit outside the workspace. */
export function ruleOriginPath(workspaceRoot: string, relativePath: string): string | null {
  const normalized = relativePath.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)) return null;
  const parts = normalized.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) return null;
  return `${workspaceRoot.replace(/[\\/]+$/u, "")}/${parts.join("/")}`;
}

export async function persistRuleEdit(input: {
  readonly workspaceRoot: string;
  readonly path: string;
  readonly content: string;
  readonly write: (path: string, content: string) => Promise<boolean>;
}): Promise<boolean> {
  const origin = ruleOriginPath(input.workspaceRoot, input.path);
  return origin === null ? false : input.write(origin, input.content);
}
