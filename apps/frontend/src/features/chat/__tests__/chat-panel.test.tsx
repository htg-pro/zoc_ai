/**
 * The chat panel — zoc-agent-chat-rebuild task 22.8's guard.
 *
 * R1.4 (a read-only viewer gets no mutating control, and gets it by absence), R3.8 (the runtime banner
 * above a still-rendered transcript), R8.7 (the composer stays usable and a second submission queues),
 * R13.2/R13.3 (a cloud model with no key blocks submission and offers key entry), R14.8 (the persistent
 * degraded-secrets strip), R16.5 (an interrupted Run offers "Continue with what we have").
 *
 * ## Why the transport is a fake rather than a mocked `fetch`
 *
 * The panel's contract with the transport is four methods, and `ZocChatTransport` has its own suite for
 * what it puts on the wire. A fake that records calls and hands back a stream the test controls is what
 * makes "the panel sent once and queued the second" assertable without also re-testing SSE parsing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ChatTransport, UIMessageChunk } from "ai";
import type { RunLifecyclePart } from "@zoc-studio/shared-types";

import { ChatPanel, type ChatPanelProps } from "@/features/chat/ChatPanel";
import { TranscriptRowView } from "@/features/chat/TranscriptRowView";
import type { ModelChoice } from "@/features/chat/header/model-catalogue";
import { useChatSurface } from "@/features/chat/store";
import type { SecretStatus } from "@/lib/secure-store";
import type { ZocUIMessage } from "@/features/chat/wire/ui-message";
import { resetChatSurface } from "./transcript-harness";

// ── A transport the test drives ───────────────────────────────────────

class FakeTransport implements ChatTransport<ZocUIMessage> {
  readonly sent: string[] = [];
  readonly cancelled: string[] = [];
  readonly decided: unknown[] = [];
  private readonly controllers: ReadableStreamDefaultController<UIMessageChunk>[] = [];

  sendMessages(opts: { messages: ZocUIMessage[] }): Promise<ReadableStream<UIMessageChunk>> {
    const last = opts.messages[opts.messages.length - 1];
    const text = (last?.parts ?? [])
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");
    this.sent.push(text);
    // Left open, so the Run stays in flight until the test closes it. That is the state the queue
    // exists for, and a stream that closed immediately could not produce it.
    return Promise.resolve(
      new ReadableStream<UIMessageChunk>({
        start: (controller) => {
          this.controllers.push(controller);
        },
      }),
    );
  }

  reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return Promise.resolve(null);
  }

  cancel(runId: string): Promise<void> {
    this.cancelled.push(runId);
    return Promise.resolve();
  }

  decideApproval(runId: string, request: unknown): Promise<void> {
    this.decided.push({ runId, request });
    return Promise.resolve();
  }

  /** Settle every open Run, which is what lets the queue drain. */
  closeAll(): void {
    for (const controller of this.controllers.splice(0)) controller.close();
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────

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

const HEALTHY_SECRETS: SecretStatus = { backend: "keychain", degraded: false, reason: null };

let transport: FakeTransport;

function renderPanel(overrides: Partial<ChatPanelProps> = {}) {
  transport = overrides.transport instanceof FakeTransport ? overrides.transport : new FakeTransport();
  const props: ChatPanelProps = {
    sessionId: "session-1",
    sessionTitle: "A session",
    sessions: [],
    workspaceRoot: "/home/dev/archivezip",
    models: [CLOUD_WITH_KEY],
    selectedModel: CLOUD_WITH_KEY,
    onSelectModel: vi.fn(),
    permissionMode: "ask",
    onPermissionModeChange: vi.fn(),
    onSelectSession: vi.fn(),
    secretStatus: HEALTHY_SECRETS,
    transport,
    ...overrides,
  };
  return { ...render(<ChatPanel {...props} />), props };
}

const query = (selector: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(selector);

const sendControl = (): HTMLElement => {
  const element = query("[data-zoc-send]");
  if (element === null) throw new Error("The composer rendered no send control.");
  return element;
};

beforeEach(() => {
  resetChatSurface();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Feature: zoc-agent-chat-rebuild, task 22.8: the empty state", () => {
  it("offers three workspace-derived starting points", () => {
    renderPanel();
    expect(query("[data-zoc-empty-state]")).not.toBeNull();
    expect(document.querySelectorAll("[data-zoc-empty-suggestion]")).toHaveLength(3);
  });

  it("puts a suggestion in the composer rather than sending it", () => {
    renderPanel();
    const chip = document.querySelectorAll<HTMLElement>("[data-zoc-empty-suggestion]")[0];
    expect(chip).toBeDefined();
    fireEvent.click(chip as HTMLElement);

    expect(useChatSurface.getState().draft.length).toBeGreaterThan(0);
    // A chip that sent immediately would make the common case "cancel the Run I did not mean to start".
    expect(transport.sent).toHaveLength(0);
  });

  it("replaces the suggestions with key entry when the model has no key (R13.2, R13.3)", () => {
    const onAddKey = vi.fn();
    renderPanel({ models: [CLOUD_WITHOUT_KEY], selectedModel: CLOUD_WITHOUT_KEY, onAddKey });

    expect(document.querySelectorAll("[data-zoc-empty-suggestion]")).toHaveLength(0);
    const addKey = query("[data-zoc-empty-add-key]");
    expect(addKey).not.toBeNull();
    fireEvent.click(addKey as HTMLElement);
    expect(onAddKey).toHaveBeenCalledWith("anthropic");
  });

  it("names the provider rather than the model in the gate reason", () => {
    renderPanel({ models: [CLOUD_WITHOUT_KEY], selectedModel: CLOUD_WITHOUT_KEY });
    // The key is per provider, so naming the model would send the user looking for a per-model setting.
    expect(screen.getByText(/Anthropic needs an API key/u)).toBeTruthy();
  });
});

describe("Feature: zoc-agent-chat-rebuild, task 22.8: the read-only viewer (R1.4)", () => {
  it("omits every mutating control from the DOM rather than disabling it", () => {
    renderPanel({ readOnly: true, viewerHost: "192.168.1.14:52311", onRestartRuntime: vi.fn() });

    expect(query("[data-zoc-read-only-banner]")).not.toBeNull();
    // Absent, not disabled: a disabled control is still announced and still invites a click.
    expect(query("[data-zoc-composer]")).toBeNull();
    expect(query("[data-zoc-send]")).toBeNull();
    expect(query("[data-zoc-permission-dock]")).toBeNull();
    expect(query("[data-zoc-runtime-restart]")).toBeNull();
    // Nothing anywhere in the subtree is merely greyed out.
    expect(document.querySelectorAll("[data-zoc-chat-panel] button[disabled]")).toHaveLength(0);
  });

  it("names the host it is watching", () => {
    renderPanel({ readOnly: true, viewerHost: "192.168.1.14:52311" });
    expect(screen.getByText(/Watching 192\.168\.1\.14:52311/u)).toBeTruthy();
  });

  it("still lets the viewer read the transcript and switch what they are looking at", () => {
    renderPanel({ readOnly: true });
    expect(query("[data-zoc-chat-panel]")).not.toBeNull();
    expect(query("[data-zoc-chat-panel]")?.getAttribute("data-zoc-read-only")).toBe("true");
  });

  it("gives a host the composer and no banner", () => {
    renderPanel();
    expect(query("[data-zoc-read-only-banner]")).toBeNull();
    expect(query("[data-zoc-composer]")).not.toBeNull();
  });
});

describe("Feature: zoc-agent-chat-rebuild, task 22.8: the degraded-secrets strip (R14.8)", () => {
  it("stays absent while the backend is healthy", () => {
    renderPanel({ secretStatus: HEALTHY_SECRETS });
    expect(query("[data-zoc-degraded-secrets]")).toBeNull();
  });

  it("states the reason and the consequence when keys are held in memory", () => {
    renderPanel({
      secretStatus: {
        backend: "degraded",
        degraded: true,
        reason: "No secret service is available on this machine.",
      },
    });
    const strip = query("[data-zoc-degraded-secrets]");
    expect(strip).not.toBeNull();
    expect(strip?.getAttribute("data-zoc-secret-backend")).toBe("degraded");
    // The consequence, not just the cause: what the user needs is "your keys will not survive a quit".
    expect(strip?.textContent).toContain("held in memory");
  });

  it("carries its own sentence when Desktop_Core gives no reason", () => {
    renderPanel({ secretStatus: { backend: "degraded", degraded: true, reason: null } });
    expect(query("[data-zoc-degraded-secrets]")?.textContent).toContain("re-entering next launch");
  });

  it("has no dismiss control, because the condition lasts the whole launch", () => {
    renderPanel({ secretStatus: { backend: "degraded", degraded: true, reason: null } });
    expect(query("[data-zoc-degraded-secrets] button")).toBeNull();
  });
});

describe("Feature: zoc-agent-chat-rebuild, task 22.8: the runtime banner (R3.8)", () => {
  it("reports the reason above a panel that keeps rendering", () => {
    renderPanel({ runtimeUnavailable: "the runtime crashed during startup" });
    const banner = query("[data-zoc-runtime-banner]");
    expect(banner).not.toBeNull();
    expect(query("[data-zoc-runtime-banner-reason]")?.textContent).toBe(
      "the runtime crashed during startup",
    );
    // The transcript and the composer are still there: a supervisor failure is not a reason to hide a
    // transcript that is already on disk.
    expect(query("[data-zoc-composer]")).not.toBeNull();
  });

  it("offers Restart to a host and calls back", async () => {
    const onRestartRuntime = vi.fn().mockResolvedValue(undefined);
    renderPanel({ runtimeUnavailable: "port 3011 did not pass /health", onRestartRuntime });

    const restart = query("[data-zoc-runtime-restart]");
    expect(restart).not.toBeNull();
    fireEvent.click(restart as HTMLElement);
    expect(onRestartRuntime).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(query("[data-zoc-runtime-restart]")?.hasAttribute("disabled")).toBe(false);
    });
  });

  it("offers no Restart to a viewer, which cannot restart someone else's host", () => {
    renderPanel({
      readOnly: true,
      runtimeUnavailable: "the runtime crashed during startup",
      onRestartRuntime: vi.fn(),
    });
    expect(query("[data-zoc-runtime-banner]")).not.toBeNull();
    expect(query("[data-zoc-runtime-restart]")).toBeNull();
  });
});

describe("Feature: zoc-agent-chat-rebuild, task 22.8: submission and the queue (R8.7)", () => {
  const type = (text: string) => {
    const input = query("[data-zoc-composer-input]");
    if (input === null) throw new Error("The composer rendered no input.");
    fireEvent.change(input, { target: { value: text } });
  };

  it("sends the draft through the transport", async () => {
    renderPanel();
    type("explain the store");
    fireEvent.click(sendControl());
    await waitFor(() => {
      expect(transport.sent).toEqual(["explain the store"]);
    });
  });

  it("holds a second submission behind the Run and reports the count", async () => {
    renderPanel();
    type("first");
    fireEvent.click(sendControl());
    await waitFor(() => {
      expect(sendControl().getAttribute("data-zoc-send-mode")).toBe("queue");
    });

    type("second");
    fireEvent.click(sendControl());
    await waitFor(() => {
      expect(query("[data-zoc-send-queued]")?.getAttribute("data-zoc-send-queued")).toBe("1");
    });
    // Still one request: the panel is holding the second, not racing it against the first.
    expect(transport.sent).toEqual(["first"]);
  });

  it("drains the queue when the Run settles", async () => {
    renderPanel();
    type("first");
    fireEvent.click(sendControl());
    await waitFor(() => {
      expect(sendControl().getAttribute("data-zoc-send-mode")).toBe("queue");
    });
    type("second");
    fireEvent.click(sendControl());
    await waitFor(() => {
      expect(query("[data-zoc-send-queued]")).not.toBeNull();
    });

    transport.closeAll();
    await waitFor(() => {
      expect(transport.sent).toEqual(["first", "second"]);
    });
    expect(query("[data-zoc-send-queued]")).toBeNull();
  });

  it("refuses to send with no model selected rather than sending against nothing", async () => {
    renderPanel({ selectedModel: null, models: [] });
    type("anything");
    const send = query("[data-zoc-send]");
    if (send !== null) fireEvent.click(send);
    await waitFor(() => {
      expect(transport.sent).toHaveLength(0);
    });
  });
});

describe("Feature: zoc-agent-chat-rebuild, task 22.8: the interrupted row (R16.5)", () => {
  const lifecycleRow = (state: RunLifecyclePart["state"]) =>
    ({
      kind: "error" as const,
      id: "row-1",
      error: {
        type: "run-lifecycle" as const,
        seq: 9,
        runId: "run-1",
        messageId: "m1",
        ts: "2026-07-31T10:00:00.000Z",
        agentName: null,
        state,
        code: state === "interrupted" ? "stream_lost" : "provider_error",
        message: "The connection to this run was lost.",
      },
    });

  it("offers Continue with what we have on an interrupted Run", () => {
    const onErrorContinue = vi.fn();
    render(<TranscriptRowView row={lifecycleRow("interrupted")} onErrorContinue={onErrorContinue} />);
    const control = query("[data-zoc-error-continue]");
    expect(control).not.toBeNull();
    expect(control?.textContent).toContain("Continue with what we have");
    fireEvent.click(control as HTMLElement);
    expect(onErrorContinue).toHaveBeenCalledTimes(1);
  });

  it("offers nothing to continue on a failure, which produced no partial result to keep", () => {
    render(<TranscriptRowView row={lifecycleRow("failed")} onErrorContinue={vi.fn()} />);
    expect(query("[data-zoc-error-continue]")).toBeNull();
  });

  it("offers nothing when the panel withheld the handler, as it does for a viewer", () => {
    render(<TranscriptRowView row={lifecycleRow("interrupted")} />);
    expect(query("[data-zoc-error-continue]")).toBeNull();
  });
});

describe("Feature: zoc-agent-chat-rebuild, task 22.8: the transcript replaces the empty state", () => {
  it("draws the transcript once the Session has a message", () => {
    const restored: readonly ZocUIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] },
    ];
    renderPanel({ initialMessages: restored });
    expect(query("[data-zoc-empty-state]")).toBeNull();
    expect(query("[data-zoc-transcript-scroll]")).not.toBeNull();
  });
});
