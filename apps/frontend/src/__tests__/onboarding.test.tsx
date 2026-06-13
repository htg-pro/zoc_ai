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
    telemetryLog: vi.fn(async () => undefined),
    onFsChanged: vi.fn(async () => () => undefined),
    onAgentStatus: vi.fn(async () => () => undefined),
  };
});

import { OnboardingWizard } from "@/features/onboarding/OnboardingWizard";
import * as bridge from "@/lib/tauri-bridge";

describe("OnboardingWizard", () => {
  it("walks through all 4 steps and persists the final config", async () => {
    const onComplete = vi.fn();
    render(<OnboardingWizard onComplete={onComplete} />);

    fireEvent.click(await screen.findByRole("button", { name: /get started/i }));
    const path = await screen.findByLabelText(/workspace path/i);
    fireEvent.change(path, { target: { value: "/tmp/proj" } });

    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    await screen.findByRole("heading", { name: /import from legacy/i });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await screen.findByRole("button", { name: /finish/i });
    fireEvent.click(screen.getByRole("button", { name: /finish/i }));

    await waitFor(() => expect(bridge.desktopConfigSet).toHaveBeenCalled());
    const cfg = (bridge.desktopConfigSet as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
      workspace_root: string | null;
      first_run_done: boolean;
    };
    expect(cfg.workspace_root).toBe("/tmp/proj");
    expect(cfg.first_run_done).toBe(true);
  });
});
