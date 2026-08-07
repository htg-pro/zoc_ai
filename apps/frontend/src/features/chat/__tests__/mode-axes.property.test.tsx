/**
 * Property 76: All nine mode combinations are selectable and the consequence sentence is derived —
 * zoc-agent-chat-rebuild R11.10, R32.1, task 22.14.
 *
 * *For any* pair of the three Conversation_Modes and the three Permission_Modes — all nine — both values
 * are selectable independently, a non-empty consequence sentence renders, and that sentence's claim about
 * whether files may change agrees with the Capability_Policy verdict for `write` in that mode composed
 * with the permission matrix for that Permission_Mode.
 *
 * ## Enumerated, not sampled
 *
 * Nine is the entire product of the two axes, so there is nothing to sample: every combination gets its
 * own case, and a failure names the pair rather than a seed.
 *
 * ## Why it mounts the panel instead of calling `modeConsequence`
 *
 * `mode-consequence.test.ts` already walks the nine derivations at the unit level, and repeating that
 * here would assert the same function twice. What is unasserted without this file is the claim task 22.14
 * actually makes: that the nine pairs are **selectable** — the two controls live in different components
 * (the composer owns Conversation_Mode, the header owns Permission_Mode, deliberately, 22.2) and share a
 * Radix primitive and a keyboard model, so "setting one changes the other" is a live failure mode rather
 * than a hypothetical. Each pair is therefore selected in **both orders** through the real controls.
 *
 * ## Why the expectation is recomputed from `checkCapability`
 *
 * Reading the expected sentence from `modeConsequence` would make the test a tautology, and hard-coding
 * nine strings would make it a copy of the copy. So the test asks the **policy** whether `write` is
 * permitted, composes the Permission_Mode itself, and then requires the rendered sentence to agree. A
 * sentence table that drifted from the gate fails here, which is the whole point of the property.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import type { ChatTransport, UIMessageChunk } from "ai";
import type { ConversationMode } from "@zoc-studio/shared-types";
import { checkCapability } from "@zoc-studio/agent-runtime/policy";

import { ChatPanel, type ChatPanelProps } from "@/features/chat/ChatPanel";
import type { ModelChoice } from "@/features/chat/header/model-catalogue";
import {
  CONVERSATION_MODES,
  PERMISSION_MODES,
  type PermissionMode,
} from "@/features/chat/composer/mode-consequence";
import { useChatSurface } from "@/features/chat/store";
import type { ZocUIMessage } from "@/features/chat/wire/ui-message";
import { installFakeLayout, resetChatSurface } from "./transcript-harness";

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
 * The panel with Permission_Mode held in state.
 *
 * Permission_Mode is a prop the shell owns (R11.1 makes it a standing policy that outlives a Session), so
 * a bare `ChatPanel` would render the toggle and never change value when it is pressed. Holding it here
 * is what makes "selectable" a claim about the control rather than about the prop.
 */
function Harness({ initial }: { initial: PermissionMode }) {
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(initial);
  const props: ChatPanelProps = {
    sessionId: "session-1",
    sessionTitle: "A session",
    sessions: [],
    workspaceRoot: "/home/dev/archivezip",
    models: [MODEL],
    selectedModel: MODEL,
    onSelectModel: vi.fn(),
    permissionMode,
    onPermissionModeChange: setPermissionMode,
    onSelectSession: vi.fn(),
    secretStatus: { backend: "keychain", degraded: false, reason: null },
    transport: new InertTransport(),
  };
  return <ChatPanel {...props} />;
}

const el = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);

/**
 * Press a Radix `Tabs` trigger.
 *
 * `mouseDown`, not `click`: Radix activates a tab on `onMouseDown` with button 0, so a bare `click` event
 * leaves the value untouched — which reads in a failure as "the control ignored the selection" and sent me
 * looking at the wrong component once already. Both controls share the primitive (22.2), so both are
 * pressed the same way.
 */
const press = (item: HTMLElement): void => {
  fireEvent.mouseDown(item, { button: 0, ctrlKey: false });
};

const selectConversation = (mode: ConversationMode): void => {
  const item = el(`[data-zoc-mode-item="${mode}"]`);
  expect(item, `the composer offers no Conversation_Mode "${mode}"`).not.toBeNull();
  press(item as HTMLElement);
};

const selectPermission = (mode: PermissionMode): void => {
  const item = el(`[data-zoc-approval-item="${mode}"]`);
  expect(item, `the header offers no Permission_Mode "${mode}"`).not.toBeNull();
  press(item as HTMLElement);
};

const activeConversation = (): string | null =>
  el('[data-zoc-mode-item][data-state="active"]')?.getAttribute("data-zoc-mode-item") ?? null;

const activePermission = (): string | null =>
  el("[data-zoc-approval-control]")?.getAttribute("data-zoc-approval-control") ?? null;

const sentence = (): string => el("[data-zoc-mode-consequence]")?.textContent?.trim() ?? "";

/** A sentence that tells the user no file can change, in either of the two ways the copy says it. */
const claimsNoChangeIsPossible = (line: string): boolean =>
  /cannot change anything|Every change is refused/u.test(line);

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

describe("Feature: zoc-agent-chat-rebuild, task 22.14 — Property 76: the two mode axes", () => {
  for (const conversation of CONVERSATION_MODES) {
    for (const permission of PERMISSION_MODES) {
      // The expectation, from the policy the gate enforces rather than from the copy under test.
      const mayChangeNow = checkCapability(conversation, false, "write").permitted;
      const mayChangeAfterApproval = checkCapability(conversation, true, "write").permitted;
      const approvalIsInert = !mayChangeNow && !mayChangeAfterApproval;
      const mayEverChange = !approvalIsInert && permission !== "deny";

      it(`selects ${conversation} × ${permission} independently and derives its sentence`, () => {
        // Start from a pair that is not the one under test, so both selections are real transitions.
        render(<Harness initial={permission === "auto" ? "ask" : "auto"} />);

        // Order one: Conversation_Mode, then Permission_Mode.
        selectConversation(conversation);
        selectPermission(permission);
        expect(activeConversation(), "selecting Approval moved Conversation_Mode").toBe(
          conversation,
        );
        expect(activePermission(), "Approval did not take the selection").toBe(permission);
        expect(useChatSurface.getState().conversationMode).toBe(conversation);

        const first = sentence();
        expect(first.length, "no consequence sentence rendered").toBeGreaterThan(0);
        expect(
          claimsNoChangeIsPossible(first),
          `"${first}" disagrees with the policy for ${conversation} × ${permission}`,
        ).toBe(!mayEverChange);

        // R11.6 survives `auto`, and it is the qualification a user reading "without asking" needs.
        if (permission === "auto" && mayEverChange) {
          expect(first).toContain("Destructive actions still ask.");
        }

        cleanup();
        resetChatSurface();

        // Order two: Permission_Mode, then Conversation_Mode. The two controls share a primitive and a
        // keyboard model, so the reverse order is a distinct claim rather than a restatement.
        render(<Harness initial={permission === "auto" ? "ask" : "auto"} />);
        selectPermission(permission);
        selectConversation(conversation);
        expect(activePermission(), "selecting Conversation_Mode moved Approval").toBe(permission);
        expect(activeConversation(), "Conversation_Mode did not take the selection").toBe(
          conversation,
        );

        // And the sentence is a function of the pair, not of the order it was reached in.
        expect(sentence()).toBe(first);
      });
    }
  }

  it("reads the same sentence for all three Approval values under Ask", () => {
    // The fact the nine-case walk above is easy to read past: under `Ask` nothing beyond `read` is
    // permitted in either approval state, so Approval has nothing to gate and the three pairs are equal —
    // and they are equal *because the policy says so*, not because a table repeats a string.
    expect(checkCapability("ask", false, "write").permitted).toBe(false);
    expect(checkCapability("ask", true, "write").permitted).toBe(false);

    const lines = PERMISSION_MODES.map((permission) => {
      resetChatSurface();
      render(<Harness initial={permission === "auto" ? "ask" : "auto"} />);
      selectConversation("ask");
      selectPermission(permission);
      const line = sentence();
      cleanup();
      return line;
    });

    expect(new Set(lines).size, `Ask read differently across Approval: ${lines.join(" | ")}`).toBe(
      1,
    );
    expect(lines[0]).toContain("Approval does not apply");
  });
});
