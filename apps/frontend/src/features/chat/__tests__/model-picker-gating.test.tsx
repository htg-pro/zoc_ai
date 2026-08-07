/**
 * Model-picker gating — zoc-agent-chat-rebuild R22.1, R13.2, R13.3, R13.4, task 22.13.
 *
 * The last of R22.1's seven areas, and 22.13 names the whole of it in one clause: "`hasKey` false blocks
 * send and offers key entry".
 *
 * ## What the two files beside this one leave uncovered
 *
 * `model-gating.property.test.ts` (Property 30) is the pure layer — `isSubmittable`, `gateReasonOf`,
 * `keyBadgeOf` over generated models — and it is the stronger test of the *rule*. It renders nothing, so it
 * cannot say whether any code path consults it. `chat-panel.test.tsx` (task 22.8) covers the empty state's
 * half: with no messages yet, the suggestions are replaced by a key-entry control. Neither one sends.
 *
 * So the clause's first verb had no coverage at any level, and writing this file found it unimplemented:
 * `ChatPanel` gated submission on `selectedModel === null` alone, so a keyless cloud model rendered an
 * enabled composer whose Enter key reached the transport. The gate is now in three places — the send
 * control, `send()` itself, and the queue drain — and the cases below are why each one is needed rather
 * than one of them.
 *
 * ## Why the assertion is "the transport was never asked", not "the button was disabled"
 *
 * A disabled button is the appearance of a gate. `ComposerInput` calls the same `send()` on Enter, and the
 * textarea is not disabled for a keyless model — deliberately, because the fix is a key and throwing the
 * draft away would punish the user for the vault's state. So the keyboard path is the one that would have
 * shipped broken, and every case here presses Enter as well as reading the control.
 *
 * ## Why a local model is asserted through the panel and not only through `isSubmittable`
 *
 * R13.4 is the branch a gate written as "block unless a key exists" gets backwards, and Property 30 already
 * asserts the predicate. What it cannot assert is that the panel's three call sites all read the predicate
 * rather than `hasKey` — and a keyless *local* model is the only fixture that tells those two apart.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ChatTransport, UIMessageChunk } from "ai";

import { ChatPanel, type ChatPanelProps } from "@/features/chat/ChatPanel";
import { ModelPicker } from "@/features/chat/header/ModelPicker";
import type { ModelChoice } from "@/features/chat/header/model-catalogue";
import type { SecretStatus } from "@/lib/secure-store";
import type { ZocUIMessage } from "@/features/chat/wire/ui-message";
import { resetChatSurface } from "./transcript-harness";

/** Records what it was asked to send, and leaves the Run open so nothing settles on its own. */
class FakeTransport implements ChatTransport<ZocUIMessage> {
  readonly sent: string[] = [];

  sendMessages(opts: { messages: ZocUIMessage[] }): Promise<ReadableStream<UIMessageChunk>> {
    const last = opts.messages[opts.messages.length - 1];
    this.sent.push(
      (last?.parts ?? [])
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join(""),
    );
    return Promise.resolve(new ReadableStream<UIMessageChunk>({ start: () => {} }));
  }

  reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return Promise.resolve(null);
  }
}

const CLOUD_WITH_KEY: ModelChoice = {
  provider: "anthropic",
  providerLabel: "Anthropic",
  modelId: "claude-opus-5",
  label: "Opus 5",
  requiresKey: true,
  hasKey: true,
  local: false,
  contextLimit: 200_000,
};

const CLOUD_WITHOUT_KEY: ModelChoice = { ...CLOUD_WITH_KEY, hasKey: false };

/** A second provider, so "which provider needs the key" is a question with a wrong answer available. */
const OTHER_WITHOUT_KEY: ModelChoice = {
  provider: "openai",
  providerLabel: "OpenAI",
  modelId: "gpt-5",
  label: "GPT-5",
  requiresKey: true,
  hasKey: false,
  local: false,
  contextLimit: 400_000,
};

/**
 * The bundled `llama-server` path: no key required and none present (R13.4).
 *
 * `hasKey: false` is the point — a gate reading that field instead of `requiresKey` would block this model,
 * which is the case A6's zero-key offline promise rests on.
 */
const LOCAL_MODEL: ModelChoice = {
  provider: "local-llamacpp",
  providerLabel: "Local",
  modelId: "qwen3-8b",
  label: "Qwen3 8B",
  requiresKey: false,
  hasKey: false,
  local: true,
  fit: "fits",
  contextLimit: 32_768,
};

const HEALTHY_SECRETS: SecretStatus = { backend: "keychain", degraded: false, reason: null };

const el = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);

const all = (selector: string): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>(selector),
];

const press = (selector: string): void => {
  const node = el(selector);
  if (node === null) throw new Error(`no control matched ${selector}`);
  fireEvent.click(node);
};

beforeEach(resetChatSurface);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── The picker's rows (R13.2, R13.3) ─────────────────────────────────

/** Radix `Popover` opens on click, and the content is portalled — so the queries below read `document`. */
function openPicker(models: readonly ModelChoice[], onAddKey?: () => void) {
  const onSelect = vi.fn();
  render(
    <ModelPicker
      models={models}
      selected={models[0] ?? null}
      onSelect={onSelect}
      {...(onAddKey === undefined ? {} : { onAddKey })}
    />,
  );
  press("[data-zoc-model-picker]");
  return { onSelect };
}

describe("Feature: zoc-agent-chat-rebuild, task 22.13: the model picker's key state (R13.2)", () => {
  it("badges the keyless rows and offers each one a route to its own provider's key", () => {
    const onAddKey = vi.fn();
    openPicker([CLOUD_WITH_KEY, OTHER_WITHOUT_KEY], onAddKey);

    expect(el("[data-zoc-model-popover]")).not.toBeNull();
    expect(all("[data-zoc-model-item]")).toHaveLength(2);

    // The badge is on the row that lacks the key and on no other: the absence of the warning is the
    // signal, and a tick beside every configured row is decoration.
    expect(el('[data-zoc-model-item="gpt-5"]')?.getAttribute("data-zoc-model-key-badge")).toBe(
      "key-missing",
    );
    expect(
      el('[data-zoc-model-item="claude-opus-5"]')?.hasAttribute("data-zoc-model-key-badge"),
    ).toBe(false);

    // One route, on the row that reports the problem (R13.3), named for its provider because the key is
    // per provider rather than per model.
    const addKey = all("[data-zoc-model-add-key]");
    expect(addKey).toHaveLength(1);
    expect(addKey[0]?.getAttribute("aria-label")).toBe("Add an API key for OpenAI");
    fireEvent.click(addKey[0] as HTMLElement);
    expect(onAddKey).toHaveBeenCalledWith("openai");
  });

  it("takes the key route without also switching the model", () => {
    // `stopPropagation` on the row's button, and the reason it is there: a user who wants to add a key has
    // not asked to run against the model they cannot run yet, and selecting it would leave them gated.
    const { onSelect } = openPicker([CLOUD_WITH_KEY, OTHER_WITHOUT_KEY], vi.fn());
    press('[data-zoc-model-add-key="openai"]');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("still lets a keyless model be selected, because the picker is not the gate", () => {
    // R13.3 blocks the *Run*, not the selection. Refusing the row would leave a user unable to see which
    // models they could use if they added a key, which is the question the picker exists to answer.
    const { onSelect } = openPicker([OTHER_WITHOUT_KEY, CLOUD_WITH_KEY]);
    press('[data-zoc-model-item="gpt-5"]');
    expect(onSelect).toHaveBeenCalledWith(OTHER_WITHOUT_KEY);
  });

  it("reports the missing key with no route at all when the host supplied no handler", () => {
    // The read-only viewer's row (R1.4): `ChatPanel` withholds `onAddKey` from a viewer, because nobody
    // opens Settings on someone else's machine. R13.2's report survives that — which providers lack a key
    // is the question the picker answers — but R13.3's affordance does not, so the badge is inert text
    // rather than a button that calls nothing.
    openPicker([OTHER_WITHOUT_KEY]);
    const row = el('[data-zoc-model-item="gpt-5"]');
    expect(row?.getAttribute("data-zoc-model-key-badge")).toBe("key-missing");

    expect(el("[data-zoc-model-add-key]")).toBeNull();
    // Absent, not disabled, and not silent: the state is still said in a word (R21.7).
    expect(row?.querySelector("button")).toBeNull();
    expect(el("[data-zoc-model-key-missing]")?.textContent).toContain("No key");
  });

  it("offers the route in place of the badge text when a handler exists", () => {
    // The same row for a host, so the two branches are asserted against each other rather than each on
    // its own: exactly one of them renders, and which one is decided by the handler alone.
    openPicker([OTHER_WITHOUT_KEY], vi.fn());
    expect(el("[data-zoc-model-key-missing]")).toBeNull();
    expect(el('[data-zoc-model-add-key="openai"]')).not.toBeNull();
  });
});

// ── The send gate (R13.3, R13.4) ─────────────────────────────────────

interface PanelHandle {
  readonly transport: FakeTransport;
  readonly onAddKey: ReturnType<typeof vi.fn>;
  readonly rerenderWith: (model: ModelChoice) => void;
}

function renderPanel(
  model: ModelChoice | null,
  overrides: Partial<ChatPanelProps> = {},
): PanelHandle {
  const transport = new FakeTransport();
  const onAddKey = vi.fn();
  const propsFor = (selected: ModelChoice | null): ChatPanelProps => ({
    sessionId: "session-1",
    sessionTitle: "A session",
    sessions: [],
    workspaceRoot: "/home/dev/archivezip",
    models: selected === null ? [] : [selected],
    selectedModel: selected,
    onSelectModel: vi.fn(),
    permissionMode: "ask",
    onPermissionModeChange: vi.fn(),
    onSelectSession: vi.fn(),
    secretStatus: HEALTHY_SECRETS,
    transport,
    onAddKey,
    ...overrides,
  });

  const view = render(<ChatPanel {...propsFor(model)} />);
  return {
    transport,
    onAddKey,
    rerenderWith: (next) => {
      view.rerender(<ChatPanel {...propsFor(next)} />);
    },
  };
}

/** Type into the composer without going through the send control. */
function type(value: string): HTMLTextAreaElement {
  const input = el("[data-zoc-composer-input]");
  if (!(input instanceof HTMLTextAreaElement))
    throw new Error("the panel rendered no composer input");
  fireEvent.change(input, { target: { value } });
  return input;
}

/** Both routes to a Run: the control, and the Enter the control cannot speak for. */
function trySend(input: HTMLTextAreaElement): void {
  const send = el("[data-zoc-send]");
  if (send !== null) fireEvent.click(send);
  fireEvent.keyDown(input, { key: "Enter" });
}

const sendReason = (): string => el("[data-zoc-send-reason]")?.textContent ?? "";

describe("Feature: zoc-agent-chat-rebuild, task 22.13: a keyless model blocks the Run (R13.3)", () => {
  it("opens no Run from either the control or the keyboard, and says which provider needs the key", async () => {
    const { transport } = renderPanel(CLOUD_WITHOUT_KEY);
    const input = type("explain the store");
    trySend(input);

    // The claim, and it is about the transport rather than about the button: `send()` is reachable from
    // Enter, so a gate that only disabled the control would have let this through.
    await waitFor(() => {
      expect(transport.sent).toHaveLength(0);
    });
    expect(el("[data-zoc-send]")).toBeDisabled();
    // The provider, not the model: the key is per provider, and naming the model would send the user
    // looking for a per-model setting that does not exist.
    expect(sendReason()).toContain("Anthropic needs an API key");
    expect(sendReason()).not.toContain("claude-opus-5");
    // And the draft is still there. Disabling the textarea would have thrown away the sentence the user
    // will send the moment the key lands, which is a worse outcome than the gate it implements.
    expect(input.value).toBe("explain the store");
  });

  it("still blocks once the Session has a transcript, where the empty state is gone", async () => {
    // The state 22.8's empty-state cases cannot reach: the key-entry control they assert is unmounted as
    // soon as there is a message, and the composer is the only surface left. A gate that lived in the
    // empty state would report nothing here — and would send.
    const restored: readonly ZocUIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] } as ZocUIMessage,
    ];
    const { transport, onAddKey } = renderPanel(CLOUD_WITHOUT_KEY, { initialMessages: restored });
    expect(el("[data-zoc-empty-state]")).toBeNull();

    const input = type("carry on");
    trySend(input);
    await waitFor(() => {
      expect(transport.sent).toHaveLength(0);
    });
    expect(sendReason()).toContain("Anthropic needs an API key");

    // The route to key entry survives the empty state, in the header where the key state is reported.
    press("[data-zoc-model-picker]");
    press('[data-zoc-model-add-key="anthropic"]');
    expect(onAddKey).toHaveBeenCalledWith("anthropic");
  });

  it("lifts the moment a key arrives, without the user retyping or reloading", async () => {
    const { transport, rerenderWith } = renderPanel(CLOUD_WITHOUT_KEY);
    const input = type("explain the store");
    trySend(input);
    await waitFor(() => {
      expect(transport.sent).toHaveLength(0);
    });

    // Desktop_Core answered `hasKey: true` for the same provider, which is all that changed.
    rerenderWith(CLOUD_WITH_KEY);
    expect(el("[data-zoc-send-reason]")).toBeNull();
    expect(el("[data-zoc-send]")).not.toBeDisabled();

    fireEvent.keyDown(type("explain the store"), { key: "Enter" });
    await waitFor(() => {
      expect(transport.sent).toEqual(["explain the store"]);
    });
  });

  it("sends a local model with no key at all (R13.4)", async () => {
    // The branch a gate reading `hasKey` alone gets backwards, through the panel's own three call sites
    // rather than through the predicate Property 30 already covers.
    const { transport } = renderPanel(LOCAL_MODEL);
    expect(el("[data-zoc-send-reason]")).toBeNull();

    fireEvent.keyDown(type("summarise this repo"), { key: "Enter" });
    await waitFor(() => {
      expect(transport.sent).toEqual(["summarise this repo"]);
    });
  });

  it("blocks with a key-shaped reason rather than a mode-shaped one", async () => {
    // Two things are wrong at once: no key, and `Agent` with no folder open. The key is the one the user
    // cannot fix from the composer, so reporting the workspace instead would name the second problem and
    // leave them fixing it to no effect.
    const { transport } = renderPanel(CLOUD_WITHOUT_KEY, { workspaceRoot: null });
    const input = type("do the thing");
    trySend(input);

    await waitFor(() => {
      expect(transport.sent).toHaveLength(0);
    });
    expect(sendReason()).toContain("Anthropic needs an API key");
    expect(sendReason()).not.toContain("folder");
  });
});
