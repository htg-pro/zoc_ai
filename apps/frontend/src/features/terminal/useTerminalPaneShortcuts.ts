import { useEffect } from "react";
import { useApp } from "@/lib/store";
import { disposeTerminal } from "@/lib/terminal-manager";
import { MAX_PANES, leaves, paneCount } from "@/lib/terminal-layout";

/**
 * Terminal pane keyboard shortcuts (Part 6.1):
 *   Cmd/Ctrl+D        → split right   Cmd/Ctrl+Shift+D → split down
 *   Cmd/Ctrl+W        → close pane    Cmd/Ctrl+[ / ]   → focus prev / next
 * Splits allocate a fresh PTY session (via `newTerminal`) up to `MAX_PANES`.
 */
export function useTerminalPaneShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const s = useApp.getState();
      const key = e.key.toLowerCase();
      if (key === "d") {
        if (paneCount(s.terminalLayout) >= MAX_PANES) return;
        e.preventDefault();
        const sessionId = s.newTerminal();
        s.splitActivePane(e.shiftKey ? "column" : "row", sessionId);
      } else if (key === "w") {
        if (s.focusedPaneId) {
          e.preventDefault();
          const sessionId = leaves(s.terminalLayout).find(
            (pane) => pane.id === s.focusedPaneId,
          )?.sessionId;
          s.closeTerminalPane(s.focusedPaneId);
          if (
            sessionId &&
            !leaves(useApp.getState().terminalLayout).some((pane) => pane.sessionId === sessionId)
          ) {
            void disposeTerminal(sessionId);
          }
        }
      } else if (key === "[") {
        e.preventDefault();
        s.focusTerminalPane(-1);
      } else if (key === "]") {
        e.preventDefault();
        s.focusTerminalPane(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
