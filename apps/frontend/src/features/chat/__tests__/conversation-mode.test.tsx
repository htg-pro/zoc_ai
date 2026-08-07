/**
 * Conversation_Mode selection and submission gating — zoc-agent-chat-rebuild R22.1, R32.1, R32.2, R32.6,
 * R32.14, R32.15, R11.10, task 22.13.
 *
 * R22.1 lists ten areas the renderer tests must cover. Task 22.13 named seven of them, and this is one of
 * the three it left out — the only one of those three with no non-optional coverage anywhere else.
 *
 * ## What the five files beside this one leave uncovered
 *
 * `mode-consequence.test.ts` is non-optional and renders nothing: it walks the nine sentences by calling
 * `modeConsequence` directly, so it would pass against a composer that never showed one.
 *
 * The three that do render are all property files, and every property test in this plan is explicitly
 * optional. `mode-axes.property.test.tsx` (Property 76) is the stronger test of *selectability* — nine
 * pairs, both orders, checked against the Capability_Policy. `composer-submission.property.test.tsx`
 * (Property 75) is the stronger test of R32.2, over drafts seeded with the retired prompt router's own
 * vocabulary. `submission-gate.property.test.ts` (Property 77) is the stronger test of the refusal
 * envelope, and it is pure. Delete the optional files, as a fast-MVP run is entitled to, and both mode
 * axes ship with no renderer test at all.
 *
 * So this file is the floor under those three rather than a fourth copy of them: one case per claim, fixed
 * inputs, through the real controls. Where a property already asserts something more strongly, the case
 * here says so and takes the part the property cannot reach.
 *
 * `chat-panel.test.tsx` (task 22.8) covers submission and the queue, but never touches the mode axis —
 * it mounts with the default mode and leaves it there.
 *
 * ## Why every case selects a mode before asserting one
 *
 * The store's default Conversation_Mode is `agent` (A11). A case that asserts the gate "in Agent mode"
 * without pressing anything would pass against a control that is wired to nothing at all, which is the
 * single likeliest way this area breaks. So the mode under test is always reached through the control,
 * and the cases that matter most assert a *transition* — the same mount, the same draft, a different
 * verdict, with the control as the only thing that changed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ConversationMode } from "@zoc-studio/shared-types";

import { ChatMotionProvider } from "@/lib/reduced-motion-provider";
import { Composer, type ComposerSubmission } from "@/features/chat/composer/Composer";
import type { ContextCensus, ModelReference } from "@/features/chat/composer/context-figures";
import { useChatSurface } from "@/features/chat/store";
import { resetChatSurface } from "./transcript-harness";

const MODEL: ModelReference = {
  provider: "anthropic",
  modelId: "claude-opus-5",
  contextLimit: 200_000,
};

const CENSUS: ContextCensus = {
  messagesInContext: 2,
  sessionMessageCount: 2,
  messagesOutOfWindow: 0,
  summaryActive: false,
  consumedTokens: 1_000,
  measuredAgainst: MODEL,
};

const el = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);

const all = (selector: string): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>(selector),
];

interface Mounted {
  readonly input: HTMLTextAreaElement;
  readonly onSubmit: ReturnType<typeof vi.fn>;
  /** The submissions that got through, in order. */
  readonly submissions: () => ComposerSubmission[];
}

/**
 * The composer, and nothing above it.
 *
 * The whole of this area lives here: the control, the gate, the consequence line and the send are one
 * component's, and `ChatPanel` only forwards `workspaceRoot`. Mounting the panel would put a transport and
 * a transcript between the control and the claim.
 */
function mountComposer(
  options: { workspaceRoot?: string | null; streaming?: boolean } = {},
): Mounted {
  const onSubmit = vi.fn();
  const view = render(
    <ChatMotionProvider budget={null}>
      <Composer
        streaming={options.streaming ?? false}
        candidates={[]}
        model={MODEL}
        census={CENSUS}
        permissionMode="ask"
        workspaceRoot={options.workspaceRoot === undefined ? "/workspace" : options.workspaceRoot}
        onSubmit={onSubmit}
      />
    </ChatMotionProvider>,
  );

  const input = view.container.querySelector("[data-zoc-composer-input]");
  if (!(input instanceof HTMLTextAreaElement)) throw new Error("the composer rendered no input");
  return {
    input,
    onSubmit,
    submissions: () => onSubmit.mock.calls.map((call) => call[0] as ComposerSubmission),
  };
}

/**
 * Press a Conversation_Mode item.
 *
 * `mouseDown`, not `click`: Radix `Tabs` activates on `onMouseDown` with button 0, so a bare click leaves
 * the value untouched and every assertion after it reads the previous mode — a failure that looks like the
 * control ignoring the user. The recipe is `mode-axes.property.test.tsx`'s, which found it first.
 */
function selectMode(mode: ConversationMode): void {
  const item = el(`[data-zoc-mode-item="${mode}"]`);
  if (item === null) throw new Error(`the composer offers no mode "${mode}"`);
  fireEvent.mouseDown(item, { button: 0, ctrlKey: false });
}

const activeMode = (): string | null =>
  el('[data-zoc-mode-item][data-state="active"]')?.getAttribute("data-zoc-mode-item") ?? null;

const type = (input: HTMLTextAreaElement, value: string): void => {
  fireEvent.change(input, { target: { value } });
};

/** Both routes to a Run: the control, and the Enter the control cannot speak for. */
const trySend = (input: HTMLTextAreaElement): void => {
  const send = el("[data-zoc-send]");
  if (send !== null) fireEvent.click(send);
  fireEvent.keyDown(input, { key: "Enter" });
};

const sendReason = (): string | null => el("[data-zoc-send-reason]")?.textContent ?? null;

const consequence = (): string => el("[data-zoc-mode-consequence]")?.textContent?.trim() ?? "";

beforeEach(resetChatSurface);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Feature: zoc-agent-chat-rebuild, task 22.13: Conversation_Mode selection (R32.1, R32.2)", () => {
  it("offers the three modes, marks exactly one, and moves the mark to the pressed one", () => {
    const { input } = mountComposer();
    expect(
      all("[data-zoc-mode-item]").map((node) => node.getAttribute("data-zoc-mode-item")),
    ).toEqual(["ask", "plan", "agent"]);
    // The Session opens in `agent` (A11), so this is the state every other case has to move off before it
    // can claim anything.
    expect(activeMode()).toBe("agent");

    selectMode("ask");
    expect(activeMode()).toBe("ask");
    expect(useChatSurface.getState().conversationMode).toBe("ask");
    // Exactly one, in a control whose three items share a name: two marked at once is what a segmented
    // control built out of independent buttons produces.
    expect(all('[data-zoc-mode-item][data-state="active"]')).toHaveLength(1);

    selectMode("plan");
    expect(activeMode()).toBe("plan");
    // Still rendered and still reachable — R32.1 makes the active mode visible at all times, so the
    // control is never traded for a menu.
    expect(all("[data-zoc-mode-item]")).toHaveLength(3);
    expect(input).toBeVisible();
  });

  it("says what each mode does at the point the choice is made", () => {
    mountComposer();
    const labels = all("[data-zoc-mode-item]").map((node) => node.getAttribute("aria-label") ?? "");

    // Three one-word buttons name the modes and explain nothing, and the difference between them is the
    // whole decision. The copy is free to change; carrying no explanation at all is not.
    for (const label of labels) {
      expect(label.length).toBeGreaterThan("Agent".length + 1);
    }
    expect(new Set(labels).size, "two modes describe themselves identically").toBe(3);
    expect(labels[0]).toMatch(/^Ask\./u);
  });

  it("keeps the mode live while a Run streams (R32.1, R8.7)", () => {
    // The composer stays usable during a Run, and the mode axis is part of it: a user who watches an
    // Agent turn go somewhere they did not intend has one control to reach for, and disabling it until
    // the Run ends would be the surface deciding they may not.
    const { input } = mountComposer({ streaming: true });
    selectMode("ask");
    expect(activeMode()).toBe("ask");

    type(input, "stop editing and just explain");
    expect(el("[data-zoc-send]")).not.toBeDisabled();
  });

  it("submits the selected mode, whatever the draft asks for (R32.2)", () => {
    // R32.2 retired `routeModeForPrompt`, which read the draft and quietly rewrote a selected `agent` to
    // `ask`. Property 75 asserts this over generated drafts seeded with that router's vocabulary; this is
    // the non-optional floor under it — one draft, chosen because every word in it is a trigger.
    const { input, submissions } = mountComposer();
    selectMode("ask");
    type(input, "edit src/auth/session.ts, refactor the handler and fix the bug");
    trySend(input);

    expect(submissions()).toHaveLength(1);
    expect(submissions()[0]?.mode).toBe("ask");
    // And the store agrees, so the mode the request carries is the mode the control shows rather than a
    // second copy that drifted.
    expect(useChatSurface.getState().conversationMode).toBe("ask");
  });
});

describe("Feature: zoc-agent-chat-rebuild, task 22.13: submission gating (R32.6, R32.14, R32.15)", () => {
  it("refuses Plan with no folder open, names the mode, and offers the mode that works", () => {
    const { input, onSubmit } = mountComposer({ workspaceRoot: null });
    selectMode("plan");
    type(input, "plan the migration");
    trySend(input);

    expect(onSubmit).not.toHaveBeenCalled();
    expect(el("[data-zoc-send]")).toBeDisabled();
    // The mode, not the missing path: the path is the thing the user does not have, and the mode is the
    // thing they can change. Naming a directory here would also put an absolute path on screen (R32.12).
    expect(sendReason()).toContain("Plan needs a folder open");
    expect(sendReason()).toContain("Ask");
  });

  it("keeps the composer enabled through the refusal, with the draft intact (R32.14, R32.15)", () => {
    // Both requirements end with the same clause, and it is not a detail: the refusal is fixable in one
    // action, and a disabled composer would throw away the sentence the user is about to send once they
    // take it. A refusal is a reason to show, never a reason to disable.
    const { input } = mountComposer({ workspaceRoot: null });
    selectMode("agent");
    type(input, "rename the module everywhere");
    trySend(input);

    expect(input).not.toBeDisabled();
    expect(input.value).toBe("rename the module everywhere");
    expect(all("[data-zoc-mode-item]")).toHaveLength(3);
    // Still editable, which is the part "enabled" actually means to a user.
    type(input, "rename the module everywhere, carefully");
    expect(input.value).toBe("rename the module everywhere, carefully");
  });

  it("sends Ask with no folder open, which a refusal-shaped gate gets backwards (R32.6)", () => {
    // The permit inside the gate. A question about code the user has open in another window is a
    // legitimate Run, and refusing it would make the mode useless in exactly the case it exists for.
    const { input, submissions } = mountComposer({ workspaceRoot: null });
    selectMode("ask");
    type(input, "what does this repository do");
    trySend(input);

    expect(submissions()).toHaveLength(1);
    expect(submissions()[0]?.mode).toBe("ask");
    expect(sendReason()).toBeNull();
  });

  it("lifts the refusal the moment the user switches mode, without retyping", () => {
    // The transition, in one mount: the draft, the workspace and the model are fixed, and the only thing
    // that changes is the control. It is also the case a refusal held in state gets wrong — a sentence
    // stored when send was pressed outlives the condition that produced it, and goes on telling the user
    // to open a folder under a send button that now works.
    const { input, submissions } = mountComposer({ workspaceRoot: null });
    selectMode("agent");
    type(input, "summarise the auth flow");
    trySend(input);
    expect(submissions()).toHaveLength(0);
    expect(sendReason()).toContain("Agent needs a folder open");

    selectMode("ask");
    expect(sendReason(), "the refusal outlived the mode that caused it").toBeNull();
    expect(el("[data-zoc-send]")).not.toBeDisabled();

    trySend(input);
    expect(submissions()).toHaveLength(1);
    expect(submissions()[0]?.text).toBe("summarise the auth flow");
    expect(submissions()[0]?.mode).toBe("ask");
  });

  it("refuses an empty draft in silence, and says so for everything else", () => {
    // The one refusal with no sentence: a user who has typed nothing does not need telling they have
    // typed nothing, and a composer that narrates it does so on every empty draft forever.
    const { input, onSubmit } = mountComposer({ workspaceRoot: null });
    selectMode("agent");
    trySend(input);

    expect(onSubmit).not.toHaveBeenCalled();
    expect(el("[data-zoc-send]")).toBeDisabled();
    expect(sendReason()).toBeNull();

    // And the silence is specific to the empty draft rather than to the mode: the same mode with a draft
    // states its reason.
    type(input, "do the thing");
    expect(sendReason()).toContain("needs a folder open");
  });
});

describe("Feature: zoc-agent-chat-rebuild, task 22.13: the consequence line is wired to the control (R11.10)", () => {
  it("states a consequence for the selected mode and restates it when the mode changes", () => {
    // `mode-consequence.test.ts` asserts the nine sentences against the policy, by calling the function.
    // What is unasserted without a render is the wiring: that the line on screen is a function of the
    // control beside it rather than a sentence chosen once at mount.
    const { input } = mountComposer();

    const lines = new Map<ConversationMode, string>();
    for (const mode of ["ask", "plan", "agent"] as const) {
      selectMode(mode);
      const line = consequence();
      expect(line.length, `no consequence sentence rendered for ${mode}`).toBeGreaterThan(0);
      lines.set(mode, line);
    }

    // Ask cannot change a file and Agent can, so those two sentences cannot be the same one. Asserting
    // the pair rather than all three keeps the claim about the wiring — which pairs differ, and why, is
    // `mode-consequence.test.ts`'s and Property 76's.
    expect(lines.get("ask")).not.toBe(lines.get("agent"));

    // And it survives a draft: the sentence is about the mode, not about what has been typed.
    type(input, "anything at all");
    expect(consequence()).toBe(lines.get("agent"));
  });
});
