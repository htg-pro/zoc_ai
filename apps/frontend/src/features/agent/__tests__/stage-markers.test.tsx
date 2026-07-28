/**
 * stage-markers.test.tsx — the FSM's synthetic markers and how the single fold
 * classifies command activity.
 *
 * The FSM reports its terminal error close (R3.10) as a `command` event whose
 * command is a marker, `<stage:error_closed>`. Anything that prints
 * `event.command` verbatim shows the user that literal string with no
 * explanation. The single `normalizeEvent` fold now owns that classification
 * (R9.3): a stage marker is discarded as an internal frame, a real command
 * becomes a tool-call row, and an MCP-run command is attributed to its server.
 * (These used to be asserted against the folded-trace `RunTraceCard`, retired
 * with `buildRunTraces` in task 12.7.)
 */
import { describe, expect, it } from "vitest";
import type { AgentEvents } from "@zoc-studio/shared-types";

import { isSyntheticStageCommand } from "../stage-markers";
import { isDiscard, normalizeEvent, type NormalizeContext } from "../normalize";

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

const ctx: NormalizeContext = { activeRunId: "run-1", boundMessageId: null, highestSeq: -1 };

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

describe("command classification in the single fold", () => {
  it("discards a synthetic stage marker as an internal frame — never a row", () => {
    const result = normalizeEvent(
      commandEvent({ command: "<stage:error_closed>", errorTag: "edit_plan failed" }),
      ctx,
    );
    expect(isDiscard(result)).toBe(true);
    if (isDiscard(result)) expect(result.reason).toBe("internal-frame");
  });

  it("maps a real shell command to a tool-call row carrying the command", () => {
    const result = normalizeEvent(commandEvent({ command: "pnpm test", exitCode: 0 }), ctx);
    expect(isDiscard(result)).toBe(false);
    if (!isDiscard(result) && result.kind === "tool-call") {
      expect(result.tool).toBe("shell");
      expect(result.target).toBe("pnpm test");
    } else {
      throw new Error("expected a tool-call row for a real command");
    }
  });

  it("attributes a command run through an MCP server to that server", () => {
    const result = normalizeEvent(
      commandEvent({ command: "search_docs", exitCode: 0, mcpServerId: "zocai-docs" }),
      ctx,
    );
    if (!isDiscard(result) && result.kind === "tool-call") {
      expect(result.tool).toBe("mcp:zocai-docs");
    } else {
      throw new Error("expected a tool-call row for an MCP command");
    }
  });
});
