import type { SlashCommandName } from "@llama-studio/shared-types";

/**
 * Local command list shown by `SlashAutocomplete`. `name` is the shared
 * backend slash union.
 */
export interface SlashCommand {
  name: SlashCommandName;
  summary: string;
  hint: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "review", summary: "Review staged changes", hint: "/review [path]" },
  { name: "test", summary: "Generate or run tests", hint: "/test <target>" },
  { name: "explain", summary: "Explain code in plain English", hint: "/explain <selection>" },
  { name: "fix", summary: "Diagnose and fix a failing test or error", hint: "/fix" },
  { name: "refactor", summary: "Refactor selection with a goal", hint: "/refactor <goal>" },
  { name: "docs", summary: "Write or update docstrings", hint: "/docs <path>" },
  { name: "grok", summary: "Grok an unfamiliar codebase area", hint: "/grok <topic>" },
];

export function matchSlash(prefix: string): SlashCommand[] {
  const q = prefix.replace(/^\//, "").toLowerCase();
  if (!q) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter(
    (c) => c.name.startsWith(q) || c.summary.toLowerCase().includes(q),
  );
}
