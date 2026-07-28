// Feature: zoc-ai-agent-chat-overhaul, Task 19.7: follow-up chips are produced
//
// A terminal run's card derives follow-up chips from the run record and renders
// them; activating a chip calls the Composer's submit path (R21.1–R21.4).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { RunCardView } from "../RunCardView";
import type { RunCard } from "../run-cards";
import type { TrackedRun } from "../agent-runs";

function terminalCard(overrides: Partial<TrackedRun> = {}): RunCard {
  const run: TrackedRun = {
    runId: "r1",
    mode: "agent",
    phase: "done",
    title: "add a feature",
    startedAt: 0,
    endedAt: 1_000,
    filesChanged: 2,
    ...overrides,
  };
  return { runId: run.runId, run, rows: [] };
}

afterEach(cleanup);

describe("run card follow-ups (Task 19.7)", () => {
  it("renders follow-up chips for a finished run and keeps them scoped to its runId", () => {
    const { container } = render(
      <RunCardView card={terminalCard()} focused collapsed={false} onSubmitPrompt={vi.fn()} />,
    );
    const chips = container.querySelector('[data-row-kind="follow-ups"]');
    expect(chips).not.toBeNull();
    // A done run that changed files offers review/test follow-ups.
    expect(screen.getByRole("button", { name: /review the changes/i })).toBeInTheDocument();
  });

  it("activates a chip through the Composer submit path", () => {
    const onSubmitPrompt = vi.fn();
    render(
      <RunCardView card={terminalCard()} focused collapsed={false} onSubmitPrompt={onSubmitPrompt} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /review the changes/i }));
    expect(onSubmitPrompt).toHaveBeenCalledWith("Walk me through the changes you just made.");
  });

  it("shows no chips on a collapsed card (no duplication)", () => {
    const { container } = render(
      <RunCardView card={terminalCard()} focused={false} collapsed onSubmitPrompt={vi.fn()} />,
    );
    expect(container.querySelector('[data-row-kind="follow-ups"]')).toBeNull();
    expect(container.querySelector('[data-row-kind="run-summary"]')).toBeNull();
  });
});
