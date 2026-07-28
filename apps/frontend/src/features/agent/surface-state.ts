/**
 * surface-state.ts — the single precedence function for the chat surface's
 * non-ideal states (R19).
 *
 * Precedence is fixed here, so the surface can never show an empty state while
 * disconnected, or an error while history is still loading, and every call site
 * agrees. The state is uniquely determined by the inputs (Property 38).
 */
import type { AgentMode } from "./prepare-agent-run";
import { modeRequiresWorkspace } from "./prepare-agent-run";

export interface SurfaceError {
  operation: string;
  code: string;
  message: string;
  retryable: boolean;
}

export type SurfaceState =
  | { kind: "loading" } // R19.2
  | { kind: "workspace-required"; action: "open-folder" } // R19.3
  | { kind: "disconnected"; target: "Gateway"; action: "reconnect" } // R19.5
  | { kind: "empty"; model: string; mode: AgentMode; examples: readonly string[] } // R19.1
  | { kind: "error"; operation: string; code: string; message: string; retryable: boolean } // R19.4, R19.6
  | { kind: "transcript" };

/** Example prompts by mode, so the empty state always names at least one (R19.1). */
export function examplePrompts(mode: AgentMode): readonly string[] {
  switch (mode) {
    case "ask":
      return ["What does this project do?", "Explain the run pipeline."];
    case "plan":
      return ["Plan a fix for the failing test.", "Outline how to add a settings page."];
    case "agent":
      return ["Add a health-check endpoint.", "Rename getUserName to getUsername everywhere."];
    default:
      return ["Ask a question about this project."];
  }
}

export function surfaceState(input: {
  connected: boolean;
  historyLoading: boolean;
  workspaceRoot: string | null;
  rowCount: number;
  selectedModel: string | null;
  mode: AgentMode;
  lastError: SurfaceError | null;
}): SurfaceState {
  if (input.historyLoading) return { kind: "loading" };
  if (!input.connected) return { kind: "disconnected", target: "Gateway", action: "reconnect" };
  if (input.lastError) {
    return {
      kind: "error",
      operation: input.lastError.operation,
      code: input.lastError.code,
      message: input.lastError.message,
      retryable: input.lastError.retryable,
    };
  }
  if ((input.workspaceRoot ?? "").trim().length === 0 && modeRequiresWorkspace(input.mode)) {
    return { kind: "workspace-required", action: "open-folder" };
  }
  if (input.rowCount === 0) {
    return {
      kind: "empty",
      model: input.selectedModel ?? "No model selected",
      mode: input.mode,
      examples: examplePrompts(input.mode),
    };
  }
  return { kind: "transcript" };
}
