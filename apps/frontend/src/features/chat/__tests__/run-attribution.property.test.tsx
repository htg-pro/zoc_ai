/**
 * Property 61: Concurrent Runs are separately selectable and correctly attributed.
 * Validates R25.4 and R25.5.
 */
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import fc from "fast-check";

import { RunStreamSelector } from "@/features/chat/RunStreamSelector";
import {
  defaultFocusedRunId,
  runStreamsOf,
  type RunStreamState,
} from "@/features/chat/run-streams";
import { rowsOfMessage } from "@/features/chat/transcript-model";
import type { ZocUIMessage, ZocMessageMetadata } from "@/features/chat/wire/ui-message";

const RUNS = { numRuns: 100 } as const;

const states: readonly RunStreamState[] = [
  "queued",
  "running",
  "awaiting-approval",
  "completed",
  "cancelled",
  "failed",
  "interrupted",
];

interface GeneratedRun {
  readonly prompt: string;
  readonly state: RunStreamState;
  readonly queuePosition: number;
  readonly agents: readonly string[];
}

const generatedRun: fc.Arbitrary<GeneratedRun> = fc.record({
  prompt: fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{0,40}$/),
  state: fc.constantFrom(...states),
  queuePosition: fc.integer({ min: 1, max: 32 }),
  agents: fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9_-]{0,12}$/), {
    minLength: 0,
    maxLength: 4,
  }),
});

function metadata(runId: string, state: RunStreamState, index: number): ZocMessageMetadata {
  return {
    runId,
    provider: "openai",
    model: "gpt-test",
    conversationMode: "agent",
    startedAt: new Date(index * 1_000).toISOString(),
    finishedAt: state === "completed" ? new Date(index * 1_000 + 500).toISOString() : null,
    inputTokens: 1,
    outputTokens: 1,
    estimatedCostCents: 0,
    tokensPerSecond: 1,
    messagesInContext: 1,
    sessionMessageCount: 2,
    messagesOutOfWindow: 0,
    summaryActive: false,
    rulesSources: [],
  };
}

function transcriptOf(specs: readonly GeneratedRun[]): ZocUIMessage[] {
  return specs.flatMap((spec, index) => {
    const runId = `run_${String(index)}`;
    const messageId = `assistant_${String(index)}`;
    const user: ZocUIMessage = {
      id: `user_${String(index)}`,
      role: "user",
      parts: [{ type: "text", text: spec.prompt }],
    };
    const assistant: ZocUIMessage = {
      id: messageId,
      role: "assistant",
      metadata: metadata(runId, spec.state, index),
      parts: [
        {
          type: "data-zoc-run",
          id: runId,
          data: {
            type: "run-lifecycle",
            seq: 1,
            runId,
            messageId,
            ts: new Date(index * 1_000).toISOString(),
            agentName: null,
            state: spec.state,
            queuePosition: spec.state === "queued" ? spec.queuePosition : null,
            code: spec.state === "failed" ? "model_unavailable" : null,
          },
        },
        ...spec.agents.map((agentName, agentIndex) => ({
          type: "data-zoc-usage" as const,
          id: `${runId}:usage:${agentName}`,
          data: {
            type: "usage" as const,
            seq: agentIndex + 2,
            runId,
            messageId,
            ts: new Date(index * 1_000 + agentIndex + 1).toISOString(),
            agentName,
            inputTokens: 1,
            outputTokens: 1,
            reasoningTokens: 0,
            cachedInputTokens: 0,
            contextLimit: 8_192,
            estimatedCostCents: 0,
            tokensPerSecond: 1,
            messagesInContext: 1,
            sessionMessageCount: 2,
            messagesOutOfWindow: 0,
            summaryActive: false,
          },
        })),
      ],
    };
    return [user, assistant];
  });
}

afterEach(cleanup);

describe("Feature: zoc-agent-chat-rebuild, Property 61: concurrent Run selection and attribution", () => {
  it("partitions every Run into one independently selectable stream with its own status", () => {
    fc.assert(
      fc.property(fc.array(generatedRun, { minLength: 1, maxLength: 8 }), (specs) => {
        const streams = runStreamsOf(transcriptOf(specs));
        expect(streams).toHaveLength(specs.length);

        streams.forEach((stream, index) => {
          const spec = specs[index]!;
          expect(stream.runId).toBe(`run_${String(index)}`);
          expect(stream.state).toBe(spec.state);
          expect(stream.queuePosition).toBe(spec.state === "queued" ? spec.queuePosition : null);
          expect(stream.messages).toHaveLength(2);
          expect(stream.messages[0]?.role).toBe("user");
          expect(stream.messages[1]?.metadata?.runId).toBe(stream.runId);
          expect(stream.agentNames).toEqual([...spec.agents].sort((a, b) => a.localeCompare(b)));
        });

        const active = streams.filter((stream) => stream.active).at(-1);
        expect(defaultFocusedRunId(streams)).toBe(active?.runId ?? streams.at(-1)?.runId ?? null);
      }),
      RUNS,
    );
  });

  it("marks exactly the selected Run as holding composer focus", () => {
    fc.assert(
      fc.property(
        fc.array(generatedRun, { minLength: 2, maxLength: 6 }),
        fc.nat(),
        (specs, targetSeed) => {
          cleanup();
          const streams = runStreamsOf(transcriptOf(specs));
          const initial = streams[0]!.runId;
          const target = streams[targetSeed % streams.length]!.runId;

          function Harness() {
            const [focused, setFocused] = useState(initial);
            return (
              <RunStreamSelector streams={streams} focusedRunId={focused} onFocus={setFocused} />
            );
          }

          render(<Harness />);
          fireEvent.click(document.querySelector(`[data-zoc-run-stream="${target}"]`)!);

          const tabs = [...document.querySelectorAll("[data-zoc-run-stream]")];
          expect(tabs).toHaveLength(streams.length);
          expect(tabs.filter((tab) => tab.getAttribute("aria-selected") === "true")).toHaveLength(
            1,
          );
          expect(
            document
              .querySelector(`[data-zoc-run-stream="${target}"]`)
              ?.getAttribute("data-zoc-composer-focus"),
          ).toBe("true");
        },
      ),
      RUNS,
    );
  });

  it("carries each sub-agent name onto the rows produced inside its parent Run", () => {
    fc.assert(
      fc.property(
        generatedRun.filter((spec) => spec.agents.length > 0),
        (spec) => {
          const assistant = transcriptOf([spec])[1]!;
          const attributed = rowsOfMessage(assistant)
            .filter((row) => row.kind === "usage")
            .map((row) => row.agentName);
          expect(attributed).toEqual(spec.agents);
        },
      ),
      RUNS,
    );
  });
});
