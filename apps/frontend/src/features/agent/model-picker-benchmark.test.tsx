import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const emptyProviders = vi.hoisted(() => []);

vi.mock("./ModelBenchmarkDialog", () => ({
  ModelBenchmarkDialog: ({ open, model }: { open: boolean; model: { name: string } | null }) =>
    open ? <div data-testid="benchmark-dialog-stub">{model?.name}</div> : null,
}));

vi.mock("@/lib/providers", () => ({
  getProvidersSnapshot: () => emptyProviders,
  subscribeProviders: () => () => undefined,
}));

import { saveLocalModels } from "@/lib/local-models";
import { useApp } from "@/lib/store";
import { ModelPicker } from "./ModelPicker";

afterEach(() => {
  cleanup();
  saveLocalModels([]);
  useApp.setState({
    selectedModel: { provider: "llamacpp", model: "" },
    llamaCppStatus: null,
  });
});

describe("ModelPicker benchmark action", () => {
  it("opens benchmarking for the loaded local model", async () => {
    saveLocalModels([
      { id: "local:qwen", name: "Qwen Coder", path: "/models/qwen.gguf" },
    ]);
    useApp.setState({
      selectedModel: { provider: "llamacpp", model: "local:qwen" },
      llamaCppStatus: {
        running: true,
        host: "127.0.0.1",
        port: 8080,
        base_url: "http://127.0.0.1:8080",
        loaded_model_id: "local:qwen",
        loaded_model_path: "/models/qwen.gguf",
        n_gpu_layers: 99,
        n_ctx: 8192,
        n_threads: 8,
        n_batch: 2048,
        temperature: 0.2,
        top_p: 0.95,
        top_k: 40,
        repeat_penalty: 1.1,
        max_tokens: 4096,
        flash_attn: false,
        last_error: null,
      },
    });

    render(<ModelPicker />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Choose model" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Benchmark/ }));

    expect(screen.getByTestId("benchmark-dialog-stub")).toHaveTextContent("Qwen Coder");
  });
});
