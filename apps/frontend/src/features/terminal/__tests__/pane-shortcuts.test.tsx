import { test, expect, beforeEach } from "vitest";
import type { JSX } from "react";
import { render, fireEvent } from "@testing-library/react";
import { useTerminalPaneShortcuts } from "../useTerminalPaneShortcuts";
import { TerminalPanes } from "../TerminalPanes";
import { useApp } from "@/lib/store";
import { leaves } from "@/lib/terminal-layout";

function Harness(): JSX.Element {
  useTerminalPaneShortcuts();
  return <div>harness</div>;
}

beforeEach(() => {
  useApp.setState({ terminalLayout: null, focusedPaneId: null });
});

function seedTwoPanes(): string[] {
  useApp.getState().ensureTerminalPane("s1");
  useApp.getState().splitActivePane("row", "s2");
  return leaves(useApp.getState().terminalLayout).map((l) => l.id);
}

test("Cmd+] focuses the next pane and Cmd+[ the previous", () => {
  const ids = seedTwoPanes();
  useApp.setState({ focusedPaneId: ids[0] });
  render(<Harness />);

  fireEvent.keyDown(window, { key: "]", metaKey: true });
  expect(useApp.getState().focusedPaneId).toBe(ids[1]);

  fireEvent.keyDown(window, { key: "[", metaKey: true });
  expect(useApp.getState().focusedPaneId).toBe(ids[0]);
});

test("Cmd+W closes the focused pane", () => {
  const ids = seedTwoPanes();
  useApp.setState({ focusedPaneId: ids[1] });
  render(<Harness />);

  fireEvent.keyDown(window, { key: "w", metaKey: true });
  const remaining = leaves(useApp.getState().terminalLayout).map((l) => l.id);
  expect(remaining).toEqual([ids[0]]);
});

test("TerminalPanes renders one host per leaf via the renderPane callback", () => {
  seedTwoPanes();
  const state = useApp.getState();
  const { container } = render(
    <TerminalPanes
      node={state.terminalLayout}
      focusedPaneId={state.focusedPaneId}
      renderPane={(pane) => <span data-session={pane.sessionId}>{pane.sessionId}</span>}
    />,
  );
  expect(container.querySelectorAll("[data-pane]")).toHaveLength(2);
  expect(container.querySelector('[data-session="s1"]')).toBeTruthy();
  expect(container.querySelector('[data-session="s2"]')).toBeTruthy();
});
