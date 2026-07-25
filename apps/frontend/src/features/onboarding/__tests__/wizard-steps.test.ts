import { describe, expect, it } from "vitest";
import {
  FIRST_TASK_PROMPT,
  INITIAL_WIZARD_STATE,
  MODEL_DOWNLOADS,
  WIZARD_STEPS,
  canAdvance,
  describeHardware,
  describeRecommendation,
  nextStep,
  previousStep,
  stepIndex,
  type HardwareInfo,
  type WizardState,
} from "../wizard-steps";

const state = (over: Partial<WizardState> = {}): WizardState => ({
  ...INITIAL_WIZARD_STATE,
  ...over,
});

const hardware = (over: Partial<HardwareInfo> = {}): HardwareInfo => ({
  detected: true,
  gpu_memory_gb: 12,
  system_memory_gb: 32,
  recommendation: {
    model: "Qwen2.5-Coder-14B-Instruct",
    quantization: "Q4_K_M",
    approx_size_gb: 9,
    gpu_layers: 999,
    reason: "plenty of VRAM",
  },
  ...over,
});

describe("wizard steps", () => {
  it("has the six documented steps in order", () => {
    expect([...WIZARD_STEPS]).toEqual([
      "welcome",
      "workspace",
      "model",
      "hardware",
      "telemetry",
      "ready",
    ]);
  });

  it("advances and retreats without running off either end", () => {
    expect(nextStep("welcome")).toBe("workspace");
    expect(nextStep("ready")).toBe("ready");
    expect(previousStep("workspace")).toBe("welcome");
    expect(previousStep("welcome")).toBe("welcome");
  });

  it("reports a monotonic step index", () => {
    const indexes = WIZARD_STEPS.map(stepIndex);
    expect(indexes).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("starts with nothing selected", () => {
    expect(INITIAL_WIZARD_STATE.step).toBe("welcome");
    expect(INITIAL_WIZARD_STATE.modelChoice).toBeNull();
  });
});

describe("canAdvance", () => {
  it("blocks the model step until a model is actually configured", () => {
    expect(canAdvance(state({ step: "model" }))).toBe(false);
    expect(canAdvance(state({ step: "model", modelChoice: "local" }))).toBe(false);
    expect(
      canAdvance(state({ step: "model", modelChoice: "local", modelPath: "/m.gguf" })),
    ).toBe(true);
    expect(canAdvance(state({ step: "model", modelChoice: "cloud" }))).toBe(false);
    expect(
      canAdvance(state({ step: "model", modelChoice: "cloud", cloudKey: "sk-x" })),
    ).toBe(true);
  });

  it("treats whitespace-only input as unset", () => {
    expect(
      canAdvance(state({ step: "model", modelChoice: "local", modelPath: "   " })),
    ).toBe(false);
    expect(
      canAdvance(state({ step: "model", modelChoice: "cloud", cloudKey: "  " })),
    ).toBe(false);
  });

  it("never blocks the other steps", () => {
    for (const step of WIZARD_STEPS) {
      if (step === "model") continue;
      expect(canAdvance(state({ step })), step).toBe(true);
    }
  });
});

describe("describeHardware", () => {
  it("summarises GPU and RAM", () => {
    expect(describeHardware(hardware())).toBe("GPU: 12.0 GB VRAM · RAM: 32.0 GB");
  });

  it("says so when there is no GPU", () => {
    expect(describeHardware(hardware({ gpu_memory_gb: null }))).toContain(
      "none detected",
    );
  });

  it("is honest when nothing was detected", () => {
    expect(describeHardware(null)).toMatch(/couldn't detect/i);
    expect(describeHardware(hardware({ detected: false }))).toMatch(/couldn't detect/i);
  });
});

describe("describeRecommendation", () => {
  it("names the model and quantisation", () => {
    expect(describeRecommendation(hardware())).toBe(
      "Qwen2.5-Coder-14B-Instruct (Q4_K_M)",
    );
  });

  it("is empty without hardware info", () => {
    expect(describeRecommendation(null)).toBe("");
  });
});

describe("constants", () => {
  it("offers the documented download links", () => {
    expect(MODEL_DOWNLOADS.length).toBeGreaterThanOrEqual(2);
    const names = MODEL_DOWNLOADS.map((m) => m.name).join(" ");
    expect(names).toContain("Qwen2.5-Coder-7B");
    expect(names).toContain("Llama-3.1-8B");
    for (const entry of MODEL_DOWNLOADS) {
      expect(entry.url.startsWith("https://")).toBe(true);
    }
  });

  it("pre-fills the documented first task", () => {
    expect(FIRST_TASK_PROMPT).toBe("Explain the main entry point of this project.");
  });
});
