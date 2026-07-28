// Feature: zoc-ai-agent-chat-overhaul, Task 14: Composer reasoning control + follow-up submit path
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";
import { useApp } from "@/lib/store";

const initial = useApp.getState();

afterEach(() => {
  cleanup();
  useApp.setState({ ...initial, input: "", trackedRuns: [], streaming: false, isRunning: false });
});

describe("Composer reasoning-effort control is always rendered (R17.1)", () => {
  it("renders the control disabled + labelled for a model without the parameter", () => {
    useApp.setState({
      selectedModel: { provider: "llamacpp", model: "qwen2.5-coder-7b" },
      input: "",
    });
    render(<Composer />);
    const group = screen.getByTestId("reasoning-effort");
    expect(group.getAttribute("data-supported")).toBe("false");
    const buttons = group.querySelectorAll("button");
    expect(buttons.length).toBe(3);
    buttons.forEach((b) => expect(b.hasAttribute("disabled")).toBe(true));
  });

  it("enables the control for a supporting reasoning model", () => {
    useApp.setState({ selectedModel: { provider: "openai", model: "o1" }, input: "" });
    render(<Composer />);
    const group = screen.getByTestId("reasoning-effort");
    expect(group.getAttribute("data-supported")).toBe("true");
    const buttons = group.querySelectorAll("button");
    buttons.forEach((b) => expect(b.hasAttribute("disabled")).toBe(false));
  });
});

describe("Composer submits a follow-up through its own current-mode path (R21.3)", () => {
  it("submits the inserted prompt when the composer submit signal is bumped", async () => {
    const send = vi.fn(() => Promise.resolve());
    useApp.setState({
      agentMode: "ask",
      selectedModel: { provider: "openai", model: "o1" },
      sendUserMessage: send,
      input: "",
      trackedRuns: [],
      streaming: false,
      isRunning: false,
      maxConcurrentRuns: 3,
    });
    render(<Composer />);
    await act(async () => {
      // A follow-up chip / panel Retry routes here (not sendUserMessage directly).
      useApp.getState().requestComposerSubmit("continue where you left off");
      await Promise.resolve();
    });
    expect(send).toHaveBeenCalledWith("continue where you left off");
  });
});
