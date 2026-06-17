/**
 * Central command registry (develop.md Phase 1).
 *
 * One source of truth for every major user action: the command palette, the
 * global keybindings, and (over time) toolbar/menu buttons all resolve through
 * this registry instead of hardcoding behavior. A command carries an id, a
 * human title, a category, an optional default keybinding, familiar VS Code /
 * Cursor aliases, an enablement predicate, a reason-when-disabled, and a
 * handler.
 *
 * Keybinding grammar (normalized, lowercase, "+"-joined):
 *   mod   → Cmd on macOS, Ctrl elsewhere
 *   shift, alt
 *   <key> → single key: a–z, 0–9, or "," etc.
 * e.g. "mod+k", "mod+shift+p", "mod+,".
 *
 * The registry stays decoupled from React: handlers reach the app through
 * `useApp.getState()`, and keybinding matching is a pure function of the
 * KeyboardEvent so it can be unit-tested without a DOM.
 */
import { useApp, type AppState } from "./store";
import { recordRecentCommand } from "./recents";
import { formatDocument, goToLine, goToSymbolInFile } from "./editor-actions";
import { effectiveKeybinding, loadOverrides } from "./keybinding-overrides";

export type CommandCategory =
  | "Go"
  | "View"
  | "File"
  | "Editor"
  | "Agent"
  | "Terminal"
  | "Tasks"
  | "Preferences";

export interface Command {
  id: string;
  title: string;
  category: CommandCategory;
  /** Normalized default keybinding (see grammar above), if any. */
  keybinding?: string;
  /** Additional keybindings that also trigger this command (not shown in UI). */
  extraKeybindings?: string[];
  /** Familiar alternate names so search finds e.g. "Go to File" via "quick open". */
  aliases?: string[];
  /** Lucide icon name; resolved to a component by the palette. */
  icon?: string;
  /** When present and it returns false, the command is shown disabled. */
  enabled?: (s: AppState) => boolean;
  /** Why the command is disabled — surfaced in the palette. */
  disabledReason?: (s: AppState) => string | null;
  run: () => void | Promise<void>;
}

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const p = `${navigator.platform || ""} ${navigator.userAgent || ""}`.toLowerCase();
  return p.includes("mac");
}

/** Pretty-print a normalized keybinding for display (⌘⇧P / Ctrl+Shift+P). */
export function formatKeybinding(kb: string | undefined, mac = isMacPlatform()): string {
  if (!kb) return "";
  const parts = kb.split("+");
  const out = parts.map((part) => {
    switch (part) {
      case "mod":
        return mac ? "⌘" : "Ctrl";
      case "shift":
        return mac ? "⇧" : "Shift";
      case "alt":
        return mac ? "⌥" : "Alt";
      case ",":
        return ",";
      default:
        return part.length === 1 ? part.toUpperCase() : part;
    }
  });
  return mac ? out.join("") : out.join("+");
}

/** Normalize a KeyboardEvent into the same grammar the registry uses, or null
 *  when no modifier that we bind on is held. */
export function eventToKeybinding(e: KeyboardEvent): string | null {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return null;
  const key = e.key.toLowerCase();
  // Ignore bare modifier presses.
  if (key === "control" || key === "meta" || key === "shift" || key === "alt") return null;
  const parts = ["mod"];
  if (e.shiftKey) parts.push("shift");
  if (e.altKey) parts.push("alt");
  parts.push(key);
  return parts.join("+");
}

let registry: Command[] = [];

/** Commands contributed by enabled plugins (develop.md Phase 12). Kept separate
 *  from the built-in `registry` so enabling/disabling a plugin can swap them
 *  wholesale without touching the core set. */
let contributed: Command[] = [];

/** Replace the contributed-command set (called by the plugin host on change). */
export function setContributedCommands(cmds: Command[]): void {
  contributed = cmds;
}

export function getCommands(): Command[] {
  return contributed.length ? [...registry, ...contributed] : registry;
}

export function getCommand(id: string): Command | undefined {
  return registry.find((c) => c.id === id) ?? contributed.find((c) => c.id === id);
}

/** True when the command may run given current app state. */
export function isCommandEnabled(cmd: Command, s: AppState): boolean {
  return cmd.enabled ? cmd.enabled(s) : true;
}

/** Find the command bound to a KeyboardEvent, skipping disabled ones. User
 *  keybinding overrides (Phase 10) take precedence over registry defaults. */
export function matchKeybinding(e: KeyboardEvent, s: AppState): Command | undefined {
  const kb = eventToKeybinding(e);
  if (!kb) return undefined;
  const overrides = loadOverrides();
  const cmd = registry.find(
    (c) =>
      effectiveKeybinding(c, overrides) === kb ||
      (c.extraKeybindings?.includes(kb) ?? false),
  );
  if (!cmd) return undefined;
  return isCommandEnabled(cmd, s) ? cmd : undefined;
}

/** Run a command by id (records it in the recent-commands list). No-op when
 *  the command is unknown or currently disabled. */
export async function runCommand(id: string): Promise<void> {
  const cmd = getCommand(id);
  if (!cmd) return;
  if (!isCommandEnabled(cmd, useApp.getState())) return;
  recordRecentCommand(id);
  await cmd.run();
}

const app = () => useApp.getState();

/**
 * The command set. Disabled-but-present commands (SCM, Debug, Tasks,
 * Extensions) are intentionally listed so the palette advertises them with an
 * honest "not available yet" reason instead of silently hiding the surface —
 * they light up as their phases land.
 */
registry = [
  // ── Go / palette ──────────────────────────────────────────────────────
  {
    id: "workbench.action.quickOpen",
    title: "Go to File…",
    category: "Go",
    keybinding: "mod+p",
    aliases: ["quick open", "open file", "find file"],
    icon: "File",
    run: () => app().openPalette(""),
  },
  {
    id: "workbench.action.showCommands",
    title: "Show All Commands",
    category: "Go",
    keybinding: "mod+shift+p",
    extraKeybindings: ["mod+k"],
    aliases: ["command palette", "commands"],
    icon: "Command",
    run: () => app().openPalette(">"),
  },
  {
    id: "workbench.action.gotoSymbol",
    title: "Go to Symbol in Workspace…",
    category: "Go",
    aliases: ["symbols", "go to symbol"],
    icon: "Hash",
    run: () => app().openPalette("@"),
  },
  // ── Views ─────────────────────────────────────────────────────────────
  {
    id: "workbench.view.explorer",
    title: "View: Show Explorer",
    category: "View",
    keybinding: "mod+1",
    aliases: ["files", "explorer"],
    icon: "Files",
    run: () => {
      app().setActivity("files");
      if (!app().layout.sidePanelOpen) app().toggleSide();
    },
  },
  {
    id: "workbench.view.search",
    title: "View: Show Search",
    category: "View",
    keybinding: "mod+shift+f",
    aliases: ["find in files", "search"],
    icon: "Search",
    run: () => {
      app().setActivity("search");
      if (!app().layout.sidePanelOpen) app().toggleSide();
    },
  },
  {
    id: "workbench.view.indexer",
    title: "View: Show Indexer",
    category: "View",
    keybinding: "mod+2",
    aliases: ["index", "embeddings"],
    icon: "Database",
    run: () => {
      app().setActivity("indexer");
      if (!app().layout.sidePanelOpen) app().toggleSide();
    },
  },
  {
    id: "workbench.view.sessions",
    title: "View: Show Sessions",
    category: "View",
    keybinding: "mod+3",
    aliases: ["history", "conversations"],
    icon: "MessagesSquare",
    run: () => {
      app().setActivity("sessions");
      if (!app().layout.sidePanelOpen) app().toggleSide();
    },
  },
  {
    id: "workbench.view.scm",
    title: "View: Show Source Control",
    category: "View",
    keybinding: "mod+shift+g",
    aliases: ["git", "source control"],
    icon: "GitBranch",
    run: () => {
      app().setActivity("scm");
      if (!app().layout.sidePanelOpen) app().toggleSide();
    },
  },
  {
    id: "workbench.view.debug",
    title: "View: Show Run and Debug",
    category: "View",
    keybinding: "mod+shift+d",
    aliases: ["debug", "run"],
    icon: "Bug",
    run: () => {
      app().setActivity("debug");
      void app().loadLaunchConfigs();
      if (!app().layout.sidePanelOpen) app().toggleSide();
    },
  },
  {
    id: "workbench.action.debug.start",
    title: "Debug: Start Debugging",
    category: "View",
    keybinding: "f5",
    aliases: ["start debugging", "run"],
    icon: "Bug",
    enabled: () => false,
    disabledReason: () =>
      "The debug adapter runtime isn't wired yet (shares the process runtime from develop.md Phase 8). Breakpoints and launch configs are ready.",
    run: () => undefined,
  },
  {
    id: "workbench.view.outline",
    title: "View: Show Outline",
    category: "View",
    aliases: ["outline", "symbols"],
    icon: "ListTree",
    run: () => {
      app().setActivity("outline");
      if (!app().layout.sidePanelOpen) app().toggleSide();
    },
  },
  {
    id: "workbench.view.timeline",
    title: "View: Show Timeline",
    category: "View",
    aliases: ["timeline", "history"],
    icon: "History",
    run: () => {
      app().setActivity("timeline");
      if (!app().layout.sidePanelOpen) app().toggleSide();
    },
  },
  {
    id: "workbench.action.manageTrust",
    title: "Workspace: Manage Trust & Safety",
    category: "View",
    aliases: ["trust", "safety", "permissions", "allowlist"],
    icon: "ShieldAlert",
    run: () => app().openSettings("trust"),
  },
  {
    id: "workbench.view.extensions",
    title: "View: Show Extensions",
    category: "View",
    aliases: ["plugins", "extensions"],
    icon: "Blocks",
    run: () => app().openSettings("extensions"),
  },
  {
    id: "workbench.action.toggleSidebar",
    title: "View: Toggle Primary Side Bar",
    category: "View",
    keybinding: "mod+b",
    aliases: ["sidebar"],
    icon: "PanelLeft",
    run: () => app().toggleSide(),
  },
  {
    id: "workbench.action.togglePanel",
    title: "View: Toggle Bottom Panel",
    category: "View",
    keybinding: "mod+j",
    aliases: ["panel", "bottom dock"],
    icon: "PanelBottom",
    run: () => app().toggleBottom(),
  },
  {
    id: "workbench.action.toggleAgentPanel",
    title: "View: Toggle Agent Panel",
    category: "View",
    keybinding: "mod+i",
    aliases: ["agent", "assistant"],
    icon: "PanelRight",
    run: () => app().toggleRight(),
  },
  {
    id: "workbench.action.terminal.toggleTerminal",
    title: "Terminal: Toggle Terminal",
    category: "Terminal",
    keybinding: "mod+`",
    aliases: ["terminal", "shell"],
    icon: "Terminal",
    run: () => {
      app().setBottomTab("terminal");
      if (!app().layout.bottomDockOpen) app().toggleBottom();
    },
  },
  {
    id: "workbench.view.problems",
    title: "View: Show Problems",
    category: "View",
    keybinding: "mod+shift+m",
    aliases: ["problems", "diagnostics", "errors"],
    icon: "AlertTriangle",
    run: () => app().setBottomTab("problems"),
  },
  // ── Tasks ─────────────────────────────────────────────────────────────
  {
    id: "workbench.action.tasks.runTask",
    title: "Tasks: Run Task",
    category: "Tasks",
    aliases: ["run task", "task"],
    icon: "ListChecks",
    run: () => {
      void app().discoverTasks();
      app().setBottomTab("tasks");
      if (!app().layout.bottomDockOpen) app().toggleBottom();
    },
  },
  {
    id: "workbench.action.tasks.runBuildTask",
    title: "Tasks: Run Build Task",
    category: "Tasks",
    keybinding: "mod+shift+b",
    aliases: ["build"],
    icon: "Hammer",
    run: () => void app().runBuildTask(),
  },
  {
    id: "workbench.action.tasks.test",
    title: "Tasks: Run Test Task",
    category: "Tasks",
    aliases: ["test", "run tests"],
    icon: "FlaskConical",
    run: () => void app().runTestTask(),
  },
  // ── Files ─────────────────────────────────────────────────────────────
  {
    id: "workbench.action.files.save",
    title: "File: Save",
    category: "File",
    keybinding: "mod+s",
    aliases: ["save"],
    icon: "Save",
    enabled: (s) => s.activeFile !== null,
    disabledReason: (s) => (s.activeFile ? null : "No active file to save."),
    run: () => void app().saveActiveFile(),
  },
  {
    id: "workbench.action.files.saveAll",
    title: "File: Save All",
    category: "File",
    keybinding: "mod+alt+s",
    aliases: ["save all"],
    icon: "Save",
    enabled: (s) => s.openFiles.some((f) => f.dirty),
    disabledReason: (s) =>
      s.openFiles.some((f) => f.dirty) ? null : "No unsaved changes.",
    run: () => void app().saveAllFiles(),
  },
  {
    id: "workbench.action.files.revert",
    title: "File: Revert File",
    category: "File",
    aliases: ["revert", "discard changes"],
    icon: "Undo2",
    enabled: (s) => {
      const f = s.openFiles.find((x) => x.path === s.activeFile);
      return !!f && f.dirty;
    },
    disabledReason: (s) => {
      const f = s.openFiles.find((x) => x.path === s.activeFile);
      return f && f.dirty ? null : "No unsaved changes to revert.";
    },
    run: () => void app().revertActiveFile(),
  },
  {
    id: "workbench.action.openSettings",
    title: "Preferences: Open Settings",
    category: "Preferences",
    keybinding: "mod+,",
    aliases: ["settings", "preferences"],
    icon: "Settings",
    run: () => app().setMainView("settings"),
  },
  // ── Editor (Phase 9) ──────────────────────────────────────────────────
  {
    id: "editor.action.formatDocument",
    title: "Format Document",
    category: "Editor",
    keybinding: "mod+shift+i",
    aliases: ["format", "prettify", "beautify"],
    icon: "WandSparkles",
    enabled: (s) => s.activeFile !== null,
    disabledReason: (s) => (s.activeFile ? null : "No active editor to format."),
    run: () => {
      formatDocument();
    },
  },
  {
    id: "workbench.action.gotoLine",
    title: "Go to Line/Column…",
    category: "Editor",
    keybinding: "mod+g",
    aliases: ["go to line", "jump to line"],
    icon: "CornerDownRight",
    enabled: (s) => s.activeFile !== null,
    disabledReason: (s) => (s.activeFile ? null : "No active editor."),
    run: () => {
      goToLine();
    },
  },
  {
    id: "editor.action.gotoSymbol",
    title: "Go to Symbol in Editor…",
    category: "Editor",
    keybinding: "mod+shift+o",
    aliases: ["outline", "go to symbol in file"],
    icon: "Hash",
    enabled: (s) => s.activeFile !== null,
    disabledReason: (s) => (s.activeFile ? null : "No active editor."),
    run: () => {
      goToSymbolInFile();
    },
  },
  {
    id: "workbench.action.splitEditor",
    title: "View: Split Editor",
    category: "Editor",
    keybinding: "mod+\\",
    aliases: ["split", "split editor right"],
    icon: "SplitSquareHorizontal",
    enabled: (s) => s.activeFile !== null,
    disabledReason: (s) => (s.activeFile ? null : "No active editor to split."),
    run: () => app().splitEditor(),
  },
  {
    id: "workbench.action.closeEditorGroup",
    title: "View: Close Split Editor",
    category: "Editor",
    aliases: ["close split", "unsplit"],
    icon: "X",
    enabled: (s) => s.splitView,
    disabledReason: (s) => (s.splitView ? null : "Editor isn't split."),
    run: () => app().closeRightGroup(),
  },
  {
    id: "view.toggleMinimap",
    title: "View: Toggle Minimap",
    category: "Editor",
    aliases: ["minimap"],
    icon: "Map",
    run: () => app().toggleEditorSetting("minimap"),
  },
  {
    id: "view.toggleStickyScroll",
    title: "View: Toggle Sticky Scroll",
    category: "Editor",
    aliases: ["sticky scroll"],
    icon: "ArrowUpToLine",
    run: () => app().toggleEditorSetting("stickyScroll"),
  },
  {
    id: "view.toggleBreadcrumbs",
    title: "View: Toggle Breadcrumbs",
    category: "Editor",
    aliases: ["breadcrumbs"],
    icon: "ChevronRight",
    run: () => app().toggleEditorSetting("breadcrumbs"),
  },
  // ── Agent ─────────────────────────────────────────────────────────────
  {
    id: "zoc.agent.ask",
    title: "Agent: Switch to Ask Mode",
    category: "Agent",
    aliases: ["ask", "read only"],
    icon: "MessageCircleQuestion",
    run: () => {
      app().setAgentMode("ask");
      if (!app().layout.rightPanelOpen) app().toggleRight();
    },
  },
  {
    id: "zoc.agent.run",
    title: "Agent: Switch to Agent Mode",
    category: "Agent",
    aliases: ["agent", "build", "autonomy"],
    icon: "Zap",
    run: () => {
      app().setAgentMode("agent");
      if (!app().layout.rightPanelOpen) app().toggleRight();
    },
  },
  {
    id: "zoc.agent.reviewChanges",
    title: "Agent: Review Changes",
    category: "Agent",
    aliases: ["diff", "review"],
    icon: "FileDiff",
    run: () => app().setMainView("diff"),
  },
  {
    id: "zoc.agent.applyRun",
    title: "Agent: Apply Pending Changes",
    category: "Agent",
    aliases: ["apply"],
    icon: "Check",
    enabled: (s) => s.reviewRunId !== null,
    disabledReason: (s) => (s.reviewRunId ? null : "No pending agent run to apply."),
    run: () => void app().applyCurrentRun(),
  },
  {
    id: "zoc.agent.discardRun",
    title: "Agent: Discard Pending Changes",
    category: "Agent",
    aliases: ["discard"],
    icon: "X",
    enabled: (s) => s.reviewRunId !== null,
    disabledReason: (s) => (s.reviewRunId ? null : "No pending agent run to discard."),
    run: () => void app().discardCurrentRun(),
  },
  {
    id: "zoc.agent.restoreCheckpoint",
    title: "Agent: Restore Last Checkpoint",
    category: "Agent",
    aliases: ["undo agent", "rollback", "restore"],
    icon: "History",
    enabled: (s) => s.restorableRunId !== null,
    disabledReason: (s) =>
      s.restorableRunId ? null : "No applied run to roll back.",
    run: () => void app().restoreCurrentRun(),
  },
];
