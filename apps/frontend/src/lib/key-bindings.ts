import { useEffect } from "react";
import { useApp } from "./store";
import { matchKeybinding, runCommand } from "./commands";

/**
 * Global keyboard shortcuts, driven entirely by the command registry
 * (`lib/commands.ts`) so the palette and the keyboard share one source of
 * truth. A keydown is normalized and matched against registered keybindings;
 * disabled commands are skipped (so their default key falls through).
 */
export function useGlobalShortcuts() {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const cmd = matchKeybinding(e, useApp.getState());
      if (!cmd) return;
      e.preventDefault();
      void runCommand(cmd.id);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
