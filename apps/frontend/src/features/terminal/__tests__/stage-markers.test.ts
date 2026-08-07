/**
 * stage-markers.test.ts — the FSM's synthetic markers, recognised without printing them.
 *
 * When the run FSM closes on an error it reports the close as a `command` event whose command is a
 * marker (`<stage:error_closed>`), not a shell command. Anything that prints `event.command` verbatim
 * shows the user that literal string where an explanation belongs.
 *
 * The anchoring is the part worth a test: the predicate must match only at the *start* of the string,
 * so a genuine command that merely mentions a marker (`echo '<stage:x>'`) still renders as a command.
 *
 * Moved here from `features/agent/__tests__` at task 26.1 along with the module; the classification
 * rows that exercised `normalize.ts`'s fold stayed behind and die with that tree.
 */
import { describe, expect, it } from "vitest";

import { isSyntheticStageCommand, SYNTHETIC_STAGE_PREFIX } from "../stage-markers";

describe("isSyntheticStageCommand", () => {
  it("recognises the FSM's stage markers", () => {
    expect(isSyntheticStageCommand("<stage:error_closed>")).toBe(true);
    expect(isSyntheticStageCommand("<stage:done>")).toBe(true);
    expect(isSyntheticStageCommand(SYNTHETIC_STAGE_PREFIX)).toBe(true);
  });

  it("leaves real commands alone", () => {
    expect(isSyntheticStageCommand("pnpm test")).toBe(false);
    expect(isSyntheticStageCommand("echo '<stage:x>'")).toBe(false);
    expect(isSyntheticStageCommand(undefined)).toBe(false);
    expect(isSyntheticStageCommand(null)).toBe(false);
    expect(isSyntheticStageCommand("")).toBe(false);
  });
});
