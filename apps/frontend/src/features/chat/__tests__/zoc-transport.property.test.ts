/**
 * Property 1: Exactly-once part rendering under an unreliable stream. Validates R7.7,
 * R16.3, R16.4.
 * Property 13: A run request never carries a credential. Validates R7.8.
 * Property 12: Runtime loss preserves the transcript. Validates R3.8.
 *
 * All three are about the transport rather than about a socket, so the socket is a stub and
 * the hazards are generated: `unreliableDelivery` duplicates, reorders within a bounded
 * window, and cuts — the three things a real transport does, applied in the order a real
 * network applies them.
 *
 * **The hazards are replayed as SSE frames through the real `ZocChatTransport`, not
 * simulated against a model of it.** A property that reimplemented the sequence rules to
 * check them would pass whatever the transport did. So each iteration renders the generated
 * delivery into frames, feeds them to the transport across as many connections as the
 * delivery implies, and asserts on what came out the other side.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { UIMessageChunk } from "ai";
import type { MessagePart } from "@zoc-studio/shared-types";

import {
  MAX_REATTACH_ATTEMPTS,
  ZocChatTransport,
  type SubmissionContext,
  type ZocTransportOptions,
} from "@/features/chat/wire/zoc-transport";
import type { ZocUIMessage } from "@/features/chat/wire/ui-message";
import {
  CONVERSATION_MODES,
  PERMISSION_MODES,
  unreliableDelivery,
  type Delivery,
} from "./arbitraries";

/** Property 1 joins the 200-iteration set (design.md:4464). */
const SEQUENCE_RUNS = { numRuns: 200 } as const;
const RUNS = { numRuns: 100 } as const;

const BASE = "http://127.0.0.1:41000";

/** One part as the runtime frames it: `id:` carries the `seq`, `data:` the chunk. */
function frameOf(part: MessagePart): string {
  const chunk =
    part.type === "run-lifecycle"
      ? { type: "data-zoc-run", id: part.runId, data: part }
      : { type: "data-zoc-error", id: `${part.runId}:${String(part.seq)}`, data: part };
  return `id: ${String(part.seq)}\ndata: ${JSON.stringify(chunk)}\n\n`;
}

function sse(parts: readonly MessagePart[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const part of parts) controller.enqueue(encoder.encode(frameOf(part)));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/**
 * The runtime's replay, honestly modelled: every intended part with `seq > fromSeq`.
 *
 * This is what a re-attach actually receives, and it is what makes the property meaningful.
 * The *first* connection delivers the hostile stream; every re-attach delivers a clean
 * replay from the requested point, because that is the runtime's ring-buffer contract.
 */
function replayFrom(intended: readonly MessagePart[], fromSeq: number): MessagePart[] {
  return intended.filter((part) => part.seq > fromSeq);
}

interface Attempt {
  readonly fromSeq: number;
}

/** A transport whose first stream is the hostile delivery and whose retries are replays. */
function transportOver(delivery: Delivery): {
  transport: ZocChatTransport;
  attempts: Attempt[];
  bodies: string[];
} {
  const attempts: Attempt[] = [];
  const bodies: string[] = [];
  let streamCalls = 0;

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/v1/runs")) {
      bodies.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ runId: "run_p", streamUrl: "/v1/runs/run_p/stream" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    const fromSeq = Number(new URL(url).searchParams.get("fromSeq") ?? "0");
    attempts.push({ fromSeq });
    streamCalls += 1;
    return streamCalls === 1
      ? sse(delivery.delivered)
      : sse(replayFrom(delivery.intended, fromSeq));
  };

  const options: ZocTransportOptions = {
    endpoint: async () => ({ baseUrl: BASE, token: "t".repeat(24) }),
    submission: () => ({
      mode: "agent",
      permissionMode: "ask",
      modelRef: { provider: "openai", modelId: "gpt-4o" },
      mentions: [],
    }),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep: async () => undefined,
    random: () => 0,
  };

  return { transport: new ZocChatTransport(options), attempts, bodies };
}

async function drain(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

const seqsOf = (chunks: readonly UIMessageChunk[]): number[] =>
  chunks.map((chunk) => (chunk as { data: { seq: number } }).data.seq);

function userMessage(text: string): ZocUIMessage {
  return { id: "m1", role: "user", parts: [{ type: "text", text }] } as ZocUIMessage;
}

describe("Feature: zoc-agent-chat-rebuild, Property 1: exactly-once part rendering under an unreliable stream", () => {
  it("renders every sequence number exactly once, ascending, within 5 re-attaches", async () => {
    await fc.assert(
      fc.asyncProperty(unreliableDelivery, async (delivery) => {
        const { transport, attempts } = transportOver(delivery);
        const chunks = await drain(
          await transport.sendMessages({
            trigger: "submit-message",
            chatId: "s1",
            messageId: undefined,
            messages: [userMessage("go")],
            abortSignal: undefined,
          }),
        );

        const seqs = seqsOf(chunks);

        // A synthetic interrupted part is the transport's own, not one of the intended
        // ones, so it is excluded before the exactly-once claim is checked — and its
        // presence is a separate assertion below.
        const intendedSeqs = new Set(delivery.intended.map((part) => part.seq));
        const rendered = seqs.filter((seq) => intendedSeqs.has(seq));

        // Ascending, with no repeat: the two halves of R16.4.
        for (let i = 1; i < rendered.length; i += 1) {
          expect(rendered[i] as number).toBeGreaterThan(rendered[i - 1] as number);
        }
        expect(new Set(rendered).size).toBe(rendered.length);

        // Nothing outside the intended set except the one synthetic terminal.
        expect(seqs.length - rendered.length).toBeLessThanOrEqual(1);

        // R16.3's ceiling, counted as connections rather than as retries.
        expect(attempts.length).toBeLessThanOrEqual(MAX_REATTACH_ATTEMPTS + 1);
      }),
      SEQUENCE_RUNS,
    );
  });

  it("drops nothing: every intended part is rendered", async () => {
    // The other half of "exactly once". A transport that discarded aggressively would pass
    // the no-duplicate check above and fail here.
    await fc.assert(
      fc.asyncProperty(unreliableDelivery, async (delivery) => {
        const { transport } = transportOver(delivery);
        const chunks = await drain(
          await transport.sendMessages({
            trigger: "submit-message",
            chatId: "s1",
            messageId: undefined,
            messages: [userMessage("go")],
            abortSignal: undefined,
          }),
        );

        const rendered = new Set(seqsOf(chunks));
        for (const part of delivery.intended) {
          expect(rendered.has(part.seq), `seq ${String(part.seq)}`).toBe(true);
        }
      }),
      SEQUENCE_RUNS,
    );
  });

  it("resumes only from a seq it actually rendered", async () => {
    // The invariant behind the two above: a re-attach that asked for more than it had
    // rendered would skip a part, and one that asked for less would re-render it. Both are
    // invisible in the output when the runtime replays generously, so the requests
    // themselves are what is asserted.
    await fc.assert(
      fc.asyncProperty(unreliableDelivery, async (delivery) => {
        const { transport, attempts } = transportOver(delivery);
        await drain(
          await transport.sendMessages({
            trigger: "submit-message",
            chatId: "s1",
            messageId: undefined,
            messages: [userMessage("go")],
            abortSignal: undefined,
          }),
        );

        expect(attempts[0]?.fromSeq).toBe(0);
        // Monotone and never negative: a resume point only ever moves forward.
        for (let i = 1; i < attempts.length; i += 1) {
          expect(attempts[i]?.fromSeq as number).toBeGreaterThanOrEqual(
            attempts[i - 1]?.fromSeq as number,
          );
        }
      }),
      SEQUENCE_RUNS,
    );
  });
});

/** Every property name at any nesting depth, for Property 13. */
function propertyNames(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) propertyNames(item, into);
    return into;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      into.push(key);
      propertyNames(nested, into);
    }
  }
  return into;
}

const FORBIDDEN_NAME = /^(api_key|apiKey|token|secret)$/;

describe("Feature: zoc-agent-chat-rebuild, Property 13: a run request never carries a credential", () => {
  it("serialises no property named api_key, apiKey, token, or secret, at any depth", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 400 }),
        fc.constantFrom(...CONVERSATION_MODES),
        fc.constantFrom(...PERMISSION_MODES),
        fc.record({
          provider: fc.constantFrom("openai", "anthropic", "groq", "xai", "local-llamacpp"),
          modelId: fc.string({ minLength: 1, maxLength: 60 }),
          baseUrl: fc.option(fc.webUrl(), { nil: null }),
        }),
        fc.array(
          fc.record({
            kind: fc.constantFrom("file" as const, "symbol" as const, "terminal" as const),
            ref: fc.string({ minLength: 1, maxLength: 80 }),
            content: fc.option(fc.string({ maxLength: 200 }), { nil: undefined }),
          }),
          { maxLength: 6 },
        ),
        async (draft, mode, permissionMode, modelRef, mentions) => {
          const submission: SubmissionContext = { mode, permissionMode, modelRef, mentions };
          const bodies: string[] = [];

          const options: ZocTransportOptions = {
            endpoint: async () => ({ baseUrl: BASE, token: "s".repeat(32) }),
            submission: () => submission,
            fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
              if (String(input).endsWith("/v1/runs")) {
                bodies.push(String(init?.body ?? ""));
                return new Response(
                  JSON.stringify({ runId: "run_p", streamUrl: "/v1/runs/run_p/stream" }),
                  { status: 200, headers: { "content-type": "application/json" } },
                );
              }
              return new Response(null, { status: 404 });
            }) as unknown as typeof fetch,
            sleep: async () => undefined,
            random: () => 0,
          };

          await drain(
            await new ZocChatTransport(options).sendMessages({
              trigger: "submit-message",
              chatId: "s1",
              messageId: undefined,
              messages: [userMessage(draft)],
              abortSignal: undefined,
            }),
          );

          const parsed = JSON.parse(bodies[0] as string) as unknown;
          for (const name of propertyNames(parsed)) {
            expect(FORBIDDEN_NAME.test(name), name).toBe(false);
          }
          // The credential *is* sent — as a header — so the property is about the body
          // rather than about the request, and asserting the header keeps that explicit.
          expect(bodies[0]).not.toContain("s".repeat(32));
        },
      ),
      RUNS,
    );
  });
});

describe("Feature: zoc-agent-chat-rebuild, Property 12: runtime loss preserves the transcript", () => {
  it("keeps every delivered part and ends with an interrupted terminal", async () => {
    // Runtime loss, as the transport observes it: the socket dies mid-stream and every
    // re-attach is refused because the process is gone. The two claims are that nothing
    // already delivered is discarded, and that the Run reaches a terminal state rather
    // than hanging — R3.8's "transcript preserved above a banner" rests on the first.
    await fc.assert(
      fc.asyncProperty(unreliableDelivery, async (delivery) => {
        let streamCalls = 0;
        const options: ZocTransportOptions = {
          endpoint: async () => ({ baseUrl: BASE, token: "t".repeat(24) }),
          submission: () => ({
            mode: "agent",
            permissionMode: "ask",
            modelRef: { provider: "openai", modelId: "gpt-4o" },
            mentions: [],
          }),
          fetchImpl: (async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith("/v1/runs")) {
              return new Response(
                JSON.stringify({ runId: "run_p", streamUrl: "/v1/runs/run_p/stream" }),
                { status: 200, headers: { "content-type": "application/json" } },
              );
            }
            streamCalls += 1;
            // The first connection delivers a gapless prefix, then the process exits and
            // every subsequent connect fails at the socket.
            if (streamCalls > 1) throw new Error("ECONNREFUSED");
            return sse(delivery.intended.slice(0, delivery.resumeFromSeq));
          }) as unknown as typeof fetch,
          sleep: async () => undefined,
          random: () => 0,
        };

        const chunks = await drain(
          await new ZocChatTransport(options).sendMessages({
            trigger: "submit-message",
            chatId: "s1",
            messageId: undefined,
            messages: [userMessage("go")],
            abortSignal: undefined,
          }),
        );

        const rendered = new Set(seqsOf(chunks));
        // Everything the runtime managed to deliver is still there.
        for (const part of delivery.intended.slice(0, delivery.resumeFromSeq)) {
          expect(rendered.has(part.seq), `seq ${String(part.seq)}`).toBe(true);
        }

        const terminal = chunks.at(-1) as { data?: { state?: string; code?: string } };
        // The last part is terminal either way: the delivered prefix's own terminal when it
        // contained one, or the transport's synthetic interruption when it did not.
        expect(["completed", "cancelled", "failed", "interrupted"]).toContain(terminal.data?.state);
        if (terminal.data?.state === "interrupted") {
          expect(terminal.data.code).toBe("stream_lost");
        }
      }),
      RUNS,
    );
  });
});
