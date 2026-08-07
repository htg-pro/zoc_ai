/**
 * Concurrent Run stream derivation — zoc-agent-chat-rebuild R25.2, R25.4, R25.5.
 * Feature: zoc-agent-chat-rebuild, task 29.2 (R25.2, R25.4, R25.5).
 *
 * The transcript remains owned by `useChat`; this module only builds selectable views over that
 * single source of truth. A Run is identified from assistant-message metadata first and from Zoc
 * data parts second, which keeps restored transcripts and an in-flight message on the same path.
 */
import type { RunLifecyclePart } from "@zoc-studio/shared-types";

import type { ZocUIMessage } from "./wire/ui-message";

export type RunStreamState =
  | "queued"
  | "running"
  | "awaiting-approval"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted";

const ACTIVE_STATES: ReadonlySet<RunStreamState> = new Set([
  "queued",
  "running",
  "awaiting-approval",
]);

export interface RunStream {
  readonly runId: string;
  readonly title: string;
  readonly state: RunStreamState;
  readonly queuePosition: number | null;
  readonly messages: readonly ZocUIMessage[];
  readonly agentNames: readonly string[];
  readonly startedAt: string | null;
  readonly lastSeq: number;
  readonly active: boolean;
}

function textOf(message: ZocUIMessage): string {
  return message.parts
    .filter(
      (part): part is Extract<ZocUIMessage["parts"][number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("")
    .trim();
}

function titleOf(messages: readonly ZocUIMessage[], runId: string): string {
  const user = messages.find((message) => message.role === "user");
  const text = user === undefined ? "" : (textOf(user).split(/\r?\n/u, 1)[0]?.trim() ?? "");
  if (text.length === 0) return `Run ${runId.slice(-6)}`;
  return text.length > 52 ? `${text.slice(0, 51)}…` : text;
}

function rawRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** A message's Run id, without trusting only one persistence generation. */
export function runIdOfMessage(message: ZocUIMessage): string | null {
  const metadataRunId = message.metadata?.runId;
  if (typeof metadataRunId === "string" && metadataRunId.length > 0) return metadataRunId;

  for (const part of message.parts) {
    if (!part.type.startsWith("data-zoc-")) continue;
    const data = rawRecord((part as { data?: unknown }).data);
    if (typeof data?.runId === "string" && data.runId.length > 0) return data.runId;
  }
  return null;
}

function lifecycleOf(messages: readonly ZocUIMessage[]): RunLifecyclePart | null {
  let newest: RunLifecyclePart | null = null;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "data-zoc-run") continue;
      if (newest === null || part.data.seq >= newest.seq) newest = part.data;
    }
  }
  return newest;
}

function agentsOf(messages: readonly ZocUIMessage[]): string[] {
  const names = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type.startsWith("data-zoc-")) {
        const data = rawRecord((part as { data?: unknown }).data);
        if (typeof data?.agentName === "string" && data.agentName.length > 0) {
          names.add(data.agentName);
        }
      }
      const raw = rawRecord(part);
      const metadata = rawRecord(raw?.providerMetadata);
      const callMetadata = rawRecord(raw?.callProviderMetadata);
      const resultMetadata = rawRecord(raw?.resultProviderMetadata);
      for (const container of [metadata, callMetadata, resultMetadata]) {
        const zoc = rawRecord(container?.zoc);
        if (typeof zoc?.agentName === "string" && zoc.agentName.length > 0) {
          names.add(zoc.agentName);
        }
      }
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

function lastSeqOf(messages: readonly ZocUIMessage[]): number {
  let last = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      if (!part.type.startsWith("data-zoc-")) continue;
      const data = rawRecord((part as { data?: unknown }).data);
      if (typeof data?.seq === "number" && Number.isFinite(data.seq))
        last = Math.max(last, data.seq);
    }
  }
  return last;
}

/**
 * Partition one Session transcript into Run-owned streams.
 *
 * A user turn is assigned to the next assistant message that names a Run. This is the persisted wire
 * shape: the user message itself predates admission and therefore has no `runId`, while the assistant
 * message receives it as soon as the runtime opens the Run.
 */
export function runStreamsOf(messages: readonly ZocUIMessage[]): readonly RunStream[] {
  const grouped = new Map<string, ZocUIMessage[]>();
  const order: string[] = [];
  let pendingUsers: ZocUIMessage[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      pendingUsers.push(message);
      continue;
    }

    const runId = runIdOfMessage(message);
    if (runId === null) continue;
    let stream = grouped.get(runId);
    if (stream === undefined) {
      stream = [];
      grouped.set(runId, stream);
      order.push(runId);
    }
    if (pendingUsers.length > 0) {
      stream.push(...pendingUsers);
      pendingUsers = [];
    }
    stream.push(message);
  }

  return order.map((runId) => {
    const streamMessages = grouped.get(runId) ?? [];
    const lifecycle = lifecycleOf(streamMessages);
    const metadata = [...streamMessages]
      .reverse()
      .find((message) => message.metadata?.runId === runId)?.metadata;
    const state: RunStreamState =
      lifecycle?.state ?? (metadata?.finishedAt == null ? "running" : "completed");
    return {
      runId,
      title: titleOf(streamMessages, runId),
      state,
      queuePosition:
        state === "queued" && typeof lifecycle?.queuePosition === "number"
          ? lifecycle.queuePosition
          : null,
      messages: streamMessages,
      agentNames: agentsOf(streamMessages),
      startedAt: metadata?.startedAt ?? lifecycle?.ts ?? null,
      lastSeq: lastSeqOf(streamMessages),
      active: ACTIVE_STATES.has(state),
    };
  });
}

/** Pick a stable focus, preferring the newest active Run and then the newest Run. */
export function defaultFocusedRunId(streams: readonly RunStream[]): string | null {
  for (let index = streams.length - 1; index >= 0; index -= 1) {
    const stream = streams[index];
    if (stream?.active === true) return stream.runId;
  }
  return streams.at(-1)?.runId ?? null;
}
