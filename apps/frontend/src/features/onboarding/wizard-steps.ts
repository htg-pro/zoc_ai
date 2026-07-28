/**
 * First-run wizard model (§13.1).
 *
 * The wizard is a linear six-step flow. Keeping the step order, skip rules and
 * hardware-derived copy here — pure, no React — means the navigation contract is
 * testable and the component stays presentational.
 */
import {
  type LocalModel,
  deriveNameFromPath,
  makeModelId,
} from "@/lib/local-models";

export const WIZARD_STEPS = [
  "welcome",
  "workspace",
  "model",
  "hardware",
  "telemetry",
  "ready",
] as const;

export type WizardStep = (typeof WIZARD_STEPS)[number];

/** The task pre-filled into the Composer on the final step. */
export const FIRST_TASK_PROMPT = "Explain the main entry point of this project.";

export type ModelChoice = "local" | "cloud" | null;

/** Popular local models offered as download links on the model step. */
export const MODEL_DOWNLOADS: ReadonlyArray<{
  name: string;
  detail: string;
  url: string;
}> = [
  {
    name: "Qwen2.5-Coder-7B-Instruct",
    detail: "Best all-round local coder (~4.7 GB, Q4_K_M)",
    url: "https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF",
  },
  {
    name: "Llama-3.1-8B-Instruct",
    detail: "Strong general model (~4.9 GB, Q4_K_M)",
    url: "https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF",
  },
  {
    name: "Qwen2.5-Coder-1.5B-Instruct",
    detail: "Runs on modest hardware (~1.1 GB, Q4_K_M)",
    url: "https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF",
  },
];

export interface WizardState {
  step: WizardStep;
  workspace: string;
  modelChoice: ModelChoice;
  /** Absolute path of a chosen `.gguf`, when the local option is selected. */
  modelPath: string;
  /** Provider id for the cloud option. */
  cloudProvider: "openai" | "anthropic";
  cloudKey: string;
  telemetry: boolean;
}

/** Zero value for a fresh wizard. */
export const INITIAL_WIZARD_STATE: WizardState = {
  step: "welcome",
  workspace: "",
  modelChoice: null,
  modelPath: "",
  cloudProvider: "openai",
  cloudKey: "",
  telemetry: false,
};

export function stepIndex(step: WizardStep): number {
  return WIZARD_STEPS.indexOf(step);
}

export function nextStep(step: WizardStep): WizardStep {
  const index = stepIndex(step);
  return WIZARD_STEPS[Math.min(index + 1, WIZARD_STEPS.length - 1)];
}

export function previousStep(step: WizardStep): WizardStep {
  const index = stepIndex(step);
  return WIZARD_STEPS[Math.max(index - 1, 0)];
}

/**
 * Whether the user may advance from `step`.
 *
 * The model step blocks until a model is configured, and — once a workspace has
 * been committed and the sidecar is coming back up — every step blocks until the
 * sidecar reports ready (R2.4). An `idle`/`ready` sidecar never blocks.
 */
export function canAdvance(state: WizardState, sidecar: SidecarWait = { kind: "idle" }): boolean {
  // Readiness clause (R2.4): a restarting/failed sidecar gates the next continue.
  if (sidecar.kind === "waiting" || sidecar.kind === "failed") return false;
  switch (state.step) {
    case "model":
      if (state.modelChoice === "local") return state.modelPath.trim().length > 0;
      if (state.modelChoice === "cloud") return state.cloudKey.trim().length > 0;
      return false;
    default:
      return true;
  }
}

/* ── Commit reducers (R2.1–R2.3, R3.1, R4.1) ──────────────────────────────
 *
 * Leaving a step produces an ordered list of effects the component runs in
 * sequence. `advance` is always last: the step never changes before its commit
 * has been issued.
 */

export type CommitEffect =
  | { kind: "persist-workspace"; root: string }
  | { kind: "mirror-workspace"; root: string }
  | { kind: "reload-explorer"; root: string }
  | { kind: "register-local-model"; model: LocalModel }
  | { kind: "store-provider-key"; provider: string }
  | { kind: "fetch-runtime" }
  | { kind: "advance"; to: WizardStep };

/** Canonicalize a workspace path: trim whitespace and trailing separators. */
export function canonicalizeWorkspace(path: string): string {
  const trimmed = path.trim();
  return trimmed.replace(/[/\\]+$/, "") || trimmed;
}

/**
 * Effects for leaving the workspace step, in required order (R2.1–R2.3). When a
 * path is chosen: persist → mirror (identical canonical path) → reload explorer
 * → advance. Skipping (empty path) advances with no workspace bound.
 */
export function commitWorkspaceStep(state: WizardState): CommitEffect[] {
  const root = canonicalizeWorkspace(state.workspace);
  const advance: CommitEffect = { kind: "advance", to: nextStep(state.step) };
  if (root.length === 0) return [advance];
  return [
    { kind: "persist-workspace", root },
    { kind: "mirror-workspace", root },
    { kind: "reload-explorer", root },
    advance,
  ];
}

/**
 * Effects for leaving the model step (R3.1, R4.1). A local choice writes the
 * `LocalModel` record; a cloud choice stores the provider key. Both re-fetch the
 * runtime, then advance.
 */
export function commitModelStep(state: WizardState): CommitEffect[] {
  const advance: CommitEffect = { kind: "advance", to: nextStep(state.step) };
  if (state.modelChoice === "local" && state.modelPath.trim().length > 0) {
    const path = state.modelPath.trim();
    const model: LocalModel = {
      id: makeModelId(path),
      name: deriveNameFromPath(path),
      path,
    };
    return [{ kind: "register-local-model", model }, { kind: "fetch-runtime" }, advance];
  }
  if (state.modelChoice === "cloud" && state.cloudKey.trim().length > 0) {
    return [
      { kind: "store-provider-key", provider: state.cloudProvider },
      { kind: "fetch-runtime" },
      advance,
    ];
  }
  return [advance];
}

/* ── Sidecar readiness (R2.4, R2.6, R2.7) ─────────────────────────────────
 *
 * After the workspace is committed the Desktop_Shell restarts the Gateway
 * sidecar. The wizard waits for it to report ready before enabling the next
 * step's continue control. The clock is an input, so the 30 s deadline is
 * testable without a wall clock.
 */

export type SidecarPhase = "starting" | "restarting" | "ready" | "error";

export type SidecarWait =
  | { kind: "idle" }
  | { kind: "waiting"; reason: string; sinceMs: number } // R2.7
  | { kind: "ready" } // R2.4, R2.5
  | { kind: "failed"; reason: string; retryable: true }; // R2.6

/** Default readiness deadline: 30 seconds (R2.6). */
export const SIDECAR_READINESS_DEADLINE_MS = 30_000;

export type SidecarEvent =
  | { kind: "phase"; phase: SidecarPhase; detail?: string; nowMs: number }
  | { kind: "tick"; nowMs: number };

function waitReason(phase: SidecarPhase, detail?: string): string {
  if (detail && detail.trim().length > 0) return detail.trim();
  return phase === "restarting"
    ? "Restarting the agent for the new workspace…"
    : "Starting the agent…";
}

export function reduceSidecarWait(
  current: SidecarWait,
  event: SidecarEvent,
  deadlineMs = SIDECAR_READINESS_DEADLINE_MS,
): SidecarWait {
  if (event.kind === "phase") {
    switch (event.phase) {
      case "ready":
        return { kind: "ready" };
      case "error":
        return {
          kind: "failed",
          reason: event.detail?.trim() || "The agent failed to start.",
          retryable: true,
        };
      case "starting":
      case "restarting": {
        // Keep the original start time so the deadline measures the whole wait.
        const sinceMs = current.kind === "waiting" ? current.sinceMs : event.nowMs;
        return { kind: "waiting", reason: waitReason(event.phase, event.detail), sinceMs };
      }
      default:
        return current;
    }
  }

  // tick — only a waiting state can time out.
  if (current.kind === "waiting" && event.nowMs - current.sinceMs >= deadlineMs) {
    return { kind: "failed", reason: current.reason, retryable: true };
  }
  return current;
}

export interface HardwareInfo {
  detected: boolean;
  gpu_memory_gb: number | null;
  system_memory_gb: number | null;
  recommendation: {
    model: string;
    quantization: string;
    approx_size_gb: number;
    gpu_layers: number;
    reason: string;
  };
}

/** "Your GPU: 12.0 GB VRAM" style line, honest when nothing was detected. */
export function describeHardware(info: HardwareInfo | null): string {
  if (!info || !info.detected) return "Couldn't detect your GPU or memory.";
  const parts: string[] = [];
  parts.push(
    info.gpu_memory_gb
      ? `GPU: ${info.gpu_memory_gb.toFixed(1)} GB VRAM`
      : "GPU: none detected",
  );
  if (info.system_memory_gb) {
    parts.push(`RAM: ${info.system_memory_gb.toFixed(1)} GB`);
  }
  return parts.join(" · ");
}

/** "Qwen2.5-Coder-7B-Instruct (Q4_K_M)" for the recommendation line. */
export function describeRecommendation(info: HardwareInfo | null): string {
  if (!info) return "";
  const { model, quantization } = info.recommendation;
  return `${model} (${quantization})`;
}
