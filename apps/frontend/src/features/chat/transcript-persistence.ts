/**
 * Transcript persistence, renderer side — zoc-agent-chat-rebuild R15.2, R15.6, R15.7, task 22.5.
 *
 * The read half of R15.6. The runtime writes a completed Run's messages to
 * Workspace_Services (`onFinish`, through its own `RunPersistence`); this module is
 * what the Chat_Surface calls to get them back when a Session is selected, plus the
 * one write the renderer owns.
 *
 * ## Why the stored record needs decoding at all
 *
 * It is stored verbatim — an AI SDK `UIMessage` with its parts and its metadata —
 * so "decoding" is not a transformation, it is a **boundary check**. `messages.json`
 * is a file on the user's disk that a crash, a bad merge, or a hand edit can leave
 * malformed, and `useChat` is handed the result directly. So a record that cannot be
 * rendered is dropped here rather than at the first component that reads `.parts`
 * off `undefined`, and dropping one record costs one row rather than the Session.
 *
 * That is the same rule the store applies on its side, and it is deliberately
 * applied twice: the store protects the file from the runtime, and this protects the
 * surface from the file. Neither can assume the other ran.
 *
 * ## What is *not* rewritten on the way in
 *
 * Nothing about ordering, sequence numbers, or part contents. The transcript's order
 * is the stored order — R7.7's `seq` is allocated per Run by the writer and a
 * restored transcript that re-sorted or re-numbered would disagree with the
 * checkpoint references and the tool timeline that point into it (R10.5, R9.2).
 *
 * ## The one write the renderer makes
 *
 * {@link recordUserTurn}, on submit (R15.7). The runtime's `onFinish` persists the
 * whole conversation including that turn, so this looks redundant — it is not: a Run
 * that never finishes (a crash, a kill, a power loss) would otherwise lose the
 * prompt the user typed, and the prompt is the one part of the exchange they cannot
 * reproduce by asking again.
 */

import type { ZocUIMessage } from "./wire/ui-message";
import type { WorkspaceServicesClient } from "@/lib/workspace-services-client";

/** The four roles a stored message may carry, matching the store's own set. */
const ROLES: ReadonlySet<string> = new Set(["user", "assistant", "system", "tool"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Is this record renderable as a transcript message?
 *
 * Three fields, and no more than three: an id (the reconciliation key `useChat`
 * and every row `key` depend on), a known role, and a parts array. Metadata is
 * *not* required — a message from a Session that predates a metadata field still
 * renders, it just renders without that figure, and demanding it would turn a
 * cosmetic gap into a lost turn.
 */
export function isRestorableMessage(value: unknown): value is ZocUIMessage {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.role === "string" &&
    ROLES.has(value.role) &&
    Array.isArray(value.parts)
  );
}

export interface RestoreOutcome {
  /** The transcript, in stored order. */
  readonly messages: readonly ZocUIMessage[];
  /**
   * How many records were dropped as unrenderable.
   *
   * Surfaced rather than swallowed so the panel can say "2 messages could not be
   * read" instead of showing a transcript with holes in it and no explanation.
   */
  readonly skipped: number;
}

/** Stored records as a transcript, skipping what cannot be rendered. */
export function restoreTranscript(records: readonly unknown[]): RestoreOutcome {
  const messages: ZocUIMessage[] = [];
  let skipped = 0;
  for (const record of records) {
    if (isRestorableMessage(record)) messages.push(record);
    else skipped += 1;
  }
  return { messages, skipped };
}

/**
 * Load and restore a Session's transcript (R15.6).
 *
 * A failure resolves to an empty transcript with the error attached rather than
 * throwing: selecting a Session whose transcript cannot be read should open the
 * Session — the user can still type — and say what went wrong, where a throw
 * leaves the panel on the previous Session's rows with no explanation.
 */
export async function loadTranscript(
  client: Pick<WorkspaceServicesClient, "listMessages">,
  sessionId: string,
): Promise<RestoreOutcome & { readonly error: unknown }> {
  try {
    const records = (await client.listMessages(sessionId)) as unknown as readonly unknown[];
    return { ...restoreTranscript(Array.isArray(records) ? records : []), error: null };
  } catch (error) {
    return { messages: [], skipped: 0, error };
  }
}

/**
 * Record the user's turn before the Run starts (R15.7).
 *
 * Returns whether it landed. The caller does **not** block submission on it: the
 * Run is the thing the user asked for, and refusing to start one because a
 * durability write failed would trade a recoverable gap in history for a refused
 * request.
 */
export async function recordUserTurn(
  client: Pick<WorkspaceServicesClient, "postMessage">,
  sessionId: string,
  message: ZocUIMessage,
): Promise<boolean> {
  try {
    await (client.postMessage as unknown as (id: string, body: unknown) => Promise<unknown>)(
      sessionId,
      { message },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * The wire parts carried by a transcript, in stored order.
 *
 * The eight `data-zoc-*` parts wrap their wire payload in `data`; the five native
 * ones *are* the payload. Both are unwrapped here so a caller — the compaction-pin
 * derivation, a persistence property, a diagnostic — reads one list of wire parts
 * rather than two shapes.
 */
export function wirePartsOf(messages: readonly ZocUIMessage[]): readonly unknown[] {
  const parts: unknown[] = [];
  for (const message of messages) {
    for (const part of message.parts as readonly unknown[]) {
      if (!isRecord(part)) continue;
      if (typeof part.type === "string" && part.type.startsWith("data-zoc-")) {
        if (isRecord(part.data)) parts.push(part.data);
        continue;
      }
      parts.push(part);
    }
  }
  return parts;
}
