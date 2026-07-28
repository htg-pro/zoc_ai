/**
 * message-item-reasoning.test.tsx — the render-side reasoning boundary.
 *
 * Asserts the behaviour a user can see: reasoning is reachable but collapsed,
 * the answer is what is rendered, and a response that is *only* reasoning
 * (still streaming) shows the streaming indicator rather than raw scratchpad.
 */
import type { Message } from "@zoc-studio/shared-types";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageItem } from "@/features/agent/MessageItem";

function assistant(content: string): Message {
  return {
    id: "m-1",
    role: "assistant",
    content,
    created_at: new Date("2026-01-01T00:00:00.000Z").toISOString(),
  };
}

describe("MessageItem reasoning boundary", () => {
  it("renders the answer and hides reasoning behind a collapsed disclosure", () => {
    render(<MessageItem message={assistant("<think>private notes</think>Use `parse()`.")} />);

    expect(screen.getByText(/Use/)).toBeInTheDocument();
    // Present but collapsed: the text is not in the document until expanded.
    const toggle = screen.getByRole("button", { name: /reasoning/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("private notes")).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("private notes")).toBeInTheDocument();
  });

  it("never renders a raw think tag as answer text", () => {
    const { container } = render(<MessageItem message={assistant("<think>leaked</think>done")} />);
    expect(container.textContent).not.toContain("<think>");
  });

  it("shows the streaming indicator when only reasoning has arrived", () => {
    const { container } = render(<MessageItem message={assistant("<think>mid-stream")} />);
    // No answer yet, so no prose block — the typing dots stand in for it.
    expect(container.textContent).not.toContain("mid-stream");
    expect(container.querySelectorAll(".animate-typing-dot").length).toBeGreaterThan(0);
  });

  it("leaves an ordinary answer untouched", () => {
    render(<MessageItem message={assistant("Plain answer.")} />);
    expect(screen.getByText("Plain answer.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reasoning/i })).toBeNull();
  });
});
