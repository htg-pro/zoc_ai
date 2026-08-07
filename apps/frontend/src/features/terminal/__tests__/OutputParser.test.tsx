import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AnnotatedOutput, type OutputHandlers } from "../OutputParser";

function handlers(): OutputHandlers & {
  onOpenPath: ReturnType<typeof vi.fn>;
  onOpenUrl: ReturnType<typeof vi.fn>;
  onFixWithAgent: ReturnType<typeof vi.fn>;
} {
  return {
    onOpenPath: vi.fn(),
    onOpenUrl: vi.fn(),
    onFixWithAgent: vi.fn(),
  };
}

test("a file-path annotation opens the file at line:col", () => {
  const h = handlers();
  const { container } = render(<AnnotatedOutput text="see src/a.ts:42:10 now" handlers={h} />);
  const btn = container.querySelector('[data-annotation="path"]') as HTMLElement;
  expect(btn).toBeTruthy();
  fireEvent.click(btn);
  expect(h.onOpenPath).toHaveBeenCalledWith("src/a.ts", 42, 10);
});

test("a URL annotation opens externally", () => {
  const h = handlers();
  const { container } = render(
    <AnnotatedOutput text="open http://localhost:3000 now" handlers={h} />,
  );
  const btn = container.querySelector('[data-annotation="url"]') as HTMLElement;
  fireEvent.click(btn);
  expect(h.onOpenUrl).toHaveBeenCalledWith("http://localhost:3000");
});

test("a stacktrace line offers Fix with Agent with the line text", () => {
  const h = handlers();
  render(<AnnotatedOutput text={"  at fn (a.js:1:2)"} handlers={h} />);
  fireEvent.click(screen.getByText("Fix with Agent"));
  expect(h.onFixWithAgent).toHaveBeenCalledWith("  at fn (a.js:1:2)");
});

test("a test summary renders a pass/fail badge", () => {
  const h = handlers();
  const { container } = render(
    <AnnotatedOutput text="5 passed, 2 failed, 1 skipped" handlers={h} />,
  );
  const badge = container.querySelector('[data-annotation="test-summary"]') as HTMLElement;
  expect(badge.textContent).toBe("5 passed, 2 failed, 1 skipped");
});

test("a carriage-return progress line renders a <progress> element", () => {
  const h = handlers();
  const { container } = render(<AnnotatedOutput text={"downloading\r 50% done"} handlers={h} />);
  const progress = container.querySelector("progress") as HTMLProgressElement;
  expect(progress).toBeTruthy();
  expect(progress.value).toBe(50);
});
