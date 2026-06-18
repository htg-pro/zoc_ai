/**
 * Frontend-local type re-exports. Mirrors what was at `src/types.ts` in the
 * legacy single-package layout — the monorepo home for shared schemas is
 * `@zoc-studio/shared-types`.
 */
export type {
  AgentEvent,
  DiffPatch,
  HealthResponse,
  IndexStatus,
  Message,
  MessageRole,
  Plan,
  PlanStep,
  PlanStepStatus,
  ProviderDescriptor,
  ProviderKind,
  Session,
  SessionStatus,
  SlashCommandName,
  ToolCall,
  ToolCallStatus,
} from "@zoc-studio/shared-types";

export type { ActivityView, AppState, BottomTab, MainView, OpenFile } from "./lib/store";
