/**
 * The Run stream — zoc-agent-chat-rebuild task 9.6 (R5.1, R8.1, R8.2, R9.1,
 * R15.6, R30.4), plus the ordering half of R7.7.
 *
 * Feature: zoc-agent-chat-rebuild, task 9.6 (R5.1, R8.1, R8.2, R9.1, R15.6, R30.4).
 *
 * These tests assert the *order* of a Run's emissions as much as their content,
 * because ordering is the part of the contract a refactor breaks silently. In
 * particular: the terminal `run-lifecycle` is last, the `finish` chunk carrying
 * the metadata is immediately before it (`SeqFraming` drops anything behind the
 * terminal lifecycle, so the reverse order loses the metadata), and the SDK's own
 * `tool-input-*` chunks arrive before the tool's output — which is what satisfies
 * R9.1 without an `onToolCallStart` hook that `ToolLoopAgentSettings` does not
 * have.
 */

import { describe, expect, it } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import { MockLanguageModelV3, convertReadableStreamToArray, simulateReadableStream } from "ai/test";

import {
  MAX_STEPS,
  PIN_HEADING,
  buildAgent,
  createNullTokenRateMeter,
  createTokenRateMeter,
  instructionsFor,
  streamRun,
  toModelMessages,
  type RunContext,
  type RunMessageMetadata,
  type RunPersistence,
  type ZocUIChunk,
} from "../build-agent.ts";
import { COMPLETION_TOOL, type ToolDescriptor } from "../../tools/registry.ts";
import { ErrorCode } from "../../http/errors.ts";
import type { AssembledRequest, CompactionContext } from "../compaction.ts";
import type { AssembledInstructions } from "../system-instructions.ts";

// ── Fixtures ──────────────────────────────────────────────────────────

/** The provider's stream-part type, inferred rather than imported: `@ai-sdk/provider` is not a direct dependency. */
type StreamPart =
  Awaited<ReturnType<MockLanguageModelV3["doStream"]>>["stream"] extends ReadableStream<infer Part>
    ? Part
    : never;

function usage(input: number, output: number): Extract<StreamPart, { type: "finish" }>["usage"] {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

/** A step that says `text`, then calls `declare_complete`, which ends the loop. */
function completingStep(text: string): StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t0" },
    { type: "text-delta", id: "t0", delta: text },
    { type: "text-end", id: "t0" },
    { type: "tool-input-start", id: "c0", toolName: COMPLETION_TOOL },
    { type: "tool-input-delta", id: "c0", delta: '{"summary":"done"}' },
    { type: "tool-input-end", id: "c0" },
    {
      type: "tool-call",
      toolCallId: "c0",
      toolName: COMPLETION_TOOL,
      input: '{"summary":"done"}',
    },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: undefined },
      usage: usage(11, 7),
    },
  ];
}

/** Two text deltas, so there is an interval for the rate meter to measure. */
function twoDeltaStep(first: string, second: string): StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t0" },
    { type: "text-delta", id: "t0", delta: first },
    { type: "text-delta", id: "t0", delta: second },
    { type: "text-end", id: "t0" },
    { type: "tool-input-start", id: "c0", toolName: COMPLETION_TOOL },
    { type: "tool-input-delta", id: "c0", delta: '{"summary":"done"}' },
    { type: "tool-input-end", id: "c0" },
    {
      type: "tool-call",
      toolCallId: "c0",
      toolName: COMPLETION_TOOL,
      input: '{"summary":"done"}',
    },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: undefined },
      usage: usage(11, 7),
    },
  ];
}

/** A step that says nothing and reports no output tokens. */
function silentStep(): StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id: "c0", toolName: COMPLETION_TOOL },
    { type: "tool-input-delta", id: "c0", delta: '{"summary":"done"}' },
    { type: "tool-input-end", id: "c0" },
    {
      type: "tool-call",
      toolCallId: "c0",
      toolName: COMPLETION_TOOL,
      input: '{"summary":"done"}',
    },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: undefined },
      usage: usage(11, 0),
    },
  ];
}

/** A step that calls `workspace_read` with input its schema rejects. */
function malformedToolStep(): StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id: "r0", toolName: "workspace_read" },
    { type: "tool-input-delta", id: "r0", delta: '{"path":123}' },
    { type: "tool-input-end", id: "r0" },
    {
      type: "tool-call",
      toolCallId: "r0",
      toolName: "workspace_read",
      // `path` is declared `z.string()`, so a number fails validation before `execute`.
      input: '{"path":123}',
    },
    { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: usage(5, 3) },
  ];
}

/** A step that calls `workspace_read`, so a tool actually executes. */
function toolStep(path: string): StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id: "r0", toolName: "workspace_read" },
    { type: "tool-input-delta", id: "r0", delta: JSON.stringify({ path }) },
    { type: "tool-input-end", id: "r0" },
    {
      type: "tool-call",
      toolCallId: "r0",
      toolName: "workspace_read",
      input: JSON.stringify({ path }),
    },
    { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: usage(5, 3) },
  ];
}

/** A model that plays the given steps in order, one per `doStream` call. */
function modelOf(steps: StreamPart[][]): MockLanguageModelV3 {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const chunks = steps[Math.min(call, steps.length - 1)] ?? [];
      call += 1;
      return {
        stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
      };
    },
  });
}

/** The terminal signal: callable, and with no `execute` (R11.3). */
const completion: ToolDescriptor = {
  name: COMPLETION_TOOL,
  kind: "read",
  description: "",
  tool: tool({ description: "", inputSchema: z.object({ summary: z.string() }) }),
};

function readTool(onCall: (path: string) => void): ToolDescriptor {
  return {
    name: "workspace_read",
    kind: "read",
    description: "",
    tool: tool({
      description: "",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        onCall(path);
        return { ok: true, content: "x" };
      },
    }),
  };
}

const instructions: AssembledInstructions = {
  instructions: "BASE",
  appliedSources: ["workspace/AGENTS.md", "user/rules.md"],
  skipped: [],
};

function request(overrides: Partial<AssembledRequest> = {}): AssembledRequest {
  return {
    instructions: "BASE",
    pin: null,
    mentions: [],
    toolSchemas: [],
    messages: [{ id: "m1", role: "user", text: "hello" }],
    contextLimit: 100_000,
    sessionMessageCount: 1,
    ...overrides,
  };
}

function contextOf(overrides: Partial<RunContext> = {}): RunContext {
  return {
    runId: "run_1",
    sessionId: "sess_1",
    messageId: "msg_1",
    provider: "anthropic",
    model: "claude-opus-5",
    languageModel: modelOf([completingStep("hi")]),
    conversationMode: "agent",
    permissionMode: "auto",
    instructions,
    request: request(),
    bind: () => ({ descriptors: [completion] }),
    now: () => new Date("2026-07-30T00:00:00.000Z"),
    ...overrides,
  };
}

async function run(overrides: Partial<RunContext> = {}): Promise<ZocUIChunk[]> {
  return convertReadableStreamToArray(streamRun(contextOf(overrides)));
}

/** The chunk types in order, which is what most of these assertions are about. */
const typesOf = (chunks: readonly ZocUIChunk[]): string[] => chunks.map((chunk) => chunk.type);

function dataParts<T>(chunks: readonly ZocUIChunk[], type: string): T[] {
  const found: T[] = [];
  for (const chunk of chunks) {
    if (chunk.type === type && "data" in chunk) found.push(chunk.data as T);
  }
  return found;
}

// ── buildAgent ────────────────────────────────────────────────────────

describe("buildAgent", () => {
  it("refuses a tool map with no terminal signal", () => {
    expect(() =>
      buildAgent({
        model: modelOf([completingStep("hi")]),
        instructions: "BASE",
        descriptors: [readTool(() => undefined)],
        experimentalContext: {},
      }),
    ).toThrow(/stopWhen can only ever fire on the step ceiling/);
  });

  it("keeps R8.2's step ceiling at forty", () => {
    expect(MAX_STEPS).toBe(40);
  });
});

// ── Request shaping ───────────────────────────────────────────────────

describe("request shaping", () => {
  it("appends a pin to the instructions rather than to the messages", () => {
    const withPin = request({
      pin: { compactionId: "cmp_1", summary: "we discussed X", foldedMessageIds: ["m0"] },
    });
    expect(instructionsFor(instructions, withPin)).toBe(`BASE\n\n${PIN_HEADING}\nwe discussed X`);
    // No pin, no heading: an empty section would read as "nothing was folded"
    // where the truth is "nothing has ever been folded".
    expect(instructionsFor(instructions, request())).toBe("BASE");
  });

  it("drops the system entry viewOf prepends", () => {
    const converted = toModelMessages(
      request({
        messages: [
          { id: "cmp_1:summary", role: "system", text: "summary" },
          { id: "m1", role: "user", text: "hello" },
          { id: "m2", role: "assistant", text: "hi" },
        ],
      }),
    );
    expect(converted).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });

  it("places document text and image data on the newest user turn (R29.2/R29.4)", () => {
    const converted = toModelMessages(
      request({
        messages: [
          { id: "m1", role: "user", text: "older" },
          { id: "m2", role: "assistant", text: "answer" },
          { id: "m3", role: "user", text: "inspect these" },
        ],
        attachments: [
          {
            kind: "document",
            name: "notes.txt",
            mediaType: "text/plain",
            size: 5,
            text: "hello",
            estimatedTokens: 2,
          },
          {
            kind: "image",
            name: "screen.png",
            mediaType: "image/png",
            size: 2,
            dataUrl: "data:image/png;base64,AA==",
            estimatedTokens: 0,
          },
        ],
      }),
    );
    expect(converted[0]).toEqual({ role: "user", content: "older" });
    expect(converted[2]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "inspect these\n\n[Attached document: notes.txt]\nhello" },
        { type: "image", image: "AA==", mediaType: "image/png" },
      ],
    });
  });
});

// ── Ordering ──────────────────────────────────────────────────────────

describe("streamRun ordering (R7.7)", () => {
  it("opens with start then the running lifecycle", async () => {
    const chunks = await run();
    expect(chunks[0]?.type).toBe("start");
    expect(chunks[1]?.type).toBe("data-zoc-run");
    expect(dataParts<{ state: string }>(chunks, "data-zoc-run")[0]?.state).toBe("running");
  });

  it("ends with the terminal lifecycle, with finish immediately before it", async () => {
    const chunks = await run();
    const last = chunks.at(-1);
    const penultimate = chunks.at(-2);
    expect(penultimate?.type).toBe("finish");
    expect(last?.type).toBe("data-zoc-run");
    expect((last as { data: { state: string } }).data.state).toBe("completed");
    // Only one terminal lifecycle, and no lifecycle after it. Also the guard on
    // the SDK's chunk aliasing: both lifecycle chunks share a reconciliation id,
    // and `processUIMessageStream` folds a repeat id in by reseating the earlier
    // chunk's `data`. Without the copy `streamRun` takes on the way out this reads
    // `["completed", "completed"]` and the surface never sees the Run start.
    const states = dataParts<{ state: string }>(chunks, "data-zoc-run").map((part) => part.state);
    expect(states).toEqual(["running", "completed"]);
  });

  it("emits the tool-input chunks before the tool's output (R9.1)", async () => {
    const calls: string[] = [];
    const chunks = await run({
      languageModel: modelOf([toolStep("src/index.ts"), completingStep("read it")]),
      bind: () => ({ descriptors: [readTool((path) => calls.push(path)), completion] }),
    });
    const types = typesOf(chunks);
    const inputStart = types.indexOf("tool-input-start");
    const inputAvailable = types.indexOf("tool-input-available");
    const output = types.indexOf("tool-output-available");
    expect(inputStart).toBeGreaterThan(-1);
    expect(inputAvailable).toBeGreaterThan(inputStart);
    expect(output).toBeGreaterThan(inputAvailable);
    expect(calls).toEqual(["src/index.ts"]);
  });

  it("stops on declare_complete rather than running to the ceiling", async () => {
    const model = modelOf([completingStep("hi")]);
    await run({ languageModel: model });
    expect(model.doStreamCalls).toHaveLength(1);
  });
});

// ── Metadata and usage ────────────────────────────────────────────────

describe("metadata and usage", () => {
  const metadataOf = (chunk: ZocUIChunk | undefined): RunMessageMetadata =>
    (chunk as { messageMetadata: RunMessageMetadata }).messageMetadata;

  it("carries the applied rules sources on start, before any text (R30.4)", async () => {
    const chunks = await run();
    const start = metadataOf(chunks[0]);
    expect(start.rulesSources).toEqual(["workspace/AGENTS.md", "user/rules.md"]);
    expect(start.runId).toBe("run_1");
    expect(start.conversationMode).toBe("agent");
    // Open, not finished: a `finishedAt` on `start` would be a lie the surface
    // would render as a completed Run.
    expect(start.finishedAt).toBeNull();
  });

  it("closes the metadata with the provider's totals and a finish time", async () => {
    const chunks = await run();
    const finish = metadataOf(chunks.at(-2));
    expect(finish.finishedAt).toBe("2026-07-30T00:00:00.000Z");
    expect(finish.inputTokens).toBe(11);
    expect(finish.outputTokens).toBe(7);
  });

  it("uses the same id for the message and its data parts", async () => {
    const chunks = await run();
    expect((chunks[0] as { messageId?: string }).messageId).toBe("msg_1");
    for (const part of dataParts<{ messageId: string }>(chunks, "data-zoc-run")) {
      expect(part.messageId).toBe("msg_1");
    }
  });

  it("reports the context census and the model's window on every usage part", async () => {
    const chunks = await run({
      request: request({ sessionMessageCount: 9, contextLimit: 32_000 }),
    });
    const parts = dataParts<{
      contextLimit: number;
      messagesInContext: number;
      sessionMessageCount: number;
      messagesOutOfWindow: number;
      summaryActive: boolean;
      outputTokens: number;
    }>(chunks, "data-zoc-usage");
    expect(parts.length).toBeGreaterThan(0);
    for (const part of parts) {
      expect(part.contextLimit).toBe(32_000);
      expect(part.messagesInContext).toBe(1);
      expect(part.sessionMessageCount).toBe(9);
      expect(part.messagesOutOfWindow).toBe(8);
      expect(part.summaryActive).toBe(false);
    }
    // The row climbs rather than flickers: the last reading is the total.
    expect(parts.at(-1)?.outputTokens).toBe(7);
  });

  it("leaves tokensPerSecond null when nothing measured it (R13.8)", async () => {
    const chunks = await run({ rate: createNullTokenRateMeter() });
    for (const part of dataParts<{ tokensPerSecond: number | null }>(chunks, "data-zoc-usage")) {
      expect(part.tokensPerSecond).toBeNull();
    }
  });

  it("routes every text delta through the rate meter", async () => {
    const observed: number[] = [];
    await run({
      rate: {
        observeDelta: (tokens) => observed.push(tokens),
        reconcile: () => undefined,
        pause: () => undefined,
        resume: () => undefined,
        current: () => 42,
        activeMs: 0,
      },
    });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toBeCloseTo("hi".length / 4);
  });

  it("reports a measured rate on the usage row, from the provider's count (9.9)", async () => {
    // Two deltas a second apart, and the provider reporting seven output tokens: seven
    // tokens per second. The estimate the deltas produced (`"hello"` and `"there"` over
    // four characters, ~2.5) is replaced rather than averaged with.
    let tick = 0;
    const chunks = await run({
      languageModel: modelOf([twoDeltaStep("hello", "there")]),
      rate: createTokenRateMeter({ now: () => (tick += 1_000) }),
    });

    const parts = dataParts<{ tokensPerSecond: number | null }>(chunks, "data-zoc-usage");
    expect(parts.at(-1)?.tokensPerSecond).toBe(7);
  });

  it("reports tokensPerSecond null for a Run that generated no output (R13.10)", async () => {
    // 9.9's second guard, at the Run level. The model calls the terminal tool without
    // saying anything and the provider reports zero output tokens; a `0` here would
    // travel to the picker as a claim that this model runs at zero tokens per second.
    let tick = 0;
    const chunks = await run({
      languageModel: modelOf([silentStep()]),
      rate: createTokenRateMeter({ now: () => (tick += 1_000) }),
    });

    const parts = dataParts<{ tokensPerSecond: number | null; outputTokens: number }>(
      chunks,
      "data-zoc-usage",
    );
    expect(parts.at(-1)?.outputTokens).toBe(0);
    expect(parts.at(-1)?.tokensPerSecond).toBeNull();
  });
});

// ── Binding ───────────────────────────────────────────────────────────

describe("the Run's binding", () => {
  it("hands the tools a writer that is this Run's, plus whatever the binding added", async () => {
    let seen: Record<string, unknown> | null = null;
    const probe: ToolDescriptor = {
      name: "workspace_read",
      kind: "read",
      description: "",
      tool: tool({
        description: "",
        inputSchema: z.object({ path: z.string() }),
        execute: async (_input, options) => {
          seen = options.experimental_context as Record<string, unknown>;
          return { ok: true };
        },
      }),
    };

    const gate = { name: "the gate" };
    await run({
      languageModel: modelOf([toolStep("a.ts"), completingStep("done")]),
      bind: (writer) => {
        expect(writer.runId).toBe("run_1");
        expect(writer.messageId).toBe("msg_1");
        return { descriptors: [probe, completion], context: { gate } };
      },
    });

    const context = seen as unknown as Record<string, unknown>;
    expect(context).not.toBeNull();
    expect(context.runId).toBe("run_1");
    expect(context.sessionId).toBe("sess_1");
    expect(context.mode).toBe("agent");
    expect(context.permissionMode).toBe("auto");
    expect(context.gate).toBe(gate);
    expect(context.writer).toBeDefined();
  });
});

// ── Malformed tool input (R22.3, task 9.10) ───────────────────────────

describe("a tool call the schema rejects", () => {
  /**
   * The chunk a rejected call produces.
   *
   * `tool-output-error`, not `tool-input-error`, and that is the whole point of
   * `tolerantTools`: the check moved into the tool's own `execute`, so the mismatch is
   * reported as the tool failing rather than as the stream failing.
   */
  function toolErrors(chunks: readonly ZocUIChunk[]): Array<{
    toolCallId?: string;
    errorText?: string;
    providerMetadata?: Record<string, unknown>;
  }> {
    return chunks
      .filter((chunk) => chunk.type === "tool-output-error")
      .map(
        (chunk) =>
          chunk as unknown as {
            toolCallId?: string;
            errorText?: string;
            providerMetadata?: Record<string, unknown>;
          },
      );
  }

  it("carries tool_schema_invalid and does not end the Run", async () => {
    const executed: string[] = [];
    const chunks = await run({
      languageModel: modelOf([malformedToolStep(), completingStep("fixed it")]),
      bind: () => ({
        descriptors: [readTool((path) => executed.push(path)), completion],
      }),
    });

    // The code rides in `providerMetadata.zoc`, because the native tool part has an
    // `errorText` and nothing else (design.md:1187). Without it the surface renders a
    // failed step it cannot classify.
    const errors = toolErrors(chunks);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.providerMetadata).toEqual({
      zoc: { code: ErrorCode.TOOL_SCHEMA_INVALID, retryable: false, details: null },
    });

    // The tool body never ran — the wrapper rejected before delegating — and the Run
    // continued to a second step and completed. That is the half of R22.3 that matters: a
    // model that mistypes an argument gets a correction, not a dead Run.
    expect(executed).toEqual([]);
    const states = dataParts<{ state: string }>(chunks, "data-zoc-run").map((part) => part.state);
    expect(states).toEqual(["running", "completed"]);
    expect(dataParts<unknown>(chunks, "data-zoc-error")).toEqual([]);
  });

  it("names the tool in the text the model reads back, without a path or an id", async () => {
    const chunks = await run({
      languageModel: modelOf([malformedToolStep(), completingStep("fixed it")]),
      bind: () => ({ descriptors: [readTool(() => undefined), completion] }),
    });

    const error = toolErrors(chunks)[0];
    expect(error?.toolCallId).toBe("r0");
    expect(error?.errorText).toContain("workspace_read");
    expect(error?.errorText).toContain("did not match its schema");
  });

  it("still shows the model the real schema, not the lenient one", async () => {
    // The provider's view is the contract. Moving the check inward must not degrade the
    // JSON Schema the model is given, or a rare failure would have been traded for a
    // permanently worse prompt.
    const agent = buildAgent({
      model: modelOf([completingStep("hi")]),
      instructions: "BASE",
      descriptors: [readTool(() => undefined), completion],
      experimentalContext: {},
      rejectedInputs: new Set<string>(),
    });

    const tools = (agent as unknown as { tools: Record<string, { inputSchema: unknown }> }).tools;
    const schema = await (
      tools.workspace_read?.inputSchema as { jsonSchema: Promise<unknown> | unknown }
    ).jsonSchema;
    expect(schema).toMatchObject({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    });
  });

  it("leaves a code another layer already set alone", async () => {
    // The permission gate and the driver's abandonment both write their own
    // `providerMetadata.zoc`; overwriting a `permission_denied` with a generic code would
    // lose the only field that says why the step failed.
    const chunks = await run({
      languageModel: modelOf([toolStep("a.ts"), completingStep("done")]),
      bind: () => ({
        descriptors: [
          {
            name: "workspace_read",
            kind: "read" as const,
            description: "",
            tool: tool({
              description: "",
              inputSchema: z.object({ path: z.string() }),
              execute: async (): Promise<{ ok: boolean }> => {
                throw new Error("the tool itself is broken");
              },
            }),
          },
          completion,
        ],
      }),
    });

    const outputErrors = chunks
      .filter((chunk) => chunk.type === "tool-output-error")
      .map((chunk) => chunk as unknown as { providerMetadata?: Record<string, unknown> });
    expect(outputErrors).toHaveLength(1);
    // A tool that throws rather than returning an outcome is a defect in the tool, not
    // something the model can fix, so it is `internal` and not retryable.
    expect(outputErrors[0]?.providerMetadata).toEqual({
      zoc: { code: ErrorCode.INTERNAL, retryable: false, details: null },
    });
  });
});

// ── Persistence (R15.6) ───────────────────────────────────────────────

describe("persistence", () => {
  interface PersistInput {
    readonly sessionId: string;
    readonly runId: string;
    readonly aborted: boolean;
    readonly messages: readonly unknown[];
  }

  function recorder(): { calls: PersistInput[]; persistence: RunPersistence } {
    const calls: PersistInput[] = [];
    return {
      calls,
      persistence: {
        persist: async (input) => {
          calls.push(input);
        },
      },
    };
  }

  it("persists the finished Run's messages, unflagged", async () => {
    const { calls, persistence } = recorder();
    await run({ persistence });
    expect(calls).toHaveLength(1);
    const input = calls[0];
    expect(input?.sessionId).toBe("sess_1");
    expect(input?.runId).toBe("run_1");
    expect(input?.aborted).toBe(false);
    expect(input?.messages.length).toBeGreaterThan(0);
  });

  it("still persists when the provider fails, so the turn is not lost", async () => {
    const { calls, persistence } = recorder();
    await run({
      languageModel: new MockLanguageModelV3({
        doStream: async () => {
          throw new Error("upstream exploded");
        },
      }),
      persistence,
    });
    expect(calls).toHaveLength(1);
  });
});

// ── Failure and cancellation ──────────────────────────────────────────

describe("failure", () => {
  const failing = () =>
    new MockLanguageModelV3({
      doStream: async () => {
        throw new Error("upstream exploded");
      },
    });

  it("reports a provider failure as parts and still finishes the stream", async () => {
    const chunks = await run({ languageModel: failing() });
    const errors = dataParts<{
      code: string;
      message: string;
      details: string | null;
      retryable: boolean;
    }>(chunks, "data-zoc-error");
    expect(errors).toHaveLength(1);
    // A bare `throw` is 9.8's last arm: nothing is known about the thrown string, so
    // the code is `internal`, no retry is invited, and the text is withheld rather
    // than forwarded as `details` (R9.8).
    expect(errors[0]?.code).toBe(ErrorCode.INTERNAL);
    expect(errors[0]?.retryable).toBe(false);
    expect(errors[0]?.details).toBeNull();
    expect(errors[0]?.message).not.toContain("upstream exploded");

    const states = dataParts<{ state: string; code?: string | null }>(chunks, "data-zoc-run");
    expect(states.at(-1)?.state).toBe("failed");
    expect(states.at(-1)?.code).toBe(ErrorCode.INTERNAL);
    expect(chunks.at(-2)?.type).toBe("finish");
  });

  it("puts the error part before the terminal lifecycle, not after it", async () => {
    // SeqFraming closes on the terminal lifecycle, so an error written after it
    // is an error the client never sees.
    const types = typesOf(await run({ languageModel: failing() }));
    expect(types.indexOf("data-zoc-error")).toBeLessThan(types.lastIndexOf("data-zoc-run"));
  });

  it("drops the SDK's own error chunk, so one failure is one row", async () => {
    // `toUIMessageStream` reports the failure as a native `error` chunk carrying a
    // bare `errorText`. Forwarding it alongside the `zoc-error` part would render
    // the same failure twice, the second time without a code or a retryable flag.
    const types = typesOf(await run({ languageModel: failing() }));
    expect(types).not.toContain("error");
  });

  it("uses the injected classifier when one is supplied (9.8's seam)", async () => {
    const chunks = await run({
      languageModel: failing(),
      classifyError: () => ({
        code: ErrorCode.PROVIDER_CONTENT_FILTERED,
        message: "Request refused.",
        details: null,
        retryable: false,
      }),
    });
    expect(dataParts<{ code: string }>(chunks, "data-zoc-error")[0]?.code).toBe(
      ErrorCode.PROVIDER_CONTENT_FILTERED,
    );
  });
});

describe("cancellation", () => {
  it("reaches cancelled rather than failed, with no error part", async () => {
    const controller = new AbortController();
    controller.abort();
    const chunks = await run({
      languageModel: modelOf([completingStep("hi")]),
      signal: controller.signal,
    });
    const states = dataParts<{ state: string }>(chunks, "data-zoc-run");
    expect(states.at(-1)?.state).toBe("cancelled");
    expect(dataParts(chunks, "data-zoc-error")).toEqual([]);
  });
});

// ── The fold, inside the Run (R34.1) ──────────────────────────────────

describe("automatic compaction", () => {
  /** Six turns of filler, priced so a 4 000-token window is well over 85%. */
  function crowdedRequest(): AssembledRequest {
    const messages = Array.from({ length: 12 }, (_value, index) => ({
      id: `m${index}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: "x".repeat(1_200),
    }));
    return request({ messages, contextLimit: 4_000, sessionMessageCount: 12 });
  }

  const summarising = (): Omit<CompactionContext, "writer"> => ({
    summarise: async () => ({
      text: "earlier turns, summarised",
      usage: { inputTokens: 40, outputTokens: 9 },
    }),
    newCompactionId: () => "cmp_1",
  });

  it("folds before dispatch and records the fold on this Run's stream", async () => {
    const model = modelOf([completingStep("ok")]);
    const chunks = await run({
      languageModel: model,
      request: crowdedRequest(),
      compaction: summarising(),
    });

    const folds = dataParts<{ compactionId: string; foldedTurnCount: number; summary: string }>(
      chunks,
      "data-zoc-compaction",
    );
    expect(folds).toHaveLength(1);
    expect(folds[0]?.compactionId).toBe("cmp_1");
    expect(folds[0]?.summary).toBe("earlier turns, summarised");

    // Before the dispatch it protects: the model saw fewer messages than were
    // assembled, and the summary reached it through the instructions.
    const call = model.doStreamCalls[0];
    expect(call?.prompt.length).toBeLessThan(12);
    const system = call?.prompt.find((message) => message.role === "system");
    expect(JSON.stringify(system)).toContain(PIN_HEADING);
    expect(JSON.stringify(system)).toContain("earlier turns, summarised");
  });

  it("counts the summariser's own tokens toward the Run's total (R27.2)", async () => {
    const chunks = await run({ request: crowdedRequest(), compaction: summarising() });
    const parts = dataParts<{ inputTokens: number; outputTokens: number }>(
      chunks,
      "data-zoc-usage",
    );
    // 40 + 11 in, 9 + 7 out.
    expect(parts.at(-1)?.inputTokens).toBe(51);
    expect(parts.at(-1)?.outputTokens).toBe(16);
  });

  it("reports a summariser failure and runs on the full history anyway (R34.9)", async () => {
    const chunks = await run({
      request: crowdedRequest(),
      compaction: {
        summarise: async () => {
          throw new Error("summariser offline");
        },
      },
    });
    const errors = dataParts<{ code: string; retryable: boolean }>(chunks, "data-zoc-error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.retryable).toBe(true);
    expect(dataParts(chunks, "data-zoc-compaction")).toEqual([]);
    // Non-fatal: the Run still completes.
    expect(dataParts<{ state: string }>(chunks, "data-zoc-run").at(-1)?.state).toBe("completed");
  });

  it("does not fold a request under the threshold", async () => {
    const chunks = await run({ compaction: summarising() });
    expect(dataParts(chunks, "data-zoc-compaction")).toEqual([]);
    expect(dataParts(chunks, "data-zoc-error")).toEqual([]);
  });

  it("does nothing at all when the Run carries no compaction context", async () => {
    const chunks = await run({ request: crowdedRequest() });
    expect(dataParts(chunks, "data-zoc-compaction")).toEqual([]);
    expect(dataParts<{ state: string }>(chunks, "data-zoc-run").at(-1)?.state).toBe("completed");
  });
});
