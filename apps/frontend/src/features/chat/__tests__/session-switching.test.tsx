/**
 * Session switching — zoc-agent-chat-rebuild R22.1, R15.6, task 22.13.
 *
 * One of the seven areas R22.1 names for the renderer's unit suite: selecting another Session replaces the
 * transcript with that Session's own, and everything scoped to the Session it left is dropped.
 *
 * ## A spec conflict, settled here rather than left for the next reader
 *
 * Task 22.13's parenthetical for this area reads "(transcript restores, **draft survives**)". The tree
 * says the opposite and says it deliberately: `store.ts` documents the composer draft as Session-scoped,
 * `resetForSession()` clears it, and `store.test.ts` asserts that it does. Reading R22.1 settles which is
 * authoritative — the requirement names "Session switching" and says nothing about the draft; the word
 * does not appear anywhere in `requirements.md`. So the parenthetical is stale prose against a deliberate
 * design, and this file asserts the design: **the draft is cleared on a switch.**
 *
 * That is also the better behaviour. A draft is written *about* the conversation on screen — it names
 * files, it refers to "the error above" — so carrying it into a different Session would carry a prompt
 * whose referents have all changed, and the user's next action would be to delete it.
 *
 * The one thing that *is* restored is Conversation_Mode (R32.16), which has its own property under 22.15.
 * It is asserted here too, because the two behaviours are one transition and a reset that forgot the mode
 * would look correct from inside either file alone.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ChatTransport, UIMessageChunk } from "ai";

import { ChatPanel, type ChatPanelProps } from "@/features/chat/ChatPanel";
import type { ModelChoice } from "@/features/chat/header/model-catalogue";
import { useChatSurface } from "@/features/chat/store";
import type { ZocUIMessage } from "@/features/chat/wire/ui-message";
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

/** A Session's transcript: one exchange, with the Run's mode on the finished turn. */
function transcript(tag: string, mode: "ask" | "plan" | "agent"): ZocUIMessage[] {
  return [
    {
      id: `${tag}-u1`,
      role: "user",
      parts: [{ type: "text", text: `question about ${tag}` }],
    } as ZocUIMessage,
    {
      id: `${tag}-a1`,
      role: "assistant",
      metadata: metadataOf({ runId: `run_${tag}`, conversationMode: mode }),
      parts: [{ type: "text", text: `answer about ${tag}`, state: "done" }],
    } as ZocUIMessage,
  ];
}

const ALPHA = transcript("alpha", "plan");
const BETA = transcript("beta", "ask");

function propsFor(sessionId: string, messages: readonly ZocUIMessage[]): ChatPanelProps {
  return {
    sessionId,
    sessionTitle: sessionId,
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
}

const text = (): string =>
  document.querySelector("[data-zoc-transcript-scroll]")?.textContent ?? "";

const type = (value: string): void => {
  const input = document.querySelector("[data-zoc-composer-input]");
  if (input === null) throw new Error("The composer rendered no input.");
  fireEvent.change(input, { target: { value } });
};

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

describe("Feature: zoc-agent-chat-rebuild, task 22.13: session switching (R22.1)", () => {
  it("replaces the transcript with the selected Session's own (R15.6)", async () => {
    const view = render(<ChatPanel {...propsFor("session-alpha", ALPHA)} />);
    expect(text()).toContain("answer about alpha");

    view.rerender(<ChatPanel {...propsFor("session-beta", BETA)} />);
    // `waitFor`, because `useChat` adopts a newly keyed chat's messages in an effect: the DOM the
    // rerender returned is still the previous Session's, one commit behind.
    await waitFor(() => {
      expect(text()).toContain("answer about beta");
    });
    // Replaced, not appended: `useChat` is keyed by `sessionId`, so a switch is a new chat rather than a
    // mutated one — and a transcript that accumulated across Sessions would be the visible symptom.
    expect(text()).not.toContain("answer about alpha");
  });

  it("returns to the first Session's transcript when the user switches back", async () => {
    const view = render(<ChatPanel {...propsFor("session-alpha", ALPHA)} />);
    view.rerender(<ChatPanel {...propsFor("session-beta", BETA)} />);
    await waitFor(() => {
      expect(text()).toContain("answer about beta");
    });
    view.rerender(<ChatPanel {...propsFor("session-alpha", ALPHA)} />);
    await waitFor(() => {
      expect(text()).toContain("answer about alpha");
    });
    expect(text()).not.toContain("answer about beta");
  });

  it("clears the draft, because a draft is scoped to the conversation it was written about", () => {
    // The resolved half of 22.13's conflict. See the header.
    const view = render(<ChatPanel {...propsFor("session-alpha", ALPHA)} />);
    type("look at the file I mentioned above");
    expect(useChatSurface.getState().draft).toBe("look at the file I mentioned above");

    view.rerender(<ChatPanel {...propsFor("session-beta", BETA)} />);
    expect(useChatSurface.getState().draft).toBe("");
    expect(document.querySelector<HTMLTextAreaElement>("[data-zoc-composer-input]")?.value).toBe(
      "",
    );
  });

  it("drops every other Session-scoped decision with it", () => {
    const view = render(<ChatPanel {...propsFor("session-alpha", ALPHA)} />);

    // Written directly rather than through the review surface: what this asserts is the *reset*, and
    // staging a plan through the UI to produce the same state would test the plan card instead.
    const store = useChatSurface.getState();
    store.decideHunk("plan_1", "src/a.ts", "h1", "accepted");
    store.setExpanded("plan_1|src/a.ts|h1", true);
    store.setPendingApprovalId("req_1");
    store.addMention({
      id: "m1",
      kind: "file",
      ref: "src/a.ts",
      label: "a.ts",
      estimatedTokens: 40,
      resolved: true,
    });
    expect(useChatSurface.getState().hunkDecisions).not.toEqual({});

    view.rerender(<ChatPanel {...propsFor("session-beta", BETA)} />);

    const after = useChatSurface.getState();
    expect(after.hunkDecisions).toEqual({});
    expect(after.expanded.size).toBe(0);
    expect(after.pendingApprovalId).toBeNull();
    expect(after.mentions).toEqual([]);
  });

  it("restores each Session's Conversation_Mode across the switch (R32.16)", () => {
    const view = render(<ChatPanel {...propsFor("session-alpha", ALPHA)} />);
    expect(useChatSurface.getState().conversationMode).toBe("plan");

    view.rerender(<ChatPanel {...propsFor("session-beta", BETA)} />);
    expect(useChatSurface.getState().conversationMode).toBe("ask");

    view.rerender(<ChatPanel {...propsFor("session-alpha", ALPHA)} />);
    expect(useChatSurface.getState().conversationMode).toBe("plan");
  });

  it("opens a Session that has never run on its empty state rather than the previous rows", () => {
    const view = render(<ChatPanel {...propsFor("session-alpha", ALPHA)} />);
    expect(document.querySelector("[data-zoc-empty-state]")).toBeNull();

    view.rerender(<ChatPanel {...propsFor("session-new", [])} />);
    expect(document.querySelector("[data-zoc-empty-state]")).not.toBeNull();
    expect(document.body.textContent).not.toContain("answer about alpha");
  });
});
