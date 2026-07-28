/**
 * model-availability.ts — pure model-availability projections and the single
 * run-start gate (R3.5, R3.7, R4.3–R4.5, R5.1, R5.3–R5.5).
 *
 * Availability is a pure projection so "the model file is missing" (R3.7) and
 * "this provider needs a key" (R4.4) are checkable without a filesystem or a
 * live provider. `evaluateRunGate` folds the two previously overlapping gates
 * (`validateRunRequest` + the ad-hoc `ensureSelectedModelReady`) into one, with
 * a fixed clause order so the reason shown is always the most actionable one
 * and the Ask carve-out (R1.7) can never be shadowed by a later clause.
 */
import { isAgentMode, modeRequiresWorkspace } from "./prepare-agent-run";
import type { LocalModel } from "@/lib/local-models";
import type { ProviderConfig } from "@/lib/providers";
import type { LlamaCppStatus } from "@/lib/tauri-bridge";

export type ModelAvailability =
  | { kind: "ready"; baseUrl: string }
  | { kind: "starting" }
  | { kind: "stopped" }
  | { kind: "error"; reason: string; logTail: readonly string[] }
  | { kind: "unavailable"; reason: "file-missing"; path: string } // R3.7
  | { kind: "needs-key"; provider: string } // R4.4
  | { kind: "key-invalid"; provider: string }; // R4.5

/** The four supervisor states, derived from a status that may predate them. */
function supervisorState(
  status: LlamaCppStatus,
): "stopped" | "starting" | "ready" | "error" {
  if (status.state) return status.state;
  if (status.last_error) return "error";
  return status.running ? "ready" : "stopped";
}

/**
 * Availability of a registered local model given the supervisor status and a
 * file-existence probe. A missing file wins over any runtime state (R3.7).
 */
export function localModelAvailability(
  model: LocalModel,
  status: LlamaCppStatus | null,
  fileExists: (path: string) => boolean,
): ModelAvailability {
  if (!fileExists(model.path)) {
    return { kind: "unavailable", reason: "file-missing", path: model.path };
  }
  if (!status) return { kind: "stopped" };

  const isThisModel =
    status.loaded_model_id === model.id || status.loaded_model_path === model.path;
  const state = supervisorState(status);

  if (isThisModel && state === "ready" && status.base_url) {
    return { kind: "ready", baseUrl: status.base_url };
  }
  if (isThisModel && state === "starting") return { kind: "starting" };
  if (isThisModel && state === "error") {
    return {
      kind: "error",
      reason: status.last_error ?? "The model failed to start.",
      logTail: status.log_tail ?? [],
    };
  }
  return { kind: "stopped" };
}

/**
 * Availability of a cloud provider given whether its key is present and valid.
 * A provider's models are selectable exactly when a valid key is present.
 */
export function providerAvailability(
  provider: ProviderConfig,
  hasKey: boolean,
  keyInvalid: boolean,
): ModelAvailability {
  if (provider.requiresKey && !hasKey) return { kind: "needs-key", provider: provider.id };
  if (keyInvalid) return { kind: "key-invalid", provider: provider.id };
  return { kind: "ready", baseUrl: provider.baseUrl };
}

/** Whether an availability represents a model that can serve a request now. */
export function isReadyAvailability(
  availability: ModelAvailability | undefined,
): availability is Extract<ModelAvailability, { kind: "ready" }> {
  return availability?.kind === "ready";
}

/* ── The run-start gate ───────────────────────────────────────────────── */

export type RunGateCode =
  | "invalid_request"
  | "no_model_ready"
  | "no_model_selected"
  | "no_workspace"
  | "read_only"
  | "run_active";

export type RunGate =
  | { canStart: true }
  | { canStart: false; code: RunGateCode; message: string };

export interface SelectedModel {
  provider: string;
  model: string;
}

/** The availability-map key for a selected model. Callers build the map with it. */
export function selectionKey(selected: SelectedModel): string {
  return `${selected.provider}::${selected.model}`;
}

/**
 * Availability of the currently selected model for the run gate, derived from
 * the supervisor status alone (no filesystem probe). A local (llamacpp) model is
 * ready only when the supervisor reports that exact model loaded with a base
 * URL; cloud and mock providers are treated as ready here — the request's creds
 * resolution and the Gateway's readiness gate make the final per-provider call.
 */
export function selectedModelAvailability(
  selected: SelectedModel | null,
  llamaStatus: LlamaCppStatus | null,
): ModelAvailability | null {
  if (!selected) return null;
  if (selected.provider !== "llamacpp") {
    return { kind: "ready", baseUrl: "" };
  }
  if (!llamaStatus) return { kind: "stopped" };
  const state = supervisorState(llamaStatus);
  const isThisModel =
    llamaStatus.loaded_model_id === selected.model ||
    llamaStatus.loaded_model_path === selected.model;
  if (isThisModel && state === "ready" && llamaStatus.base_url) {
    return { kind: "ready", baseUrl: llamaStatus.base_url };
  }
  if (isThisModel && state === "starting") return { kind: "starting" };
  if (isThisModel && state === "error") {
    return {
      kind: "error",
      reason: llamaStatus.last_error ?? "The model failed to start.",
      logTail: llamaStatus.log_tail ?? [],
    };
  }
  return { kind: "stopped" };
}

/** The single-entry availability map the run gate consumes for a selection. */
export function selectionAvailabilityMap(
  selected: SelectedModel | null,
  llamaStatus: LlamaCppStatus | null,
): ReadonlyMap<string, ModelAvailability> {
  const map = new Map<string, ModelAvailability>();
  const availability = selectedModelAvailability(selected, llamaStatus);
  if (selected && availability) map.set(selectionKey(selected), availability);
  return map;
}

export interface RunGateInput {
  /** The composer input; empty/whitespace fails clause 1. */
  input: string;
  selected: SelectedModel | null;
  availability: ReadonlyMap<string, ModelAvailability>;
  mode: unknown;
  workspaceRoot: string | null;
  readOnly: boolean;
  activeRunCount: number;
  maxConcurrentRuns: number;
}

/**
 * R1.4/R1.7 — Ask is the one mode that runs without a bound workspace. Re-export
 * of the canonical predicate in `prepare-agent-run.ts`.
 */
export { modeRequiresWorkspace } from "./prepare-agent-run";

/**
 * The single source of truth for whether the run-start control is enabled and,
 * when it is not, the first failing clause in the declared order.
 */
export function evaluateRunGate(input: RunGateInput): RunGate {
  // Clause 1 — unrecognized mode, or empty/whitespace input.
  if (!isAgentMode(input.mode)) {
    return {
      canStart: false,
      code: "invalid_request",
      message: "That chat mode is not available. Pick Ask, Plan, or Agent.",
    };
  }
  if (input.input.trim().length === 0) {
    return {
      canStart: false,
      code: "invalid_request",
      message: "Type a message before sending.",
    };
  }
  const mode = input.mode;

  // Clause 2 — read-only viewer.
  if (input.readOnly) {
    return {
      canStart: false,
      code: "read_only",
      message: "You are viewing this session. Only the host can start a run.",
    };
  }

  // Clause 3 — concurrency ceiling.
  if (input.activeRunCount >= Math.max(1, input.maxConcurrentRuns)) {
    return {
      canStart: false,
      code: "run_active",
      message: "A run is already in progress. Wait for it to finish or stop it first.",
    };
  }

  // Clause 4 — no model selected.
  if (!input.selected) {
    return {
      canStart: false,
      code: "no_model_selected",
      message: "Select a model to run.",
    };
  }

  // Clause 5 — selected model not ready.
  const availability = input.availability.get(selectionKey(input.selected));
  if (!isReadyAvailability(availability)) {
    return {
      canStart: false,
      code: "no_model_ready",
      message: "The selected model is not ready yet.",
    };
  }

  // Clause 6 — no resolved workspace (plan/agent only; skipped for ask).
  if (modeRequiresWorkspace(mode) && (input.workspaceRoot ?? "").trim().length === 0) {
    return {
      canStart: false,
      code: "no_workspace",
      message: `No workspace is open. Open a project folder before using ${
        mode === "plan" ? "Plan" : "Agent"
      } mode.`,
    };
  }

  return { canStart: true };
}
