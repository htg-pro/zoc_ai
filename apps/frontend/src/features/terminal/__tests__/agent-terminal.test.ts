import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { AgentEvents } from "@zoc-studio/shared-types";
import {
  AGENT_RUN_END_SEPARATOR,
  commandKey,
  deriveEventsFromCommand,
  formatRunStartMarker,
  initialAgentTerminalState,
  isPaneAgentActive,
  paneBadge,
  paneOutputText,
  reduceAgentTerminal,
  runAgentTerminal,
  type AgentTerminalEvent,
  type AgentTerminalState,
  type CommandBookkeeping,
} from "../agent-terminal";

/** Start with pane "p1" focused unless overridden. */
function seeded(focused = "p1"): AgentTerminalState {
  return initialAgentTerminalState(focused);
}

function segmentTypes(state: AgentTerminalState, paneId: string): string[] {
  return state.panes[paneId]?.output.map((s) => s.type) ?? [];
}

describe("agent-terminal: run lifecycle & routing", () => {
  it("routes a run to the focused pane, bracketed by START and one END", () => {
    const events: AgentTerminalEvent[] = [
      { kind: "run-start", runId: "r1", command: "pnpm test" },
      { kind: "run-output", runId: "r1", chunk: "a" },
      { kind: "run-output", runId: "r1", chunk: "b" },
      { kind: "run-exit", runId: "r1", exitCode: 0 },
    ];
    const state = runAgentTerminal(seeded("p1"), events);

    expect(state.agentPaneId).toBe("p1");
    expect(segmentTypes(state, "p1")).toEqual(["start", "chunk", "chunk", "end"]);
    expect(paneOutputText(state, "p1")).toEqual([
      formatRunStartMarker("pnpm test"),
      "a",
      "b",
      AGENT_RUN_END_SEPARATOR,
    ]);
  });

  it("designates the pane focused at run start, not a later focus", () => {
    let state = seeded("p1");
    state = reduceAgentTerminal(state, { kind: "run-start", runId: "r1", command: "ls" });
    state = reduceAgentTerminal(state, { kind: "focus-pane", paneId: "p2" });
    state = reduceAgentTerminal(state, { kind: "run-output", runId: "r1", chunk: "x" });
    expect(state.agentPaneId).toBe("p1");
    expect(paneOutputText(state, "p1")).toContain("x");
    expect(state.panes.p2).toBeUndefined();
  });

  it("marks the agent pane active during a run and inactive after exit", () => {
    let state = reduceAgentTerminal(seeded("p1"), {
      kind: "run-start",
      runId: "r1",
      command: "sleep 1",
    });
    expect(isPaneAgentActive(state, "p1")).toBe(true);
    state = reduceAgentTerminal(state, { kind: "run-exit", runId: "r1", exitCode: 0 });
    expect(isPaneAgentActive(state, "p1")).toBe(false);
  });

  it("is a no-op when no pane is focused at run start", () => {
    const state = reduceAgentTerminal(initialAgentTerminalState(null), {
      kind: "run-start",
      runId: "r1",
      command: "ls",
    });
    expect(state.agentPaneId).toBeNull();
    expect(state.panes).toEqual({});
  });
});

describe("agent-terminal: completion badge", () => {
  it("is running while in flight", () => {
    const state = reduceAgentTerminal(seeded(), { kind: "run-start", runId: "r1", command: "x" });
    expect(paneBadge(state, "p1")).toEqual({ status: "running" });
  });

  it("badge reflects the exit code (ok on 0, fail with the code otherwise)", () => {
    fc.assert(
      fc.property(fc.integer({ min: -128, max: 255 }), (code) => {
        let state = reduceAgentTerminal(seeded(), {
          kind: "run-start",
          runId: "r1",
          command: "x",
        });
        state = reduceAgentTerminal(state, { kind: "run-exit", runId: "r1", exitCode: code });
        const badge = paneBadge(state, "p1");
        if (code === 0) {
          expect(badge).toEqual({ status: "ok", exitCode: 0 });
        } else {
          expect(badge).toEqual({ status: "fail", exitCode: code });
        }
      }),
    );
  });
});

describe("agent-terminal: exactly one END separator", () => {
  it("appends only one END even when exit is delivered repeatedly", () => {
    let state = reduceAgentTerminal(seeded(), { kind: "run-start", runId: "r1", command: "x" });
    for (let i = 0; i < 5; i++) {
      state = reduceAgentTerminal(state, { kind: "run-exit", runId: "r1", exitCode: 0 });
    }
    const ends = state.panes.p1.output.filter((s) => s.type === "end");
    expect(ends).toHaveLength(1);
  });

  it("property: each completed run contributes exactly one END separator", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 1, maxLength: 6 }),
        (chunkCountsPerRun) => {
          let state = seeded("p1");
          for (let r = 0; r < chunkCountsPerRun.length; r++) {
            const runId = `r${r}`;
            state = reduceAgentTerminal(state, { kind: "run-start", runId, command: "c" });
            for (let c = 0; c < chunkCountsPerRun[r]; c++) {
              state = reduceAgentTerminal(state, { kind: "run-output", runId, chunk: `${c}` });
            }
            state = reduceAgentTerminal(state, { kind: "run-exit", runId, exitCode: 0 });
          }
          const ends = state.panes.p1.output.filter((s) => s.type === "end");
          expect(ends).toHaveLength(chunkCountsPerRun.length);
        },
      ),
    );
  });
});

describe("agent-terminal: output order preserved", () => {
  it("property: chunk order in the log matches emission order", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 20 }), (chunks) => {
        let state = reduceAgentTerminal(seeded(), { kind: "run-start", runId: "r1", command: "x" });
        for (const chunk of chunks) {
          state = reduceAgentTerminal(state, { kind: "run-output", runId: "r1", chunk });
        }
        const loggedChunks = state.panes.p1.output
          .filter((s) => s.type === "chunk")
          .map((s) => s.text);
        expect(loggedChunks).toEqual(chunks);
      }),
    );
  });
});

describe("agent-terminal: follow-agent focus behavior", () => {
  it("pins focus to the agent pane while following, releasing on toggle off", () => {
    let state = seeded("p1");
    state = reduceAgentTerminal(state, { kind: "run-start", runId: "r1", command: "x" });
    // Move focus away — allowed while not following.
    state = reduceAgentTerminal(state, { kind: "focus-pane", paneId: "p2" });
    expect(state.focusedPaneId).toBe("p2");
    // Turn following on → focus snaps to the agent pane.
    state = reduceAgentTerminal(state, { kind: "set-follow-agent", value: true });
    expect(state.focusedPaneId).toBe("p1");
    // A manual focus while following is overridden back to the agent pane.
    state = reduceAgentTerminal(state, { kind: "focus-pane", paneId: "p2" });
    expect(state.focusedPaneId).toBe("p1");
    // Turn following off → manual focus is honored again.
    state = reduceAgentTerminal(state, { kind: "set-follow-agent", value: false });
    state = reduceAgentTerminal(state, { kind: "focus-pane", paneId: "p2" });
    expect(state.focusedPaneId).toBe("p2");
  });

  it("does nothing on follow when there is no agent pane yet", () => {
    const state = reduceAgentTerminal(seeded("p1"), { kind: "set-follow-agent", value: true });
    expect(state.focusedPaneId).toBe("p1");
    expect(state.agentPaneId).toBeNull();
  });
});

describe("agent-terminal: user typing is never dropped (non-blocking)", () => {
  it("property: every user-input event is recorded, even while the agent is active", () => {
    const agentEvent = fc.oneof(
      fc.constant<AgentTerminalEvent>({ kind: "run-start", runId: "r1", command: "x" }),
      fc.string().map<AgentTerminalEvent>((chunk) => ({
        kind: "run-output",
        runId: "r1",
        chunk,
      })),
      fc.constant<AgentTerminalEvent>({ kind: "run-exit", runId: "r1", exitCode: 0 }),
    );
    const userEvent = fc
      .string()
      .map<AgentTerminalEvent>((data) => ({ kind: "user-input", paneId: "p1", data }));

    fc.assert(
      fc.property(fc.array(fc.oneof(agentEvent, userEvent), { maxLength: 40 }), (events) => {
        const state = runAgentTerminal(seeded("p1"), events);
        const typed = events.filter((e) => e.kind === "user-input");
        expect(state.userInputLog).toHaveLength(typed.length);
        expect(state.userInputLog.map((u) => u.data)).toEqual(
          typed.map((e) => (e.kind === "user-input" ? e.data : "")),
        );
      }),
    );
  });

  it("records typing during an active run without touching the output log", () => {
    let state = reduceAgentTerminal(seeded("p1"), { kind: "run-start", runId: "r1", command: "x" });
    state = reduceAgentTerminal(state, { kind: "user-input", paneId: "p1", data: "echo hi\r" });
    expect(isPaneAgentActive(state, "p1")).toBe(true);
    expect(state.userInputLog).toEqual([{ paneId: "p1", data: "echo hi\r" }]);
    // Typing must not be injected into the agent output stream.
    expect(segmentTypes(state, "p1")).toEqual(["start"]);
  });
});

describe("agent-terminal: CommandEvent adapter", () => {
  function cmd(patch: Partial<AgentEvents.CommandEvent>): AgentEvents.CommandEvent {
    return {
      type: "command",
      seq: 1,
      runId: "r1",
      ts: "2026-01-01T00:00:00Z",
      command: "pnpm test",
      ...patch,
    };
  }

  it("emits a single run-start across repeated frames of the same command", () => {
    const empty: CommandBookkeeping = { started: new Set(), ended: new Set() };
    const first = deriveEventsFromCommand(cmd({ commandId: "c1" }), empty);
    expect(first.events).toEqual([{ kind: "run-start", runId: "r1:c1", command: "pnpm test" }]);

    const second = deriveEventsFromCommand(cmd({ commandId: "c1", outputDelta: "hello" }), first.book);
    expect(second.events).toEqual([{ kind: "run-output", runId: "r1:c1", chunk: "hello" }]);

    const third = deriveEventsFromCommand(cmd({ commandId: "c1", exitCode: 2 }), second.book);
    expect(third.events).toEqual([{ kind: "run-exit", runId: "r1:c1", exitCode: 2 }]);

    // A duplicate terminal frame emits nothing new.
    const dup = deriveEventsFromCommand(cmd({ commandId: "c1", exitCode: 2 }), third.book);
    expect(dup.events).toEqual([]);
  });

  it("assigns distinct lifecycle ids to commands in the same parent run", () => {
    const empty: CommandBookkeeping = { started: new Set(), ended: new Set() };
    const first = deriveEventsFromCommand(cmd({ commandId: "c1" }), empty);
    const second = deriveEventsFromCommand(cmd({ commandId: "c2", command: "cargo test" }), first.book);
    expect(first.events[0]).toMatchObject({ runId: "r1:c1" });
    expect(second.events[0]).toMatchObject({ runId: "r1:c2" });
  });

  it("keys distinct commands separately and does not mutate the input book", () => {
    const book: CommandBookkeeping = { started: new Set(), ended: new Set() };
    deriveEventsFromCommand(cmd({ commandId: "c1" }), book);
    // Input book is untouched (pure).
    expect(book.started.size).toBe(0);
    expect(commandKey(cmd({ commandId: "c1" }))).toBe("r1:c1");
    expect(commandKey(cmd({ commandId: null, command: "ls" }))).toBe("r1:ls");
  });
});

// Feature: zoc-ai-agent-chat-overhaul, Property 25: Internal frames appear on no rendered surface
//
// The terminal half of Property 25: the only surface a `CommandEvent` can reach
// is the live xterm, via `deriveEventsFromCommand → renderSegment → writeToTerminal`.
// A synthetic `<stage:...>` marker is an internal Stage_Machine frame, not
// process output, so it must produce no terminal events at all (R10.3, R13.2).
describe("agent-terminal: internal <stage:> frames never reach the terminal (Property 25)", () => {
  function cmd(command: string, patch: Partial<AgentEvents.CommandEvent> = {}): AgentEvents.CommandEvent {
    return {
      type: "command",
      seq: 1,
      runId: "r1",
      ts: "2026-01-01T00:00:00Z",
      command,
      ...patch,
    };
  }
  const empty: CommandBookkeeping = { started: new Set(), ended: new Set() };

  it("drops a synthetic stage command frame, emitting nothing to the terminal", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "error_closed",
          "done",
          "analyze",
          "plan",
          "apply",
          "verify",
          "summary",
          "intake",
        ),
        // Even with output/exit fields set, a stage marker frame yields no events.
        fc.record({
          outputDelta: fc.option(fc.string(), { nil: undefined }),
          exitCode: fc.option(fc.integer(), { nil: undefined }),
        }),
        (name, extra) => {
          const { events, book } = deriveEventsFromCommand(cmd(`<stage:${name}>`, extra), empty);
          expect(events).toEqual([]);
          // Bookkeeping is untouched, so a later real command is unaffected.
          expect(book).toBe(empty);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("still routes a genuine command through unchanged", () => {
    const { events } = deriveEventsFromCommand(cmd("pnpm test", { exitCode: 0 }), empty);
    expect(events.some((e) => e.kind === "run-start")).toBe(true);
    expect(events.some((e) => e.kind === "run-exit")).toBe(true);
  });
});
