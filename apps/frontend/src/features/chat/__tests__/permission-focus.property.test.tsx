/**
 * Property 55: An approval request takes focus and announces its subject. R21.3, R11.7, R11.8, R11.9.
 *
 * *For any* pending approval, when the dock renders it: focus moves to the request, the request's
 * accessible name carries the tool and **every** affected path, and the decision can be made from the
 * keyboard alone with the scope the user selected.
 *
 * ## Why "every path" is the clause worth generating over
 *
 * The visible row is one line: it middle-truncates a long path and collapses more than three into
 * `+n more`. That is right for the eye and wrong for the ear — the paths are what a user is being asked
 * to approve, and "+4 more" is exactly the information they need. So the visible collapse and the
 * accessible name disagree on purpose, and the property is what keeps the disagreement in the safe
 * direction: generated path lists run past the collapse threshold and past the truncation length.
 *
 * ## Why "once per request" is asserted rather than assumed
 *
 * Moving focus is correct when the request appears and hostile on every render after that: a user who
 * tabbed into the transcript to read the diff the request is about must not be yanked back by the next
 * text delta. The store's `pendingApprovalId` is what makes "once" true, and a re-render with focus
 * elsewhere is the case that catches its absence.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import fc from "fast-check";

import { ChatMotionProvider } from "@/lib/reduced-motion-provider";
import { PermissionDock } from "@/features/chat/permission/PermissionDock";
import {
  APPROVAL_WINDOW_MS,
  SCOPE_LABELS,
  type ApprovalScope,
} from "@/features/chat/permission/permission-model";
import { useChatSurface } from "@/features/chat/store";
import { assistantMessage, resetChatSurface } from "./transcript-harness";
import type { PermissionRequestPart } from "@zoc-studio/shared-types";
import type { ZocUIMessage } from "@/features/chat/wire/ui-message";

const NOW = Date.parse("2026-07-31T10:00:00.000Z");

beforeEach(() => {
  resetChatSurface();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ── Generators ────────────────────────────────────────────────────────

/** Paths long enough to be truncated and numerous enough to be collapsed. */
const workspacePath = fc
  .array(fc.hexaString({ minLength: 3, maxLength: 14 }), { minLength: 1, maxLength: 5 })
  .map((segments) => `src/${segments.join("/")}.ts`);

const request: fc.Arbitrary<PermissionRequestPart> = fc
  .record({
    toolName: fc.constantFrom(
      "workspace_run_command",
      "workspace_apply_hunks",
      "workspace_run_tests",
    ),
    paths: fc.array(workspacePath, { minLength: 0, maxLength: 6 }),
    reason: fc.constantFrom("mode-ask" as const, "out-of-plan-path" as const, "destructive" as const),
    scopes: fc
      .subarray(["call", "run", "workspace"] as const, { minLength: 1 })
      .map((scopes) => [...scopes]),
    requestId: fc.hexaString({ minLength: 4, maxLength: 10 }).map((id) => `req_${id}`),
  })
  .map(({ toolName, paths, reason, scopes, requestId }) => ({
    type: "permission-request" as const,
    seq: 7,
    runId: "run_1",
    messageId: "assistant-1",
    ts: "2026-07-31T10:00:00.000Z",
    agentName: null,
    requestId,
    toolCallId: `call_${requestId}`,
    toolName,
    kind: "execute" as const,
    prompt: `Allow ${toolName}?`,
    paths,
    reason,
    offeredScopes: scopes,
    expiresAt: new Date(NOW + 9 * 60_000 + 42_000).toISOString(),
    decision: null,
    decidedScope: null,
  }));

function messagesWith(part: PermissionRequestPart): ZocUIMessage[] {
  return [
    {
      id: "assistant-1",
      role: "assistant",
      metadata: assistantMessage("assistant-1", "").metadata,
      parts: [
        { type: "text", text: "I need to run something.", state: "done" },
        { type: "data-zoc-permission", data: part },
      ],
    },
  ];
}

interface Decision {
  requestId: string;
  decision: "approve" | "reject";
  scope: ApprovalScope;
}

interface Harness {
  container: HTMLElement;
  row(): HTMLElement;
  decisions: Decision[];
  setMessages(next: readonly ZocUIMessage[]): void;
  unmount(): void;
}

function renderDock(
  messages: readonly ZocUIMessage[],
  options: { now?: () => number; fail?: Error } = {},
): Harness {
  const decisions: Decision[] = [];
  let current = messages;
  const now = options.now ?? (() => NOW);

  const tree = (list: readonly ZocUIMessage[]) => (
    <ChatMotionProvider budget={null}>
      <PermissionDock
        messages={list}
        now={now}
        onDecide={async (decision) => {
          decisions.push(decision);
          if (options.fail !== undefined) throw options.fail;
        }}
      />
    </ChatMotionProvider>
  );

  const view = render(tree(current));

  return {
    container: view.container,
    row() {
      const element = view.container.querySelector("[data-zoc-permission-row]");
      if (!(element instanceof HTMLElement)) throw new Error("no permission row");
      return element;
    },
    decisions,
    setMessages(next) {
      current = next;
      act(() => {
        view.rerender(tree(current));
      });
    },
    unmount() {
      view.unmount();
    },
  };
}

describe("Feature: zoc-agent-chat-rebuild, Property 55: an approval request takes focus and announces its subject", () => {
  it("moves focus to the request and names the tool and every path (R21.3)", () => {
    fc.assert(
      fc.property(request, (part) => {
        cleanup();
        resetChatSurface();
        const harness = renderDock(messagesWith(part));
        const row = harness.row();

        expect(document.activeElement).toBe(row);

        const name = row.getAttribute("aria-label") ?? "";
        expect(name).toContain(part.toolName);
        for (const path of part.paths) {
          // Every path, in full — not the truncated form the line shows.
          expect(name).toContain(path);
        }

        harness.unmount();
      }),
      { numRuns: 60 },
    );
  });

  it("approves from the keyboard with the selected scope, and rejects with R (R11.7, R11.8)", () => {
    fc.assert(
      fc.property(request, (part) => {
        cleanup();
        resetChatSurface();
        const harness = renderDock(messagesWith(part));

        // The scope the row starts on is the narrowest the request offers.
        const offered = part.offeredScopes;
        const narrowest = (["call", "run", "workspace"] as const).find((scope) =>
          offered.includes(scope),
        );
        expect(narrowest).toBeDefined();

        fireEvent.keyDown(harness.row(), { key: "a" });
        expect(harness.decisions).toEqual([
          { requestId: part.requestId, decision: "approve", scope: narrowest },
        ]);

        // A second key while the first decision is in flight sends nothing. One request is one
        // decision, and the runtime answers a repeat with 409 — so the guard is what keeps a
        // double-press from rendering a failure the user did not cause.
        fireEvent.keyDown(harness.row(), { key: "r" });
        expect(harness.decisions.length).toBe(1);

        harness.unmount();

        // Reject, on its own request, because the guard above means the two cannot share one.
        cleanup();
        resetChatSurface();
        const rejecting = renderDock(messagesWith(part));
        fireEvent.keyDown(rejecting.row(), { key: "r" });
        // A rejection carries the narrowest scope whatever the chips say: there is no such thing as
        // rejecting for a workspace.
        expect(rejecting.decisions).toEqual([
          { requestId: part.requestId, decision: "reject", scope: "call" },
        ]);
        rejecting.unmount();
      }),
      { numRuns: 60 },
    );
  });

  it("sends the scope the user picked, not the default", () => {
    fc.assert(
      fc.property(
        request.filter((part) => part.offeredScopes.length > 1),
        (part) => {
          cleanup();
          resetChatSurface();
          const harness = renderDock(messagesWith(part));

          const wider = part.offeredScopes.at(-1) as ApprovalScope;
          const chip = harness.row().querySelector(`[data-zoc-permission-scope="${wider}"]`);
          expect(chip).not.toBeNull();
          fireEvent.click(chip as HTMLElement);

          // The chip reports itself chosen, and the choice travels with the keyboard approve.
          expect(chip?.getAttribute("aria-checked")).toBe("true");
          fireEvent.keyDown(harness.row(), { key: "a" });
          expect(harness.decisions[0]?.scope).toBe(wider);

          harness.unmount();
        },
      ),
      { numRuns: 40 },
    );
  });

  it("names each offered scope and what it grants (R11.7)", () => {
    fc.assert(
      fc.property(request, (part) => {
        cleanup();
        resetChatSurface();
        const harness = renderDock(messagesWith(part));

        for (const scope of part.offeredScopes) {
          const chip = harness.row().querySelector(`[data-zoc-permission-scope="${scope}"]`);
          expect(chip, `${scope} chip`).not.toBeNull();
          const label = chip?.getAttribute("aria-label") ?? "";
          expect(label).toContain(SCOPE_LABELS[scope]);
          // The label says what the grant *does*, because "This workspace" alone does not say that the
          // grant outlives the Run.
          expect(label.length).toBeGreaterThan(SCOPE_LABELS[scope].length);
        }

        // A scope the runtime did not offer is not on screen: the gate would refuse it.
        for (const scope of ["call", "run", "workspace"] as const) {
          if (part.offeredScopes.includes(scope)) continue;
          expect(harness.row().querySelector(`[data-zoc-permission-scope="${scope}"]`)).toBeNull();
        }

        harness.unmount();
      }),
      { numRuns: 40 },
    );
  });

  it("moves focus once per request, not once per render", () => {
    const part = {
      type: "permission-request" as const,
      seq: 7,
      runId: "run_1",
      messageId: "assistant-1",
      ts: "2026-07-31T10:00:00.000Z",
      agentName: null,
      requestId: "req_first",
      toolCallId: "call_1",
      toolName: "workspace_run_command",
      kind: "execute" as const,
      prompt: "Allow workspace_run_command?",
      paths: ["src/a.ts"],
      reason: "destructive" as const,
      offeredScopes: ["call", "run"] as ("call" | "run" | "workspace")[],
      expiresAt: new Date(NOW + 60_000).toISOString(),
      decision: null,
      decidedScope: null,
    };
    const harness = renderDock(messagesWith(part));
    expect(document.activeElement).toBe(harness.row());
    expect(useChatSurface.getState().pendingApprovalId).toBe("req_first");

    // The user tabs away to read what the request is about.
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();
    expect(document.activeElement).toBe(elsewhere);

    // A delta arrives and the dock re-renders with the same request. Focus must stay where the user put
    // it — this is the assertion that fails if the effect keys on the render rather than on the id.
    harness.setMessages(messagesWith({ ...part }));
    expect(document.activeElement).toBe(elsewhere);

    // A *different* request is a new question, and it does take focus.
    harness.setMessages(messagesWith({ ...part, requestId: "req_second", seq: 9 }));
    expect(document.activeElement).toBe(harness.row());
    expect(useChatSurface.getState().pendingApprovalId).toBe("req_second");

    elsewhere.remove();
    harness.unmount();
  });

  it("counts down to the deadline and stops asking when the window closes (R11.9)", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let clock = NOW;
    const part = {
      type: "permission-request" as const,
      seq: 7,
      runId: "run_1",
      messageId: "assistant-1",
      ts: "2026-07-31T10:00:00.000Z",
      agentName: null,
      requestId: "req_timeout",
      toolCallId: "call_1",
      toolName: "workspace_run_command",
      kind: "execute" as const,
      prompt: "Allow workspace_run_command?",
      paths: [],
      reason: "mode-ask" as const,
      offeredScopes: ["call"] as ("call" | "run" | "workspace")[],
      // Two seconds left, so the countdown is checkable without ten minutes of fake time.
      expiresAt: new Date(NOW + 2_000).toISOString(),
      decision: null,
      decidedScope: null,
    };

    const harness = renderDock(messagesWith(part), { now: () => clock });
    expect(
      harness.container.querySelector("[data-zoc-permission-countdown]")?.textContent,
    ).toBe("0:02 left");

    clock = NOW + 2_500;
    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    // The dock stops rendering the request rather than leaving dead controls: R11.9 makes the
    // cancellation the runtime's, and a dock still asking a question the runtime has answered is worse
    // than one that has moved on.
    expect(harness.container.querySelector("[data-zoc-permission-row]")).toBeNull();
    harness.unmount();
  });

  it("reports a decision the runtime refused", async () => {
    const part = {
      type: "permission-request" as const,
      seq: 7,
      runId: "run_1",
      messageId: "assistant-1",
      ts: "2026-07-31T10:00:00.000Z",
      agentName: null,
      requestId: "req_conflict",
      toolCallId: "call_1",
      toolName: "workspace_run_command",
      kind: "execute" as const,
      prompt: "Allow workspace_run_command?",
      paths: [],
      reason: "mode-ask" as const,
      offeredScopes: ["call"] as ("call" | "run" | "workspace")[],
      expiresAt: new Date(NOW + APPROVAL_WINDOW_MS).toISOString(),
      decision: null,
      decidedScope: null,
    };
    const harness = renderDock(messagesWith(part), {
      fail: new Error("That request has already been decided."),
    });

    await act(async () => {
      fireEvent.keyDown(harness.row(), { key: "a" });
      await Promise.resolve();
    });

    // The answer to "did my click land" belongs beside the thing clicked, which is why the dock owns the
    // call rather than reporting through the panel.
    expect(harness.container.querySelector("[data-zoc-permission-failure]")?.textContent).toBe(
      "That request has already been decided.",
    );
    harness.unmount();
  });
});
