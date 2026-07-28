// Feature: zoc-ai-agent-chat-overhaul, Task 14: ModelPicker probes files + guides key setup + names invalid providers
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const providersList = vi.hoisted(() => [
  {
    id: "openai",
    name: "OpenAI",
    requiresKey: true,
    baseUrl: "",
    models: [{ id: "gpt-4o", name: "GPT-4o", contextWindow: 128000, tools: true, vision: true }],
  },
]);

vi.mock("../ModelBenchmarkDialog", () => ({ ModelBenchmarkDialog: () => null }));
vi.mock("@/lib/providers", () => ({
  getProvidersSnapshot: () => providersList,
  subscribeProviders: () => () => undefined,
}));

import * as secure from "@/lib/secure-store";
import * as bridge from "@/lib/tauri-bridge";
import { saveLocalModels } from "@/lib/local-models";
import { useApp } from "@/lib/store";
import { ModelPicker } from "../ModelPicker";

function openMenu() {
  fireEvent.pointerDown(screen.getByRole("button", { name: "Choose model" }), { button: 0 });
}

afterEach(() => {
  cleanup();
  saveLocalModels([]);
  vi.restoreAllMocks();
  useApp.setState({
    selectedModel: { provider: "llamacpp", model: "" },
    llamaCppStatus: null,
    invalidProviders: {},
    mainView: "editor",
    settingsSection: null,
  });
});

describe("ModelPicker production wiring (Task 9/4)", () => {
  it("probes the GGUF path and disables + flags a model whose file is missing (R3.7)", async () => {
    saveLocalModels([{ id: "local:gone", name: "Gone Model", path: "/models/gone.gguf" }]);
    vi.spyOn(bridge, "fsStat").mockResolvedValue({ exists: false } as never);
    render(<ModelPicker />);
    openMenu();
    expect(await screen.findByText(/file missing/i)).toBeTruthy();
  });

  it("offers an interactive action opening Settings → Providers when a key is missing (R4.4)", async () => {
    vi.spyOn(secure.secureStore, "get").mockResolvedValue(null);
    render(<ModelPicker />);
    openMenu();
    const action = await screen.findByText(/Add OpenAI API key in Settings/i);
    fireEvent.click(action);
    expect(useApp.getState().mainView).toBe("settings");
    expect(useApp.getState().settingsSection).toBe("providers");
  });

  it("names a provider whose key the provider rejected as invalid (R4.5)", async () => {
    vi.spyOn(secure.secureStore, "get").mockResolvedValue("sk-present");
    useApp.setState({ invalidProviders: { openai: true } });
    render(<ModelPicker />);
    openMenu();
    expect(await screen.findByText(/key invalid/i)).toBeTruthy();
    expect(screen.getByText(/OpenAI rejected the key/i)).toBeTruthy();
  });

  it("clears only the provider whose API key changed (R4.5)", async () => {
    vi.spyOn(secure.secureStore, "get").mockResolvedValue("sk-present");
    useApp.setState({ invalidProviders: { openai: true, anthropic: true } });
    render(<ModelPicker />);

    await act(async () => {
      await secure.secureStore.set("provider.openai.api_key", "sk-reentered");
    });

    await vi.waitFor(() => {
      expect(useApp.getState().invalidProviders.openai).toBeUndefined();
    });
    expect(useApp.getState().invalidProviders.anthropic).toBe(true);
  });
});
