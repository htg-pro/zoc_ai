import { describe, it, expect, beforeEach } from "vitest";
import {
  eventToKeybinding,
  formatKeybinding,
  getCommand,
  getCommands,
  isCommandEnabled,
  matchKeybinding,
} from "@/lib/commands";
import { useApp } from "@/lib/store";

const initial = useApp.getState();

function key(parts: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...parts,
  } as KeyboardEvent;
}

describe("command registry", () => {
  beforeEach(() => {
    useApp.setState({ ...initial });
  });

  it("exposes every required workbench/zoc command id", () => {
    const ids = new Set(getCommands().map((c) => c.id));
    for (const required of [
      "workbench.action.quickOpen",
      "workbench.action.showCommands",
      "workbench.view.explorer",
      "workbench.view.search",
      "workbench.view.scm",
      "workbench.view.debug",
      "workbench.view.extensions",
      "workbench.action.terminal.toggleTerminal",
      "workbench.action.files.save",
      "workbench.action.files.saveAll",
      "workbench.action.files.revert",
      "zoc.agent.ask",
      "zoc.agent.run",
      "zoc.agent.reviewChanges",
      "zoc.agent.applyRun",
      "zoc.agent.discardRun",
      "zoc.agent.restoreCheckpoint",
    ]) {
      expect(ids.has(required)).toBe(true);
    }
  });

  it("normalizes keyboard events to the binding grammar", () => {
    expect(eventToKeybinding(key({ key: "p", metaKey: true }))).toBe("mod+p");
    expect(eventToKeybinding(key({ key: "P", ctrlKey: true, shiftKey: true }))).toBe("mod+shift+p");
    expect(eventToKeybinding(key({ key: "s", metaKey: true, altKey: true }))).toBe("mod+alt+s");
    // No bound modifier → no match.
    expect(eventToKeybinding(key({ key: "p" }))).toBeNull();
    // Bare modifier press → ignored.
    expect(eventToKeybinding(key({ key: "Meta", metaKey: true }))).toBeNull();
  });

  it("formats keybindings for mac and non-mac", () => {
    expect(formatKeybinding("mod+shift+p", true)).toBe("⌘⇧P");
    expect(formatKeybinding("mod+shift+p", false)).toBe("Ctrl+Shift+P");
    expect(formatKeybinding("mod+,", false)).toBe("Ctrl+,");
    expect(formatKeybinding(undefined, true)).toBe("");
  });

  it("matches a keybinding to its command and honors the extra binding", () => {
    const s = useApp.getState();
    expect(matchKeybinding(key({ key: "p", metaKey: true }), s)?.id).toBe(
      "workbench.action.quickOpen",
    );
    // Cmd+K (extra binding) and Cmd+Shift+P both reach Show All Commands.
    expect(matchKeybinding(key({ key: "k", metaKey: true }), s)?.id).toBe(
      "workbench.action.showCommands",
    );
    expect(matchKeybinding(key({ key: "p", metaKey: true, shiftKey: true }), s)?.id).toBe(
      "workbench.action.showCommands",
    );
  });

  it("skips a disabled command's keybinding so the key falls through", () => {
    // Save is disabled with no active file.
    useApp.setState({ activeFile: null, openFiles: [] });
    expect(matchKeybinding(key({ key: "s", metaKey: true }), useApp.getState())).toBeUndefined();
    // With an active file it resolves.
    useApp.setState({
      activeFile: "/a.ts",
      openFiles: [{ path: "/a.ts", name: "a.ts", language: "typescript", content: "", dirty: false }],
    });
    expect(matchKeybinding(key({ key: "s", metaKey: true }), useApp.getState())?.id).toBe(
      "workbench.action.files.save",
    );
  });

  it("disables unavailable views with an explanatory reason", () => {
    const s = useApp.getState();
    // Debug start is still gated on the deferred DAP runtime.
    const dbg = getCommand("workbench.action.debug.start")!;
    expect(isCommandEnabled(dbg, s)).toBe(false);
    expect(dbg.disabledReason?.(s)).toBeTruthy();
    // Source Control, Run & Debug, and Extensions are now implemented/enabled.
    expect(isCommandEnabled(getCommand("workbench.view.scm")!, s)).toBe(true);
    expect(isCommandEnabled(getCommand("workbench.view.debug")!, s)).toBe(true);
    expect(isCommandEnabled(getCommand("workbench.view.extensions")!, s)).toBe(true);
  });

  it("gates apply/discard/restore on pending review state", () => {
    const apply = getCommand("zoc.agent.applyRun")!;
    useApp.setState({ reviewRunId: null });
    expect(isCommandEnabled(apply, useApp.getState())).toBe(false);
    useApp.setState({ reviewRunId: "run-1" });
    expect(isCommandEnabled(apply, useApp.getState())).toBe(true);
  });
});
