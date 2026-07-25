/**
 * The FSM reports its terminal error close (R3.10) as a `command` event whose
 * command is a synthetic marker, `<stage:error_closed>`. `CommandRow` rendered
 * `event.command` verbatim, so the user's chat feed showed that literal string
 * with no explanation — one of the reported symptoms.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AgentEvents } from "@zoc-studio/shared-types";

import { CommandRow, isSyntheticStageCommand } from "../rows";

function commandEvent(
  overrides: Partial<AgentEvents.CommandEvent> = {},
): AgentEvents.CommandEvent {
  return {
    type: "command",
    seq: 1,
    runId: "run-1",
    ts: "2026-01-01T00:00:00Z",
    command: "pnpm test",
    ...overrides,
  } as AgentEvents.CommandEvent;
}

describe("isSyntheticStageCommand", () => {
  it("recognises the FSM's stage markers", () => {
    expect(isSyntheticStageCommand("<stage:error_closed>")).toBe(true);
    expect(isSyntheticStageCommand("<stage:done>")).toBe(true);
  });

  it("leaves real commands alone", () => {
    expect(isSyntheticStageCommand("pnpm test")).toBe(false);
    expect(isSyntheticStageCommand("echo '<stage:x>'")).toBe(false);
    expect(isSyntheticStageCommand(undefined)).toBe(false);
  });
});

describe("CommandRow", () => {
  it("never shows the raw stage marker to the user", () => {
    render(
      <CommandRow
        event={commandEvent({ command: "<stage:error_closed>", errorTag: "edit_plan failed" })}
      />,
    );

    expect(screen.queryByText(/<stage:error_closed>/)).toBeNull();
    expect(screen.getByText("Run stopped")).toBeInTheDocument();
    expect(screen.getByText(/ended before finishing/i)).toBeInTheDocument();
  });

  it("still renders a real shell command verbatim", () => {
    const { container } = render(
      <CommandRow event={commandEvent({ command: "pnpm test", exitCode: 0 })} />,
    );
    expect(screen.getAllByText(/pnpm test/).length).toBeGreaterThan(0);
    // A real command is the ordinary "Run" row, not the stage-closed one.
    expect(container.querySelector("[data-stage-closed]")).toBeNull();
    expect(screen.queryByText("Run stopped")).toBeNull();
  });
});
