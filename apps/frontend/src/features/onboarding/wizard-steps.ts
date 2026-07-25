/**
 * First-run wizard model (§13.1).
 *
 * The wizard is a linear six-step flow. Keeping the step order, skip rules and
 * hardware-derived copy here — pure, no React — means the navigation contract is
 * testable and the component stays presentational.
 */

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
 * Only the model step can actually block: every other step either has nothing to
 * fill in or offers a documented skip (the workspace step falls back to the home
 * directory). Blocking on a half-configured model is deliberate — continuing
 * without one produces a wizard that "finished" into an unusable app.
 */
export function canAdvance(state: WizardState): boolean {
  switch (state.step) {
    case "model":
      if (state.modelChoice === "local") return state.modelPath.trim().length > 0;
      if (state.modelChoice === "cloud") return state.cloudKey.trim().length > 0;
      return false;
    default:
      return true;
  }
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
