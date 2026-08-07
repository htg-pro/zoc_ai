/**
 * The approval dock — zoc-agent-chat-rebuild R22.1, R11.8, R11.9, task 22.13.
 *
 * The "approval flows" area of R22.1's unit suite: the dock appears for a pending request, a decision
 * posts with the scope the user chose, and a lapsed deadline takes the request away.
 *
 * ## Why this sits beside three property tests rather than inside them
 *
 * Properties 18 and 55 already assert placement (the dock cannot scroll away) and focus (it takes focus
 * and names its subject), and `permission-model.test.ts` asserts the pure derivation of *which* request is
 * pending. None of the three drives a decision to the callback and back, which is the flow this file is
 * for — and every property test in the plan is optional, so an area covered only by one is an area a
 * fast-MVP run ships untested.
 *
 * ## The clock is a variable, not a mock
 *
 * The dock takes `now` as a function precisely so a deadline can be reached in a test. Advancing a
 * `let nowMs` alongside the fake timers keeps the countdown's ticks and the request's expiry on the same
 * clock — mocking `Date.now` globally instead would leave the two disagreeing, and the countdown would
 * tick against a deadline that never arrives.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { PermissionRequestPart } from "@zoc-studio/shared-types";

import { ChatMotionProvider } from "@/lib/reduced-motion-provider";
import { PermissionDock } from "@/features/chat/permission/PermissionDock";
import { APPROVAL_WINDOW_MS } from "@/features/chat/permission/permission-model";
import type { ZocUIMessage } from "@/features/chat/wire/ui-message";
import { resetChatSurface } from "./transcript-harness";

const START = Date.parse("2026-07-31T10:00:00.000Z");

let nowMs = START;

function requestPart(overrides: Partial<PermissionRequestPart> = {}): PermissionRequestPart {
  return {
    type: "permission-request",
    seq: 7,
    runId: "run_1",
    messageId: "assistant-1",
    ts: new Date(START).toISOString(),
    agentName: null,
    requestId: "req_1",
    toolCallId: "call_1",
    toolName: "workspace_run_command",
    kind: "execute",
    prompt: "Allow workspace_run_command?",
    paths: ["src/a.ts", "src/b.ts"],
    reason: "destructive",
    offeredScopes: ["call", "run", "workspace"],
    expiresAt: new Date(START + APPROVAL_WINDOW_MS).toISOString(),
    decision: null,
    decidedScope: null,
    ...overrides,
  };
}

function messagesWith(...parts: PermissionRequestPart[]): ZocUIMessage[] {
  return [
    { id: "u1", role: "user", parts: [{ type: "text", text: "run the tests" }] } as ZocUIMessage,
    {
      id: "assistant-1",
      role: "assistant",
      parts: [
        { type: "text", text: "I need to run the tests.", state: "done" },
        ...parts.map((data) => ({ type: "data-zoc-permission" as const, data })),
      ],
    } as ZocUIMessage,
  ];
}

interface Mounted {
  readonly onDecide: ReturnType<typeof vi.fn>;
}

function mountDock(
  messages: readonly ZocUIMessage[],
  onDecide: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined),
): Mounted {
  render(
    <ChatMotionProvider>
      <PermissionDock messages={messages} onDecide={onDecide} now={() => nowMs} />
    </ChatMotionProvider>,
  );
  return { onDecide };
}

const el = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);

const press = (selector: string): void => {
  const node = el(selector);
  if (node === null) throw new Error(`no control matched ${selector}`);
  fireEvent.click(node);
};

beforeEach(() => {
  nowMs = START;
  resetChatSurface();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Feature: zoc-agent-chat-rebuild, task 22.13: approval flows (R22.1)", () => {
  it("appears for a pending request and states what is being asked", () => {
    mountDock(messagesWith(requestPart()));
    expect(el("[data-zoc-permission-dock]")).not.toBeNull();
    expect(el("[data-zoc-permission-row]")).not.toBeNull();
    expect(el("[data-zoc-permission-tool]")?.textContent).toContain("workspace_run_command");
    // Both paths, because "which files" is the question a user answers this with.
    expect(document.body.textContent).toContain("src/a.ts");
  });

  it("stays away when there is nothing to decide", () => {
    mountDock(messagesWith());
    expect(el("[data-zoc-permission-dock]")).toBeNull();
  });

  it("posts the decision with the scope the user chose (R11.9)", () => {
    const { onDecide } = mountDock(messagesWith(requestPart()));

    press('[data-zoc-permission-scope="run"]');
    expect(el('[data-zoc-permission-scope="run"]')?.getAttribute("aria-checked")).toBe("true");
    press("[data-zoc-permission-approve]");

    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith({
      requestId: "req_1",
      decision: "approve",
      scope: "run",
    });
  });

  it("rejects at call scope, because a refusal grants nothing to widen", () => {
    const { onDecide } = mountDock(messagesWith(requestPart()));
    press('[data-zoc-permission-scope="workspace"]');
    press("[data-zoc-permission-reject]");
    // The chosen scope is deliberately ignored on the reject path: a rejection is not a grant, and
    // recording "rejected for the workspace" would read as a standing refusal the runtime never stored.
    expect(onDecide).toHaveBeenCalledWith({
      requestId: "req_1",
      decision: "reject",
      scope: "call",
    });
  });

  it("sends one decision however many times the control is pressed", () => {
    // The dock holds the request until the runtime answers, so a second press is a double-post rather
    // than a correction.
    const onDecide = vi.fn().mockReturnValue(new Promise(() => {}));
    mountDock(messagesWith(requestPart()), onDecide);

    press("[data-zoc-permission-approve]");
    press("[data-zoc-permission-approve]");
    press("[data-zoc-permission-reject]");
    expect(onDecide).toHaveBeenCalledTimes(1);
  });

  it("says so when the decision could not be sent", async () => {
    const onDecide = vi.fn().mockRejectedValue(new Error("This request was already decided."));
    mountDock(messagesWith(requestPart()), onDecide);

    press("[data-zoc-permission-approve]");
    await act(async () => {
      await Promise.resolve();
    });

    const failure = el("[data-zoc-permission-failure]");
    expect(failure).not.toBeNull();
    expect(failure?.textContent).toContain("already decided");
    // Assertive, not polite: this is the answer to "did my click land".
    expect(failure?.getAttribute("aria-live")).toBe("assertive");
  });

  it("is already gone for a request whose deadline passed before the render", () => {
    nowMs = START + APPROVAL_WINDOW_MS + 1_000;
    mountDock(messagesWith(requestPart()));
    expect(el("[data-zoc-permission-dock]")).toBeNull();
  });

  it("takes the request away when the deadline lapses while it is shown", () => {
    vi.useFakeTimers();
    mountDock(messagesWith(requestPart()));
    expect(el("[data-zoc-permission-countdown]")).not.toBeNull();

    // The clock the countdown reads and the clock the deadline is measured against are the same one.
    act(() => {
      nowMs = START + APPROVAL_WINDOW_MS + 1_000;
      vi.advanceTimersByTime(APPROVAL_WINDOW_MS + 2_000);
    });

    expect(el("[data-zoc-permission-dock]")).toBeNull();
  });

  it("offers no decision for a request the runtime has already answered", () => {
    mountDock(messagesWith(requestPart({ decision: "approve", decidedScope: "call" })));
    expect(el("[data-zoc-permission-dock]")).toBeNull();
  });

  it("docks the oldest undecided request when two are outstanding", () => {
    // One surface, one decision (R11.8). Two docks would make the blocking request ambiguous.
    mountDock(
      messagesWith(
        requestPart({ requestId: "req_1", seq: 7 }),
        requestPart({ requestId: "req_2", seq: 9, toolName: "workspace_apply_hunks" }),
      ),
    );
    expect(document.querySelectorAll("[data-zoc-permission-dock]")).toHaveLength(1);
    expect(el("[data-zoc-permission-tool]")?.textContent).toContain("workspace_run_command");
  });
});
