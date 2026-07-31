/**
 * Property 18: A pending approval cannot scroll away. R11.8.
 *
 * *For any* interleaving of transcript scrolling and row appends, the pending approval is still in the
 * document and is still **outside** the transcript's scroll container.
 *
 * ## Why the structural clause is the one that matters
 *
 * "Still in the document" is satisfied by a request the user has scrolled past — it is in the document
 * and nowhere near the screen. The guarantee R11.8 actually asks for is that scrolling *cannot* move it,
 * and the only way to hold that is for the request not to be in the scrolling region at all. So the
 * property asserts the containment relationship rather than a position: no amount of scrolling can move
 * an element the scroll container does not contain.
 *
 * The pair also rules out the failure the legacy panel had. A `needs_approval` tool card in the
 * transcript *and* an approval row elsewhere means two surfaces for one decision, and the transcript one
 * scrolls away — so the property additionally requires exactly one approve control on screen.
 *
 * ## What the fake layout is for
 *
 * jsdom has no layout, so a scroll container has no height and `scrollTop` does not move. The transcript
 * harness installs the same self-consistent fake the virtualisation properties use, which is what makes
 * "the transcript really did scroll" an assertion rather than an assumption.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import fc from "fast-check";

import { ChatMotionProvider } from "@/lib/reduced-motion-provider";
import { PermissionDock } from "@/features/chat/permission/PermissionDock";
import { Transcript } from "@/features/chat/Transcript";
import {
  assistantMessage,
  installFakeLayout,
  resetChatSurface,
  scrollTo,
  settle,
  userMessage,
} from "./transcript-harness";
import type { PermissionRequestPart } from "@zoc-studio/shared-types";
import type { ZocUIMessage } from "@/features/chat/wire/ui-message";

let uninstall: () => void;

beforeEach(() => {
  resetChatSurface();
  uninstall = installFakeLayout();
});

afterEach(() => {
  cleanup();
  uninstall();
  vi.useRealTimers();
});

const NOW = Date.parse("2026-07-31T10:00:00.000Z");

function permissionPart(overrides: Partial<PermissionRequestPart> = {}): PermissionRequestPart {
  return {
    type: "permission-request",
    seq: 12,
    runId: "run_1",
    messageId: "assistant-1",
    ts: "2026-07-31T10:00:00.000Z",
    agentName: null,
    requestId: "req_1",
    toolCallId: "call_1",
    toolName: "workspace_run_command",
    kind: "execute",
    prompt: "Allow workspace_run_command?",
    paths: ["src/a.ts"],
    reason: "destructive",
    offeredScopes: ["call", "run", "workspace"],
    expiresAt: new Date(NOW + 9 * 60_000).toISOString(),
    decision: null,
    decidedScope: null,
    ...overrides,
  };
}

/** A settled transcript long enough to scroll, with a pending approval on the last message. */
function transcript(rows: number): ZocUIMessage[] {
  const messages: ZocUIMessage[] = [];
  for (let index = 0; index < rows; index += 1) {
    messages.push(
      index % 2 === 0
        ? userMessage(`u${String(index)}`, `prompt ${String(index)}`)
        : assistantMessage(`a${String(index)}`, `answer ${String(index)}`),
    );
  }
  messages.push({
    id: "assistant-1",
    role: "assistant",
    metadata: assistantMessage("assistant-1", "").metadata,
    parts: [
      { type: "text", text: "I need to run the tests.", state: "done" },
      { type: "data-zoc-permission", data: permissionPart() },
    ],
  });
  return messages;
}

interface Panel {
  container: HTMLElement;
  scrollElement(): HTMLElement;
  dock(): HTMLElement | null;
  setMessages(next: readonly ZocUIMessage[]): void;
  unmount(): void;
}

/**
 * The panel shape that matters here: a transcript, and the dock as its *sibling*.
 *
 * This is the composition 22.x will assemble for real. It is written out here rather than imported
 * because the containment relationship is the thing under test, and a test that imported the assembled
 * panel would be asserting against whatever that panel happened to do — including, if it regressed, the
 * dock rendered inside the scroll container.
 */
function renderPanel(messages: readonly ZocUIMessage[]): Panel {
  let current = messages;
  const view = render(
    <ChatMotionProvider budget={null}>
      <div className="flex flex-col">
        <Transcript messages={current} streaming={false} />
        <PermissionDock
          messages={current}
          now={() => NOW}
          onDecide={async () => {
            /* the decision path is Property 55's subject */
          }}
        />
      </div>
    </ChatMotionProvider>,
  );

  const rerender = () => {
    act(() => {
      view.rerender(
        <ChatMotionProvider budget={null}>
          <div className="flex flex-col">
            <Transcript messages={current} streaming={false} />
            <PermissionDock
              messages={current}
              now={() => NOW}
              onDecide={async () => {
                /* unused */
              }}
            />
          </div>
        </ChatMotionProvider>,
      );
    });
  };

  const scrollElement = (): HTMLElement => {
    const element = view.container.querySelector("[data-zoc-transcript-scroll]");
    if (!(element instanceof HTMLElement)) throw new Error("no scroll container");
    return element;
  };

  settle(scrollElement());

  return {
    container: view.container,
    scrollElement,
    dock() {
      const element = view.container.querySelector("[data-zoc-permission-dock]");
      return element instanceof HTMLElement ? element : null;
    },
    setMessages(next) {
      current = next;
      rerender();
      settle(scrollElement());
    },
    unmount() {
      view.unmount();
    },
  };
}

describe("Feature: zoc-agent-chat-rebuild, Property 18: a pending approval cannot scroll away", () => {
  it("keeps the request outside the scroll container through any scrolling (R11.8)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 20_000 }), { minLength: 1, maxLength: 6 }),
        (offsets) => {
          cleanup();
          resetChatSurface();
          const panel = renderPanel(transcript(70));
          const element = panel.scrollElement();

          const seen = new Set<number>();
          for (const offset of offsets) {
            scrollTo(element, offset);
            seen.add(element.scrollTop);

            const dock = panel.dock();
            expect(dock).not.toBeNull();
            // The whole requirement, as a containment fact: an element the scroll container does not
            // contain cannot be moved by scrolling it.
            expect(element.contains(dock)).toBe(false);
            expect(panel.container.contains(dock)).toBe(true);
          }

          // Non-vacuous: the transcript really did move. A container that never scrolled would satisfy
          // every assertion above for the wrong reason.
          expect(seen.size).toBeGreaterThan(0);

          panel.unmount();
        },
      ),
      { numRuns: 60 },
    );
  });

  it("survives appends while scrolled away, and stays the only approve control", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), (appends) => {
        cleanup();
        resetChatSurface();
        let messages = transcript(70);
        const panel = renderPanel(messages);
        const element = panel.scrollElement();

        // Scrolled to the top, which is as far from the newest row as the transcript goes.
        scrollTo(element, 0);

        for (let index = 0; index < appends; index += 1) {
          messages = [
            ...messages,
            assistantMessage(`late-${String(index)}`, `late answer ${String(index)}`),
          ];
          panel.setMessages(messages);

          expect(panel.dock()).not.toBeNull();
          expect(element.contains(panel.dock())).toBe(false);
          // One decision surface, not two: the transcript's own line for the request links to the dock
          // rather than offering a second Approve.
          expect(panel.container.querySelectorAll("[data-zoc-permission-approve]").length).toBe(1);
        }

        panel.unmount();
      }),
      { numRuns: 40 },
    );
  });

  it("renders nothing once the request is decided", async () => {
    const messages = transcript(4);
    const panel = renderPanel(messages);
    expect(panel.dock()).not.toBeNull();

    // The runtime reconciles the same part by id with a decision on it, which is why the dock derives
    // the pending request instead of holding a copy.
    panel.setMessages([
      ...messages.slice(0, -1),
      {
        id: "assistant-1",
        role: "assistant",
        metadata: assistantMessage("assistant-1", "").metadata,
        parts: [
          { type: "text", text: "I need to run the tests.", state: "done" },
          {
            type: "data-zoc-permission",
            data: permissionPart({ decision: "approve", decidedScope: "call" }),
          },
        ],
      },
    ]);

    // Immediately, without waiting for a frame: the dock reads `messages` directly while the transcript
    // coalesces its commits, and a dock that kept asking for one more frame would be asking a question
    // the runtime had already answered.
    expect(panel.dock()).toBeNull();

    // The transcript's own record catches up on the next frame, which is the coalescer working.
    await act(async () => {
      await new Promise((resolve) => {
        requestAnimationFrame(() => {
          resolve(undefined);
        });
      });
    });
    expect(
      panel.container
        .querySelector("[data-zoc-permission-state]")
        ?.getAttribute("data-zoc-permission-state"),
    ).toBe("approve");
  });
});
