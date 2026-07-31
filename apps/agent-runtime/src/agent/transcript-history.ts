/**
 * Stored transcript ↔ runtime history — zoc-agent-chat-rebuild R15.6, R34.6.
 *
 * The adapter for the gap `composition.ts` documented. Its header said: the
 * design has the runtime rehydrate history from Workspace_Services, that endpoint
 * did not exist, so `loadHistory` answered `[]` and every Run was single-turn —
 * "Whoever adds the endpoint supplies this port and nothing else changes." The
 * endpoint now exists (`GET`/`PUT /v1/sessions/{id}/messages`), and this module is
 * that port, plus the persistence side of the same pair.
 *
 * ## Two conversions, in opposite directions
 *
 * **Out** (`persistence`): the Run's completed `ZocUIMessage[]` goes to the store
 * verbatim. Nothing is flattened, because the Chat_Surface has to get its parts
 * back — the diff hunks, the checkpoint references, the usage figures — and a
 * lossy write here would be a transcript that renders differently after a
 * restart than it did while it streamed.
 *
 * **In** (`loadHistory`): the stored documents become {@link HistoryMessage}s,
 * which is one flattened string per message. That is what compaction counts and
 * folds at, and the flattening is deliberately this module's job: the design's own
 * note says only the caller knows how its parts serialise.
 *
 * ## What the flattening keeps, and why the rest is dropped
 *
 * | Part | In the text? | Why |
 * |---|---|---|
 * | `text` | yes | It is the turn. |
 * | tool input / output | yes, as compact JSON | The model's own prior tool use is context it reasoned from; dropping it makes a resumed Session repeat calls it already made. |
 * | `reasoning` | no | Providers do not accept replayed thinking as input, and counting it would overstate the context a resend actually costs. |
 * | `data-zoc-*` | no | Plan, diff, usage, permission, and compaction parts are the *surface's* record of the Run. They are not model input, and serialising them would spend a resend's budget on rows the model never sees. |
 *
 * ## Legacy rows
 *
 * A pre-rebuild record is a flat `{role, content}` with no `parts` (R23.5). Its
 * `content` is used as the text rather than yielding an empty message, so an
 * upgraded install's older conversations still give a Run its context instead of
 * silently reading as blank turns.
 */

import type { CompactionPart, MessagePart } from "@zoc-studio/shared-types";

import type { HistoryMessage } from "./compaction.ts";
import type { ZocUIMessage } from "./build-agent.ts";
import type { WorkspaceClient } from "../tools/workspace-client.ts";

/** Roles a `HistoryMessage` can carry. A stored `tool` row is not one of them. */
const MODEL_ROLES: ReadonlySet<string> = new Set(["system", "user", "assistant"]);

interface StoredRecord {
  readonly id?: unknown;
  readonly role?: unknown;
  readonly content?: unknown;
  readonly parts?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A tool part's arguments or result, as short a string as carries the meaning. */
function serialiseToolPayload(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    // A circular or unserialisable payload is still evidence the call happened,
    // and losing the whole message over it would be worse than losing the args.
    return "";
  }
}

/** One stored message's text, as the provider will receive it. */
export function flattenParts(record: StoredRecord): string {
  const parts = Array.isArray(record.parts) ? record.parts : [];
  const pieces: string[] = [];

  for (const part of parts) {
    if (!isObject(part)) continue;
    const type = typeof part.type === "string" ? part.type : "";

    if (type === "text" && typeof part.text === "string") {
      pieces.push(part.text);
      continue;
    }
    // The AI SDK names a tool part `tool-<name>`; a dynamic tool is
    // `dynamic-tool`. Both carry `input` and `output` at the part's top level.
    if (type.startsWith("tool-") || type === "dynamic-tool") {
      const name = typeof part.toolName === "string" ? part.toolName : type.slice("tool-".length);
      const input = serialiseToolPayload(part.input);
      const output = serialiseToolPayload(part.output ?? part.errorText);
      pieces.push(
        [`[tool ${name}]`, input === "" ? "" : ` ${input}`, output === "" ? "" : ` → ${output}`]
          .join("")
          .trim(),
      );
      continue;
    }
  }

  if (pieces.length === 0 && typeof record.content === "string") {
    // Legacy row (R23.5): flat content, no parts.
    return record.content;
  }
  return pieces.join("\n\n");
}

/**
 * Stored documents as the history a Run is assembled from, oldest first.
 *
 * Unreadable records are skipped rather than raising: the store already filters
 * what it cannot index by, and a record this function cannot flatten is a turn
 * missing from one Run's context — where a throw is every Run failing on a
 * Session that has one bad row in it.
 */
export function historyFrom(records: readonly unknown[]): readonly HistoryMessage[] {
  const history: HistoryMessage[] = [];
  for (const raw of records) {
    if (!isObject(raw)) continue;
    const record = raw as StoredRecord;
    const id = typeof record.id === "string" ? record.id : "";
    const role = typeof record.role === "string" ? record.role : "";
    if (id === "" || !MODEL_ROLES.has(role)) continue;
    history.push({
      id,
      role: role as HistoryMessage["role"],
      text: flattenParts(record),
    });
  }
  return history;
}

/**
 * The Zoc data parts carried by a stored transcript, in stored order.
 *
 * `useChat` stores a data part as `{ type: "data-zoc-compaction", id, data }`, so
 * the wire part is the `data` payload. Extracted here because `pinFrom` reads
 * `MessagePart`s and the transcript holds their UI wrappers — the one place that
 * asymmetry has to be known.
 */
export function dataPartsFrom(records: readonly unknown[]): readonly MessagePart[] {
  const parts: MessagePart[] = [];
  for (const raw of records) {
    if (!isObject(raw)) continue;
    const list = Array.isArray(raw.parts) ? raw.parts : [];
    for (const part of list) {
      if (!isObject(part)) continue;
      if (typeof part.type !== "string" || !part.type.startsWith("data-zoc-")) continue;
      if (isObject(part.data) && typeof part.data.type === "string") {
        parts.push(part.data as unknown as MessagePart);
      }
    }
  }
  return parts;
}

/** The compaction parts alone, for `pinFrom` (R34.6). */
export function compactionPartsFrom(records: readonly unknown[]): readonly CompactionPart[] {
  return dataPartsFrom(records).filter(
    (part): part is CompactionPart => part.type === "compaction",
  );
}

export interface TranscriptHistory {
  /** `RuntimeDeps.loadHistory` — prior turns for a Session, oldest first. */
  loadHistory(sessionId: string): Promise<readonly HistoryMessage[]>;
  /** The stored records, for a caller that needs the parts rather than the text. */
  loadRecords(sessionId: string): Promise<readonly unknown[]>;
  /** `RunContext.persistence` — R15.6's write, including for an aborted Run. */
  persist(input: {
    readonly sessionId: string;
    readonly runId: string;
    readonly messages: readonly ZocUIMessage[];
    readonly aborted: boolean;
  }): Promise<void>;
}

/**
 * Bind both directions to a Workspace_Services client.
 *
 * **Neither direction throws.** A Session whose transcript cannot be read starts
 * its Run single-turn, and a Run whose transcript cannot be written still
 * finishes and still streams — R6.6's rule, applied to a call the *user did not
 * ask for*: the alternative is losing an answer the user already read because a
 * restarting sidecar refused a write. The failure is logged and the Run stands.
 */
export function createTranscriptHistory(
  client: WorkspaceClient,
  log: (message: string, detail: string) => void = () => undefined,
): TranscriptHistory {
  const loadRecords = async (sessionId: string): Promise<readonly unknown[]> => {
    const outcome = await client.listMessages(sessionId);
    if (!outcome.ok) {
      log("transcript read failed", `${outcome.code}: ${outcome.message}`);
      return [];
    }
    return outcome.value;
  };

  return {
    loadRecords,
    loadHistory: async (sessionId) => historyFrom(await loadRecords(sessionId)),
    persist: async ({ sessionId, messages, aborted, runId }) => {
      const outcome = await client.replaceMessages(sessionId, messages);
      if (!outcome.ok) {
        log(
          "transcript write failed",
          `run ${runId}${aborted ? " (aborted)" : ""} — ${outcome.code}: ${outcome.message}`,
        );
      }
    },
  };
}
