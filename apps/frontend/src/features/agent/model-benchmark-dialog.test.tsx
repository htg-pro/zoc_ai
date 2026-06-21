import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ModelBenchmarkRun } from "@zoc-studio/shared-types";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHistory: vi.fn(),
  postBenchmark: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

vi.mock("./gateway-client", () => ({
  getModelBenchmarkHistory: mocks.getHistory,
  postModelBenchmark: mocks.postBenchmark,
}));

vi.mock("@/components/ui/toast", () => ({
  toast: {
    success: mocks.success,
    warning: mocks.warning,
    error: mocks.error,
  },
}));

import { ModelBenchmarkDialog } from "./ModelBenchmarkDialog";

function benchmarkRun(id: string, createdAt: string): ModelBenchmarkRun {
  return {
    id,
    modelId: "model-1",
    modelName: "Qwen Coder",
    createdAt,
    durationSeconds: 12.4,
    averageTimeToFirstTokenMs: 245,
    averageTokensPerSecond: 31.6,
    averageQualityScore: 87,
    prompts: ["Implementation", "Debugging", "Explanation", "Testing", "Refactoring"].map(
      (label, index) => ({
        promptId: `prompt-${index}`,
        label,
        timeToFirstTokenMs: 200 + index,
        tokensPerSecond: 30 + index,
        qualityScore: 80 + index,
        outputTokens: 42,
        error: null,
      }),
    ),
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ModelBenchmarkDialog", () => {
  it("loads history, renders the metric chart, and runs a new benchmark", async () => {
    const oldRun = benchmarkRun("old", "2026-06-20T10:00:00Z");
    const newRun = benchmarkRun("new", "2026-06-21T10:00:00Z");
    mocks.getHistory.mockResolvedValue({ modelId: "model-1", runs: [oldRun] });
    mocks.postBenchmark.mockResolvedValue(newRun);

    render(
      <ModelBenchmarkDialog
        open
        onOpenChange={vi.fn()}
        model={{ id: "model-1", name: "Qwen Coder" }}
        baseUrl="http://127.0.0.1:8080"
      />,
    );

    expect(await screen.findByRole("img", { name: "Benchmark history chart for 1 runs" })).toBeInTheDocument();
    expect(screen.getByText("Implementation")).toBeInTheDocument();
    expect(screen.getByText("31.6 tok/s")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Run benchmark" }));

    await waitFor(() => {
      expect(mocks.postBenchmark).toHaveBeenCalledWith({
        modelId: "model-1",
        modelName: "Qwen Coder",
        baseUrl: "http://127.0.0.1:8080",
      });
    });
    expect(await screen.findByRole("img", { name: "Benchmark history chart for 2 runs" })).toBeInTheDocument();
    expect(mocks.success).toHaveBeenCalledWith("Model benchmark completed.");
  });
});
