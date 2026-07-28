import { useEffect } from "react";
import { useApp, activeWorkspaceRoot, type AppState } from "./store";
import { eventToKeybinding, matchKeybinding, runCommand } from "./commands";
import {
  evaluateRunGate,
  selectionAvailabilityMap,
  type RunGate,
} from "@/features/agent/model-availability";
import { cancelAction, submitAction } from "@/features/agent/keyboard-actions";
import { activeRuns } from "@/features/agent/agent-runs";
import { currentViewerContext } from "@/features/agent/share-session";

/** Global "start the run" shortcut (used when focus is outside the composer). */
export const SUBMIT_KEYBINDING = "mod+enter";
/** Global "stop the active run" shortcut. */
export const CANCEL_KEYBINDING = "mod+.";

/**
 * Build the same run-start gate the Composer's Send control uses, from store
 * state, so a keyboard submit obeys exactly the same gate as the button (R20.3).
 * Concurrency is not gated here (activeRunCount = 0): at capacity a submit
 * queues, matching the button.
 */
export function runGateForKeyboard(state: AppState): RunGate {
  const selectedModel = state.selectedModel ?? { provider: "", model: "" };
  const selected = selectedModel.model.trim()
    ? { provider: selectedModel.provider, model: selectedModel.model }
    : null;
  return evaluateRunGate({
    input: state.input,
    selected,
    availability: selectionAvailabilityMap(selected, state.llamaCppStatus ?? null),
    mode: state.agentMode,
    workspaceRoot: activeWorkspaceRoot(state),
    readOnly: currentViewerContext().readOnly,
    activeRunCount: 0,
    maxConcurrentRuns: state.maxConcurrentRuns ?? 3,
  });
}

/** True when the keystroke targets a text field the composer/editor owns. */
function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  return el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable === true;
}

/**
 * Global keyboard shortcuts. Submit and cancel consult `evaluateRunGate` and the
 * active-run record so keyboard actions obey exactly the same gate as the
 * buttons (R20.3, R20.4); everything else resolves through the command registry
 * so the palette and the keyboard share one source of truth.
 */
export function useGlobalShortcuts() {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const kb = eventToKeybinding(e);

      // Keyboard submit — obeys the same gate as the Send button. Skipped while
      // focus is in a text field, where the composer's own Enter handler runs,
      // so a single keystroke never starts two runs.
      if (kb === SUBMIT_KEYBINDING && !isTextEntry(e.target)) {
        const state = useApp.getState();
        if (submitAction(runGateForKeyboard(state)) === "start") {
          e.preventDefault();
          void state.sendMessage();
        }
        return;
      }

      // Keyboard cancel — one cancellation, only while a run is active (R20.4).
      if (kb === CANCEL_KEYBINDING) {
        const state = useApp.getState();
        if (cancelAction(activeRuns(state.trackedRuns ?? []).length) === "cancel") {
          e.preventDefault();
          void state.cancelRun();
        }
        return;
      }

      const cmd = matchKeybinding(e, useApp.getState());
      if (!cmd) return;
      e.preventDefault();
      void runCommand(cmd.id);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
