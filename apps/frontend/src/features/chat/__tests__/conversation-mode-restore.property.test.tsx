/**
 * Property 78: Conversation_Mode round-trips through a Session — zoc-agent-chat-rebuild R32.16,
 * task 22.15.
 *
 * *For any* Session and *any* sequence of submissions carrying Conversation_Modes, closing and reopening
 * that Session restores the mode of the last submission; and for a Session with no submissions it
 * restores `Agent`.
 *
 * ## What this found
 *
 * The write half of R32.16 was already there and the read half was not. `ZocMessageMetadata`'s
 * `conversationMode` carries a comment saying it exists "so a restored Session recovers the mode it last
 * submitted without replaying parts" — and nothing in the tree read it. `resetForSession()` returned the
 * store to `agent` on every switch, so a `Plan`-mode Session reopened in `Agent`: the mode that decides
 * whether files may change, silently widened by navigating away and back. Closing it added
 * `conversationModeOf` and one line in the panel's reset effect.
 *
 * ## Two halves, deliberately
 *
 * The derivation is asserted against the persistence seam (`JSON` plus `restoreTranscript`, which is what
 * the gateway's opaque-JSON storage amounts to), and the wiring is asserted by mounting the panel. Only
 * the second would catch a `conversationModeOf` that is correct and never called — which is precisely the
 * state the tree was in.
 *
 * `store.test.ts` notes this property in passing where it asserts `resetForSession()` yields `agent`.
 * That is one path through the reset, not the round trip; it is referenced rather than repeated.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import fc from "fast-check";
import type { ChatTransport, UIMessageChunk } from "ai";
import type { ConversationMode } from "@zoc-studio/shared-types";

import { ChatPanel, type ChatPanelProps } from "@/features/chat/ChatPanel";
import type { ModelChoice } from "@/features/chat/header/model-catalogue";
import { conversationModeOf } from "@/features/chat/panel-state";
import { restoreTranscript } from "@/features/chat/transcript-persistence";
import { useChatSurface } from "@/features/chat/store";
import type { ZocUIMessage } from "@/features/chat/wire/ui-message";
import { CONVERSATION_MODES } from "./arbitraries";
import { installFakeLayout, metadataOf, resetChatSurface } from "./transcript-harness";

const MODEL: ModelChoice = {
  provider: "anthropic",
  providerLabel: "Anthropic",
  modelId: "claude-opus-5",
  label: "Opus 5",
  requiresKey: true,
  hasKey: true,
  local: false,
  contextLimit: 200_000,
};

class InertTransport implements ChatTransport<ZocUIMessage> {
  sendMessages(): Promise<ReadableStream<UIMessageChunk>> {
    return Promise.resolve(new ReadableStream<UIMessageChunk>({ start: () => {} }));
  }
  reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return Promise.resolve(null);
  }
}

/**
 * A Session's transcript for a sequence of submissions.
 *
 * One user message and one finished assistant turn per submission, the mode on the turn's metadata —
 * which is where the runtime writes it. An empty sequence is a Session that was created and never run,
 * which is the property's second clause.
 */
function transcriptFor(modes: readonly ConversationMode[]): ZocUIMessage[] {
  const messages: ZocUIMessage[] = [];
  modes.forEach((mode, index) => {
    messages.push({
      id: `u${String(index)}`,
      role: "user",
      parts: [{ type: "text", text: `prompt ${String(index)}` }],
    } as ZocUIMessage);
    messages.push({
      id: `a${String(index)}`,
      role: "assistant",
      metadata: metadataOf({ runId: `run_${String(index)}`, conversationMode: mode }),
      parts: [{ type: "text", text: `answer ${String(index)}`, state: "done" }],
    } as ZocUIMessage);
  });
  return messages;
}

/** Store the transcript and hand it back, as the gateway's opaque-JSON store does. */
function reopen(transcript: readonly ZocUIMessage[]): readonly ZocUIMessage[] {
  const stored = JSON.parse(JSON.stringify(transcript)) as readonly unknown[];
  const { messages, skipped } = restoreTranscript(stored);
  expect(skipped, "a turn was dropped on restore, so the mode read is not the Session's").toBe(0);
  return messages;
}

function mountSession(sessionId: string, messages: readonly ZocUIMessage[]): void {
  const props: ChatPanelProps = {
    sessionId,
    sessionTitle: "A session",
    sessions: [],
    workspaceRoot: "/home/dev/archivezip",
    initialMessages: messages,
    models: [MODEL],
    selectedModel: MODEL,
    onSelectModel: vi.fn(),
    permissionMode: "ask",
    onPermissionModeChange: vi.fn(),
    onSelectSession: vi.fn(),
    secretStatus: { backend: "keychain", degraded: false, reason: null },
    transport: new InertTransport(),
  };
  render(<ChatPanel {...props} />);
}

const activeMode = (): string | null =>
  document
    .querySelector<HTMLElement>('[data-zoc-mode-item][data-state="active"]')
    ?.getAttribute("data-zoc-mode-item") ?? null;

const modes = fc.array(fc.constantFrom(...CONVERSATION_MODES), { maxLength: 6 });

let uninstallLayout: () => void;

beforeEach(() => {
  resetChatSurface();
  uninstallLayout = installFakeLayout();
});

afterEach(() => {
  cleanup();
  uninstallLayout();
  vi.restoreAllMocks();
});

describe("Feature: zoc-agent-chat-rebuild, task 22.15 — Property 78: Conversation_Mode restore", () => {
  it("derives the last submission's mode from a stored transcript, and Agent from none (R32.16)", () => {
    fc.assert(
      fc.property(modes, (submitted) => {
        const expected = submitted.at(-1) ?? "agent";
        expect(conversationModeOf(reopen(transcriptFor(submitted)))).toBe(expected);
      }),
      { numRuns: 80 },
    );
  });

  it("reopens the Session in that mode, in the store and in the control", () => {
    fc.assert(
      fc.property(modes, (submitted) => {
        const expected = submitted.at(-1) ?? "agent";
        resetChatSurface();
        try {
          mountSession("session-1", reopen(transcriptFor(submitted)));
          expect(useChatSurface.getState().conversationMode).toBe(expected);
          // And the user can see it: a restored mode the control does not show selected is a mode the
          // user has no way to know they are about to submit in.
          expect(activeMode()).toBe(expected);
        } finally {
          cleanup();
        }
      }),
      { numRuns: 40 },
    );
  });

  it("gives each Session its own mode across a switch, and back", () => {
    // "Closing and reopening" as it actually happens: the panel stays mounted and `sessionId` changes.
    // A single-mount test would pass against a panel that read the mode once and never again.
    const plan = reopen(transcriptFor(["plan"]));
    const ask = reopen(transcriptFor(["ask"]));

    mountSession("session-plan", plan);
    expect(useChatSurface.getState().conversationMode).toBe("plan");
    cleanup();

    mountSession("session-ask", ask);
    expect(useChatSurface.getState().conversationMode).toBe("ask");
    cleanup();

    mountSession("session-plan", plan);
    expect(useChatSurface.getState().conversationMode).toBe("plan");
  });

  it("falls back to Agent for a mode a hand-edited transcript invented", () => {
    // The value arrives off a file on disk. An unrecognised one must not reach the control, which would
    // render a segmented control with nothing selected.
    const transcript = transcriptFor(["plan"]);
    const tampered = JSON.parse(JSON.stringify(transcript)) as ZocUIMessage[];
    (tampered[1] as { metadata: { conversationMode: string } }).metadata.conversationMode = "yolo";
    expect(conversationModeOf(tampered)).toBe("agent");
  });
});
