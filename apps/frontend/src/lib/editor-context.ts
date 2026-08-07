/**
 * Editor context capture for run requests (§12.1).
 *
 * Pulled out of the store so the "what is the user looking at?" snapshot is a
 * pure function of the active file plus the live editor bridge, and can be
 * tested without instantiating the whole store.
 */
import { getActiveSelection, getCursorPosition } from "./editor-actions";

/**
 * The editor snapshot a run request carries — zoc-agent-chat-rebuild R1.3, task 25.4.
 *
 * Homed here rather than in `features/agent/gateway-client`, which 26.1 deletes. It is a shape this
 * module produces, so the feature that consumed it was the wrong owner: the dependency now points
 * from the dying tree into `lib` instead of out of it. Mirrors the gateway's `RequestContext`
 * (§12.1) and is not in `@zoc-studio/shared-types` — the generator covers the Agent_Runtime's
 * protocol, and this is a renderer-side request field.
 */
export interface EditorRunContext {
  activeFile?: string | null;
  selection?: string | null;
  cursorLine?: number | null;
  language?: string | null;
}

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
