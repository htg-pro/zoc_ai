import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/tauri-bridge", async () => {
  const cfg = {
    workspace_root: null as string | null,
    first_run_done: false,
    telemetry_opt_in: false,
    legacy_imported: false,
  };
  return {
    isTauri: () => false,
    desktopConfigGet: vi.fn(async () => cfg),
    desktopConfigSet: vi.fn(async (next: typeof cfg) => Object.assign(cfg, next)),
    setWorkspaceRoot: vi.fn(async () => true),
    legacyDetect: vi.fn(async () => ({ present: false, path: null, session_count: 0 })),
    legacyImport: vi.fn(async () => ({ imported_sessions: 0, imported_settings: false })),
    pickDirectory: vi.fn(async () => null),
    pickGgufFile: vi.fn(async () => null),
    telemetryLog: vi.fn(async () => undefined),
    telemetryEvent: vi.fn(async () => undefined),
    onFsChanged: vi.fn(async () => () => undefined),
    onAgentStatus: vi.fn(async () => () => undefined),
  };
});

// The hardware step calls the sidecar; serve a deterministic profile so the
// recommendation copy is assertable.
vi.mock("@/lib/agent-client", () => ({
  getAgentClient: vi.fn(async () => ({
    hardware: vi.fn(async () => ({
      detected: true,
      gpu_memory_gb: 8,
      system_memory_gb: 16,
      recommendation: {
        model: "Qwen2.5-Coder-7B-Instruct",
        quantization: "Q4_K_M",
        approx_size_gb: 4.7,
        gpu_layers: 999,
        reason: "6 GB+ of VRAM fits a 7B coder model fully on the GPU.",
      },
    })),
    discoverModels: vi.fn(async () => []),
  })),
}));

import { OnboardingWizard } from "@/features/onboarding/OnboardingWizard";
import { FIRST_TASK_PROMPT } from "@/features/onboarding/wizard-steps";
import { loadLocalModels } from "@/lib/local-models";
import { useApp } from "@/lib/store";
import * as bridge from "@/lib/tauri-bridge";

const clickButton = (pattern: RegExp) =>
  fireEvent.click(screen.getByRole("button", { name: pattern }));

describe("OnboardingWizard", () => {
  it("walks the six steps, persists config and pre-fills the first task", async () => {
    const onComplete = vi.fn();
    render(<OnboardingWizard onComplete={onComplete} />);

    // 1 — welcome
    fireEvent.click(await screen.findByRole("button", { name: /get started/i }));

    // 2 — workspace
    const path = await screen.findByLabelText(/workspace path/i);
    fireEvent.change(path, { target: { value: "/tmp/proj" } });
    clickButton(/continue/i);

    // 3 — model: continuing must be blocked until a model is configured.
    await screen.findByRole("heading", { name: /choose a model/i });
    expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
    clickButton(/local model/i);
    fireEvent.change(screen.getByLabelText(/path to a .gguf model/i), {
      target: { value: "/models/qwen.gguf" },
    });
    expect(screen.getByRole("button", { name: /continue/i })).not.toBeDisabled();
    clickButton(/continue/i);

    // Committing the model step registers the chosen .gguf in the model
    // registry, so it appears in the picker and onboarding yields a usable
    // model (defect #2). Loading it happens later when the user selects it.
    await waitFor(() =>
      expect(loadLocalModels().some((m) => m.path === "/models/qwen.gguf")).toBe(true),
    );

    // 4 — hardware check, populated from the sidecar probe.
    await screen.findByRole("heading", { name: /hardware check/i });
    await waitFor(() =>
      expect(screen.getByTestId("hardware-summary").textContent).toContain("8.0 GB VRAM"),
    );
    expect(screen.getByText(/Qwen2\.5-Coder-7B-Instruct \(Q4_K_M\)/)).toBeInTheDocument();
    clickButton(/continue/i);

    // 5 — telemetry consent
    await screen.findByRole("heading", { name: /help improve zoc/i });
    clickButton(/finish/i);

    // 6 — ready
    await screen.findByRole("heading", { name: /zoc is ready/i });
    expect(screen.getByText(FIRST_TASK_PROMPT)).toBeInTheDocument();

    await waitFor(() => expect(bridge.desktopConfigSet).toHaveBeenCalled());
    // The workspace step now commits (persists) the workspace, and finish
    // records first-run completion while preserving the bound root. Assert on
    // the final persisted config rather than the first call.
    const calls = (
      bridge.desktopConfigSet as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls;
    const cfg = calls[calls.length - 1][0] as {
      workspace_root: string | null;
      first_run_done: boolean;
      telemetry_opt_in: boolean;
    };
    expect(cfg.workspace_root).toBe("/tmp/proj");
    expect(cfg.first_run_done).toBe(true);
    // Telemetry stays off unless the user turns it on.
    expect(cfg.telemetry_opt_in).toBe(false);
    // The workspace step mirrored the root into the store (the explorer + git
    // watch it), so the app is bound to the chosen folder after onboarding.
    expect(useApp.getState().workspaceRoot).toBe("/tmp/proj");

    clickButton(/start exploring/i);
    expect(onComplete).toHaveBeenCalled();
    expect(useApp.getState().input).toBe(FIRST_TASK_PROMPT);
  });
});
