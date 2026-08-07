/** Session-wide usage arithmetic — zoc-agent-chat-rebuild Property 66 (R27.1–R27.3). */
/** Feature: zoc-agent-chat-rebuild, Property 66 (R27.1, R27.2, R27.3). */

import type { UsagePart } from "@zoc-studio/shared-types";
import type { ZocUIMessage } from "./wire/ui-message";

export interface SessionUsageTotals {
  readonly runCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly estimatedCostCents: number;
  readonly contextUsedTokens: number;
  readonly contextLimit: number;
  readonly contextProportion: number;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(1, value);
}

/** Sum the newest reconciled UsagePart for each Run, never every streamed revision. */
export function cumulativeUsageOf(messages: readonly ZocUIMessage[]): SessionUsageTotals {
  const byRun = new Map<string, UsagePart>();
  let newest: UsagePart | null = null;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "data-zoc-usage") continue;
      const usage = part.data;
      const current = byRun.get(usage.runId);
      if (current === undefined || usage.seq >= current.seq) byRun.set(usage.runId, usage);
      if (newest === null || usage.seq >= newest.seq || usage.ts > newest.ts) newest = usage;
    }
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let estimatedCostCents = 0;
  for (const usage of byRun.values()) {
    inputTokens += Math.max(0, usage.inputTokens);
    outputTokens += Math.max(0, usage.outputTokens);
    estimatedCostCents += Math.max(0, usage.estimatedCostCents ?? 0);
  }
  const contextUsedTokens =
    newest === null ? 0 : Math.max(0, newest.inputTokens) + Math.max(0, newest.outputTokens);
  const contextLimit = newest === null ? 0 : Math.max(0, newest.contextLimit);

  return {
    runCount: byRun.size,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedCostCents,
    contextUsedTokens,
    contextLimit,
    contextProportion: contextLimit > 0 ? clampUnit(contextUsedTokens / contextLimit) : 0,
  };
}
