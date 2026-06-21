import { basename } from "./paths";

export type ComposerSlashCommandName =
  | "explain"
  | "test"
  | "fix"
  | "document"
  | "refactor";

export type ComposerMode = "ask" | "agent";
export type SlashCommandTarget = "selection" | "file";

export interface SlashCommand {
  name: ComposerSlashCommandName;
  mode: ComposerMode;
  target: SlashCommandTarget;
  summary: string;
}

export interface SlashCommandContext {
  activeFile: string | null;
  selectedCode: string | null;
}

export interface ResolvedSlashCommand {
  mode: ComposerMode;
  prompt: string;
  contextFile: { token: string; path: string } | null;
}

const MAX_SELECTION_CHARS = 8_000;

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "explain", mode: "ask", target: "selection", summary: "Explain selected code" },
  { name: "test", mode: "agent", target: "file", summary: "Write tests for current file" },
  { name: "fix", mode: "agent", target: "file", summary: "Fix all lint errors" },
  { name: "document", mode: "agent", target: "file", summary: "Add JSDoc or docstrings" },
  { name: "refactor", mode: "agent", target: "selection", summary: "Refactor for readability" },
];

export function matchSlash(prefix: string): SlashCommand[] {
  const q = prefix.replace(/^\//, "").trim().toLowerCase();
  if (!q) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter(
    (command) =>
      command.name.startsWith(q) || command.summary.toLowerCase().includes(q),
  );
}

export function resolveSlashCommand(
  command: SlashCommand,
  context: SlashCommandContext,
): ResolvedSlashCommand {
  if (command.target === "selection") {
    const selectedCode = boundedSelection(context.selectedCode);
    const action =
      command.name === "explain"
        ? "Explain how the selected code works"
        : "Refactor the selected code for readability";
    return {
      mode: command.mode,
      prompt: selectedCode ? `${action}:\n\n${selectedCode}` : action,
      contextFile: null,
    };
  }

  const path = context.activeFile;
  const token = path ? basename(path) : "";
  const target = token ? `@${token}` : "the current file";
  const action =
    command.name === "test"
      ? `Write tests for ${target}`
      : command.name === "fix"
        ? `Fix all lint errors in ${target}`
        : `Add JSDoc/docstrings to ${target}`;
  return {
    mode: command.mode,
    prompt: action,
    contextFile: path && token ? { token, path } : null,
  };
}

function boundedSelection(selection: string | null): string {
  const text = selection?.trim() ?? "";
  if (text.length <= MAX_SELECTION_CHARS) return text;
  return `${text.slice(0, MAX_SELECTION_CHARS)}\n\n[... selection truncated ...]`;
}
