import { useEffect } from "react";
import { useApp } from "./store";
import { eventToKeybinding, matchKeybinding, runCommand } from "./commands";
// Task 24.2: the two key resolutions and the surface they act on both live with the Chat_Surface, so
// R23.3's bindings survive `features/agent` being deleted at 26.1. `lib/keybinding-overrides.ts` is
// untouched — the bindings themselves are user data and the repoint is behaviour-free.
import {
  activeSlotCount,
  cancelAction,
  chatKeyboardTarget,
  submitAction,
  type StartVerdict,
} from "@/features/chat/gating/keyboard-actions";

/** Global "start the run" shortcut (used when focus is outside the composer). */
export const SUBMIT_KEYBINDING = "mod+enter";
/** Global "stop the active run" shortcut. */
export const CANCEL_KEYBINDING = "mod+.";

/**
 * The mounted composer's own verdict — so a keyboard submit obeys exactly the same gate as the button
 * (R20.3).
 *
 * It no longer builds a gate from `AppState`. It used to, through the legacy `evaluateRunGate`, and that
 * was a *second opinion* about a decision `features/chat/composer` already makes; keeping it once the
 * Chat_Surface was mounted (25.6) would mean the keystroke could admit a Run the Send control had
 * refused, which is the one failure R20.3 names. The composer publishes the expression it hands its own
 * control, and this reads it.
 *
 * No mounted composer is a refusal rather than a default: a read-only viewer renders none (R1.4), and
 * neither does the shell before the panel's first commit.
 */
export function runGateForKeyboard(): StartVerdict {
  return chatKeyboardTarget()?.verdict() ?? { canStart: false };
}

/** True when the keystroke targets a text field the composer/editor owns. */
function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  return el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable === true;
}

/**
 * Global keyboard shortcuts. Submit and cancel consult the mounted Chat_Surface — its gate and its Run
 * state — so keyboard actions obey exactly the same gate as the buttons (R20.3, R20.4); everything else
 * resolves through the command registry so the palette and the keyboard share one source of truth.
 */
export function useGlobalShortcuts() {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const kb = eventToKeybinding(e);

      // Keyboard submit — the composer's own send handler, behind the composer's own gate. Skipped
      // while focus is in a text field, where the composer's Enter handler runs, so a single keystroke
      // never starts two runs.
      if (kb === SUBMIT_KEYBINDING && !isTextEntry(e.target)) {
        if (submitAction(runGateForKeyboard()) === "start") {
          e.preventDefault();
          chatKeyboardTarget()?.submit();
        }
        return;
      }

      // Keyboard cancel — one cancellation, only while a Run still holds a Slot (R20.4).
      if (kb === CANCEL_KEYBINDING) {
        const target = chatKeyboardTarget();
        if (target !== null && cancelAction(activeSlotCount(target.runStates())) === "cancel") {
          e.preventDefault();
          target.cancel();
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
