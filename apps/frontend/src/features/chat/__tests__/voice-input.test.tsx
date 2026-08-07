/** Voice-input controls — zoc-agent-chat-rebuild R31.1/R31.3/R31.4/R31.5. */
/** Feature: zoc-agent-chat-rebuild, task 35.2 (R31.1, R31.3, R31.4, R31.5). */

import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatMotionProvider } from "@/lib/reduced-motion-provider";
import { Composer } from "../composer/Composer";
import type { ContextCensus, ModelReference } from "../composer/context-figures";
import type { TranscriptionBackend } from "../composer/voice-input";
import { resetChatSurface } from "./transcript-harness";

const MODEL: ModelReference = {
  provider: "anthropic",
  modelId: "claude-opus-5",
  contextLimit: 200_000,
};
const CENSUS: ContextCensus = {
  messagesInContext: 0,
  sessionMessageCount: 0,
  messagesOutOfWindow: 0,
  summaryActive: false,
  consumedTokens: 0,
  measuredAgainst: MODEL,
};

function mount(backend: TranscriptionBackend | null) {
  return render(
    <ChatMotionProvider budget={null}>
      <Composer
        streaming={false}
        candidates={[]}
        model={MODEL}
        census={CENSUS}
        permissionMode="ask"
        workspaceRoot="/workspace"
        onSubmit={() => undefined}
        transcriptionBackend={backend}
      />
    </ChatMotionProvider>,
  );
}

beforeEach(resetChatSurface);
afterEach(cleanup);

describe("voice input", () => {
  it("is absent when no transcription backend is configured", () => {
    mount(null);
    expect(document.querySelector("[data-zoc-voice-input]")).toBeNull();
  });

  it("streams transcription into the composer and leaves it editable after stop", async () => {
    let callbacks: Parameters<TranscriptionBackend["start"]>[0] | null = null;
    const stop = vi.fn();
    const backend: TranscriptionBackend = {
      label: "test",
      start: vi.fn(async (next) => {
        callbacks = next;
        return { stop };
      }),
    };
    const view = mount(backend);
    const input = view.container.querySelector<HTMLTextAreaElement>("[data-zoc-composer-input]");
    const control = view.container.querySelector<HTMLElement>("[data-zoc-voice-recording]");
    if (input === null || control === null) throw new Error("voice harness is incomplete");

    fireEvent.click(control);
    await waitFor(() => expect(control.getAttribute("data-zoc-voice-recording")).toBe("true"));
    expect(document.querySelector("[data-zoc-recording-indicator]")).not.toBeNull();
    act(() => callbacks?.onTranscript("dictated text"));
    expect(input.value).toBe("dictated text");

    fireEvent.click(control);
    expect(stop).toHaveBeenCalledOnce();
    fireEvent.change(input, { target: { value: "dictated text, edited" } });
    expect(input.value).toBe("dictated text, edited");
  });

  it("states a permission refusal while keeping text input available", async () => {
    const backend: TranscriptionBackend = {
      label: "test",
      start: vi.fn(async () => {
        throw new DOMException("denied", "NotAllowedError");
      }),
    };
    const view = mount(backend);
    const input = view.container.querySelector<HTMLTextAreaElement>("[data-zoc-composer-input]");
    const control = view.container.querySelector<HTMLElement>("[data-zoc-voice-recording]");
    if (input === null || control === null) throw new Error("voice harness is incomplete");
    fireEvent.click(control);
    await waitFor(() =>
      expect(document.querySelector("[data-zoc-voice-error]")?.textContent).toContain(
        "permission was refused",
      ),
    );
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: "typing still works" } });
    expect(input.value).toBe("typing still works");
  });
});
