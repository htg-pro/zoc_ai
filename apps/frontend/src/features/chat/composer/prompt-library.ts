/** Persistent saved-prompt library — zoc-agent-chat-rebuild R28. */
/** Feature: zoc-agent-chat-rebuild, tasks 32.1-32.2 (R28.1, R28.2, R28.3, R28.4, R28.5). */

import { validateMessage } from "@/lib/composer-validate";

export const PROMPT_LIBRARY_STORAGE_KEY = "zoc.prompt-library.v1";
export const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z][A-Za-z0-9_.-]*)\s*\}\}/gu;

export interface SavedPrompt {
  readonly id: string;
  readonly name: string;
  readonly content: string;
  readonly updatedAt: string;
}

export interface PromptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function placeholdersOf(template: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1] as string;
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

export function substitutePrompt(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  const missing = placeholdersOf(template).filter((name) => !(name in values));
  if (missing.length > 0) throw new Error(`Missing prompt placeholder: ${missing.join(", ")}`);
  return template.replace(PLACEHOLDER_PATTERN, (_whole, name: string) => values[name] ?? "");
}

export function normalizePromptLibrary(value: unknown): SavedPrompt[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map<string, SavedPrompt>();
  for (const row of value) {
    if (typeof row !== "object" || row === null) continue;
    const raw = row as Record<string, unknown>;
    if (
      typeof raw.id !== "string" ||
      typeof raw.name !== "string" ||
      typeof raw.content !== "string" ||
      typeof raw.updatedAt !== "string" ||
      raw.id.length === 0 ||
      raw.name.trim().length === 0 ||
      !validateMessage(raw.content).valid
    )
      continue;
    byId.set(raw.id, {
      id: raw.id,
      name: raw.name.trim(),
      content: raw.content,
      updatedAt: raw.updatedAt,
    });
  }
  return [...byId.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function loadPromptLibrary(storage: PromptStorage | null | undefined): SavedPrompt[] {
  if (storage === null || storage === undefined) return [];
  try {
    const raw = storage.getItem(PROMPT_LIBRARY_STORAGE_KEY);
    return raw === null ? [] : normalizePromptLibrary(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function persistPromptLibrary(
  storage: PromptStorage | null | undefined,
  prompts: readonly SavedPrompt[],
): void {
  storage?.setItem(PROMPT_LIBRARY_STORAGE_KEY, JSON.stringify(prompts));
}

export function matchesPromptSearch(prompt: SavedPrompt, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return (
    needle.length === 0 ||
    prompt.name.toLocaleLowerCase().includes(needle) ||
    prompt.content.toLocaleLowerCase().includes(needle)
  );
}
