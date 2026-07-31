/**
 * The panel's derived state — zoc-agent-chat-rebuild task 22.8's guard.
 *
 * R13.9 (the live Token_Rate, and where it stops), R16.5 (an interrupted Run is continuable),
 * R12.8–R12.10 (the census, and which model it was measured against), R18.7 (the mark's state).
 *
 * The pill's eight states are the point of most of this file. `useChat` reports four, three of the
 * missing ones are terminal, and the failure mode that matters is a Run the user cancelled reading as
 * one that completed — both leave the hook `ready`, so only the lifecycle part can tell them apart.
 */

import { describe, expect, it } from "vitest";
import type { RunLifecyclePart, UsagePart } from "@zoc-studio/shared-types";

import {
  censusOf,
  markStateOf,
  rootName,
  runSnapshotOf,
  suggestionsFor,
} from "@/features/chat/panel-state";
import type { ZocMessageMetadata, ZocUIMessage } from "@/features/chat/wire/ui-message";

// ── Fixtures ──────────────────────────────────────────────────────────

const RUN = "run-1";

function lifecycle(
  state: RunLifecyclePart["state"],
  overrides: Partial<RunLifecyclePart> = {},
): RunLifecyclePart {
  return {
    type: "run-lifecycle",
    seq: 1,
    runId: RUN,
    messageId: "m1",
    ts: "2026-07-31T10:00:00.000Z",
    agentName: null,
    state,
    ...overrides,
  };
}

function usage(overrides: Partial<UsagePart> = {}): UsagePart {
  return {
    type: "usage",
    seq: 9,
    runId: RUN,
    messageId: "m1",
    ts: "2026-07-31T10:00:04.000Z",
    agentName: null,
    inputTokens: 1_000,
    outputTokens: 200,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    contextLimit: 200_000,
    tokensPerSecond: 42,
    messagesInContext: 12,
    sessionMessageCount: 40,
    messagesOutOfWindow: 3,
    summaryActive: false,
    ...overrides,
  };
}

function metadata(overrides: Partial<ZocMessageMetadata> = {}): ZocMessageMetadata {
  return {
    runId: RUN,
    provider: "anthropic",
    model: "claude-opus-5",
    conversationMode: "agent",
    startedAt: "2026-07-31T10:00:00.000Z",
    finishedAt: "2026-07-31T10:00:04.000Z",
    inputTokens: 800,
    outputTokens: 150,
    estimatedCostCents: 2,
    tokensPerSecond: 40,
    messagesInContext: 10,
    sessionMessageCount: 30,
    messagesOutOfWindow: 1,
    summaryActive: true,
    rulesSources: [],
    ...overrides,
  };
}

/** An assistant turn carrying whichever data parts a case needs. */
function assistant(
  parts: readonly (RunLifecyclePart | UsagePart)[],
  meta: ZocMessageMetadata | undefined = metadata(),
): ZocUIMessage {
  return {
    id: "m1",
    role: "assistant",
    ...(meta === undefined ? {} : { metadata: meta }),
    parts: parts.map((part) =>
      part.type === "run-lifecycle"
        ? ({ type: "data-zoc-run", id: part.runId, data: part } as ZocUIMessage["parts"][number])
        : ({ type: "data-zoc-usage", id: part.runId, data: part } as ZocUIMessage["parts"][number]),
    ),
  };
}

const NO_APPROVAL = { awaitingApproval: false } as const;

describe("Feature: zoc-agent-chat-rebuild, task 22.8: the run snapshot", () => {
  it("is idle for a Session that has never run", () => {
    const snapshot = runSnapshotOf({ messages: [], status: "ready", ...NO_APPROVAL });
    expect(snapshot).toEqual({
      runId: null,
      state: "idle",
      startedAt: null,
      tokensPerSecond: null,
      interrupted: false,
      active: false,
    });
  });

  it("reads running from the hook while the lifecycle is silent", () => {
    const snapshot = runSnapshotOf({ messages: [], status: "streaming", ...NO_APPROVAL });
    expect(snapshot.state).toBe("running");
    expect(snapshot.active).toBe(true);
  });

  it("prefers the lifecycle's queued state, which the hook has no word for", () => {
    const messages = [assistant([lifecycle("queued", { queuePosition: 2 })])];
    expect(runSnapshotOf({ messages, status: "submitted", ...NO_APPROVAL }).state).toBe("queued");
  });

  it("lets a pending approval outrank a streaming hook (R11.8)", () => {
    const messages = [assistant([lifecycle("running")])];
    const snapshot = runSnapshotOf({ messages, status: "streaming", awaitingApproval: true });
    expect(snapshot.state).toBe("awaiting-approval");
    // Still active: the Run has not ended, so the clock keeps going.
    expect(snapshot.active).toBe(true);
  });

  it("does not claim a pending approval for a Session with no Run at all", () => {
    const snapshot = runSnapshotOf({ messages: [], status: "ready", awaitingApproval: true });
    expect(snapshot.state).toBe("idle");
  });

  it.each([
    ["completed", "completed"],
    ["cancelled", "cancelled"],
    ["failed", "failed"],
    ["interrupted", "interrupted"],
  ] as const)("distinguishes %s from a ready hook", (state, expected) => {
    const messages = [assistant([lifecycle(state)])];
    expect(runSnapshotOf({ messages, status: "ready", ...NO_APPROVAL }).state).toBe(expected);
  });

  it("falls back to failed when the transport threw before a Run opened", () => {
    expect(runSnapshotOf({ messages: [], status: "error", ...NO_APPROVAL }).state).toBe("failed");
  });

  it("marks an interrupted Run continuable, and a cancelled one not", () => {
    const cut = [assistant([lifecycle("interrupted", { code: "stream_lost" })])];
    const stopped = [assistant([lifecycle("cancelled")])];
    expect(runSnapshotOf({ messages: cut, status: "ready", ...NO_APPROVAL }).interrupted).toBe(true);
    expect(
      runSnapshotOf({ messages: stopped, status: "ready", ...NO_APPROVAL }).interrupted,
    ).toBe(false);
  });

  it("times the Run from its earliest part, not its newest (R13.9)", () => {
    const messages = [
      assistant([
        lifecycle("queued", { seq: 1, ts: "2026-07-31T10:00:00.000Z" }),
        lifecycle("running", { seq: 2, ts: "2026-07-31T10:00:07.000Z" }),
      ]),
    ];
    const snapshot = runSnapshotOf({ messages, status: "streaming", ...NO_APPROVAL });
    expect(snapshot.startedAt).toBe(Date.parse("2026-07-31T10:00:00.000Z"));
  });

  it("shows the live rate while active and drops it the moment the Run settles (R13.9, R13.10)", () => {
    const running = [assistant([lifecycle("running"), usage({ tokensPerSecond: 42 })])];
    const done = [assistant([lifecycle("completed", { seq: 12 }), usage({ tokensPerSecond: 42 })])];
    expect(runSnapshotOf({ messages: running, status: "streaming", ...NO_APPROVAL }).tokensPerSecond).toBe(42);
    expect(runSnapshotOf({ messages: done, status: "ready", ...NO_APPROVAL }).tokensPerSecond).toBeNull();
  });

  it("ignores a rate of zero or a missing one rather than reporting it as measured", () => {
    for (const rate of [0, null, undefined]) {
      const messages = [assistant([lifecycle("running"), usage({ tokensPerSecond: rate })])];
      expect(
        runSnapshotOf({ messages, status: "streaming", ...NO_APPROVAL }).tokensPerSecond,
      ).toBeNull();
    }
  });

  it("orders lifecycle parts by seq, so a replayed stream cannot rewind the state (R16.4)", () => {
    // The terminal part arrives in an earlier array slot than a replayed `running`.
    const messages = [
      assistant([
        lifecycle("completed", { seq: 20 }),
        lifecycle("running", { seq: 4 }),
      ]),
    ];
    expect(runSnapshotOf({ messages, status: "ready", ...NO_APPROVAL }).state).toBe("completed");
  });
});

describe("Feature: zoc-agent-chat-rebuild, task 22.8: the context census (R12.8, R12.9, R12.10)", () => {
  it("reports an unrun Session as an estimate rather than as zero consumption", () => {
    const census = censusOf([]);
    expect(census.consumedTokens).toBe(0);
    // Null, so `contextFigures` reports `estimated` — "we have not measured" and "we measured zero"
    // are different claims and only one of them is true.
    expect(census.measuredAgainst).toBeNull();
  });

  it("takes its figures and its limit from the UsagePart, and names the model from the metadata", () => {
    const census = censusOf([assistant([lifecycle("completed"), usage()])]);
    expect(census).toEqual({
      messagesInContext: 12,
      sessionMessageCount: 40,
      messagesOutOfWindow: 3,
      summaryActive: false,
      // The last Run's input plus its output: the context that was sent, plus what has since joined it.
      consumedTokens: 1_200,
      measuredAgainst: { provider: "anthropic", modelId: "claude-opus-5", contextLimit: 200_000 },
    });
  });

  it("falls back to the mirrored metadata on a restored turn, and calls it an estimate", () => {
    const census = censusOf([assistant([])]);
    expect(census.messagesInContext).toBe(10);
    expect(census.summaryActive).toBe(true);
    expect(census.consumedTokens).toBe(950);
    // No `UsagePart` means no `contextLimit`, so there is no window it can claim to have been measured
    // against — which is exactly R12.9's second estimate case.
    expect(census.measuredAgainst).toBeNull();
  });

  it("reads the newest assistant turn, not the first", () => {
    const older = assistant([usage({ contextLimit: 8_192, inputTokens: 1, outputTokens: 1 })]);
    const newer: ZocUIMessage = {
      ...assistant([usage({ seq: 40, inputTokens: 5_000, outputTokens: 500 })]),
      id: "m2",
    };
    expect(censusOf([older, newer]).consumedTokens).toBe(5_500);
  });

  it("skips a user turn, which carries no census of its own", () => {
    const user: ZocUIMessage = { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] };
    expect(censusOf([assistant([usage()]), user]).consumedTokens).toBe(1_200);
  });
});

describe("Feature: zoc-agent-chat-rebuild, task 22.8: the mark's state (R18.7)", () => {
  it("does not paint a cancelled Run as a failure", () => {
    // The user's own decision, so the mark goes quiet rather than red.
    expect(markStateOf("cancelled")).toBe("idle");
    expect(markStateOf("failed")).toBe("failed");
    expect(markStateOf("interrupted")).toBe("failed");
  });

  it("treats waiting as activity", () => {
    expect(markStateOf("awaiting-approval")).toBe("running");
    expect(markStateOf("queued")).toBe("running");
  });

  it("maps every pill state to one of the mark's four", () => {
    const states = [
      "idle",
      "queued",
      "running",
      "awaiting-approval",
      "completed",
      "cancelled",
      "failed",
      "interrupted",
    ] as const;
    for (const state of states) {
      expect(["idle", "running", "complete", "failed"]).toContain(markStateOf(state));
    }
  });
});

describe("Feature: zoc-agent-chat-rebuild, task 22.8: the empty state's suggestions", () => {
  it("names the workspace folder whichever separator the root uses, and however it ends", () => {
    expect(rootName("/home/dev/archivezip")).toBe("archivezip");
    expect(rootName("/home/dev/archivezip/")).toBe("archivezip");
    expect(rootName("C:\\Users\\dev\\archivezip")).toBe("archivezip");
    expect(rootName("/")).toBeNull();
    expect(rootName(null)).toBeNull();
  });

  it("offers three workspace-derived starting points, at least one naming the folder", () => {
    const suggestions = suggestionsFor("/home/dev/archivezip");
    expect(suggestions).toHaveLength(3);
    expect(suggestions.some((suggestion) => suggestion.prompt.includes("archivezip"))).toBe(true);
    // Distinct ids, so React keys and the `data-` hooks are unambiguous.
    expect(new Set(suggestions.map((suggestion) => suggestion.id)).size).toBe(3);
  });

  it("offers answerable questions instead when no workspace is open", () => {
    const suggestions = suggestionsFor(null);
    expect(suggestions).toHaveLength(3);
    // Nothing that would need a workspace to answer, because R32.13 blocks a write-capable Run anyway.
    expect(suggestions.every((suggestion) => !suggestion.prompt.includes("uncommitted"))).toBe(true);
  });
});
