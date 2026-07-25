/**
 * Editor context capture for run requests (§12.1).
 *
 * Pulled out of the store so the "what is the user looking at?" snapshot is a
 * pure function of the active file plus the live editor bridge, and can be
 * tested without instantiating the whole store.
 */
import { getActiveSelection, getCursorPosition } from "./editor-actions";
import type { EditorRunContext } from "@/features/agent/gateway-client";

/**
 * Snapshot the editor context to send with a run.
 *
 * Returns `null` when there is nothing worth sending, so the request omits the
 * field entirely rather than shipping an object full of nulls.
 */
export function currentEditorContext(activeFile: string | null): EditorRunContext | null {
  const selection = getActiveSelection();
  const cursor = getCursorPosition();
  if (!activeFile && !selection) return null;
  return {
    ...(activeFile ? { activeFile } : {}),
    ...(selection ? { selection } : {}),
    ...(cursor ? { cursorLine: cursor.line } : {}),
  };
}
