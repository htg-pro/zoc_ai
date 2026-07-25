import { test, expect, beforeEach } from "vitest";
import { useApp } from "../store";
import { leaves, paneCount } from "../terminal-layout";

beforeEach(() => {
  useApp.setState({ terminalLayout: null, focusedPaneId: null });
});

test("ensureTerminalPane seeds a single focused pane, then splits add panes", () => {
  useApp.getState().ensureTerminalPane("s1");
  let st = useApp.getState();
  expect(paneCount(st.terminalLayout)).toBe(1);
  expect(leaves(st.terminalLayout)[0].sessionId).toBe("s1");
  expect(st.focusedPaneId).toBe("pane-s1");

  useApp.getState().splitActivePane("row", "s2");
  st = useApp.getState();
  expect(paneCount(st.terminalLayout)).toBe(2);
  expect(new Set(leaves(st.terminalLayout).map((l) => l.sessionId))).toEqual(new Set(["s1", "s2"]));
  // ensure is a no-op once a layout exists
  useApp.getState().ensureTerminalPane("s3");
  expect(paneCount(useApp.getState().terminalLayout)).toBe(2);
});

test("focusTerminalPane cycles and closeTerminalPane removes the pane", () => {
  useApp.getState().ensureTerminalPane("s1");
  useApp.getState().splitActivePane("row", "s2");
  const ids = leaves(useApp.getState().terminalLayout).map((l) => l.id);

  useApp.setState({ focusedPaneId: ids[0] });
  useApp.getState().focusTerminalPane(1);
  expect(useApp.getState().focusedPaneId).toBe(ids[1]);
  useApp.getState().focusTerminalPane(1);
  expect(useApp.getState().focusedPaneId).toBe(ids[0]); // wrapped

  useApp.getState().closeTerminalPane(ids[1]);
  const st = useApp.getState();
  expect(paneCount(st.terminalLayout)).toBe(1);
  expect(leaves(st.terminalLayout).map((l) => l.id)).toEqual([ids[0]]);
});

test("closing the last pane empties the layout", () => {
  useApp.getState().ensureTerminalPane("solo");
  const paneId = leaves(useApp.getState().terminalLayout)[0].id;
  useApp.getState().closeTerminalPane(paneId);
  expect(useApp.getState().terminalLayout).toBeNull();
});


test("closing panes and sessions keeps terminal metadata and focus synchronized", () => {
  useApp.setState({ terminals: [], activeTerminalId: null, terminalLayout: null, focusedPaneId: null });
  const first = useApp.getState().newTerminal();
  useApp.getState().ensureTerminalPane(first);
  const second = useApp.getState().newTerminal();
  useApp.getState().splitActivePane("row", second);
  const secondPane = leaves(useApp.getState().terminalLayout).find(
    (pane) => pane.sessionId === second,
  )!;

  useApp.getState().closeTerminalPane(secondPane.id);
  expect(useApp.getState().terminals.map((terminal) => terminal.id)).toEqual([first]);
  expect(useApp.getState().activeTerminalId).toBe(first);

  useApp.getState().closeTerminal(first);
  expect(useApp.getState().terminalLayout).toBeNull();
  expect(useApp.getState().focusedPaneId).toBeNull();
  expect(useApp.getState().terminals).toEqual([]);
});
