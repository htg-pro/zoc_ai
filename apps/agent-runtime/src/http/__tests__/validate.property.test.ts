/**
 * Property 5: Schema-invalid payloads yield a complete error envelope.
 * Validates R7.5 (and the R9.8 invariants the envelope carries).
 *
 * "Complete" is the load-bearing word: all four fields present, `retryable`
 * decided rather than absent, `details` bounded, and — the assertion with teeth
 * — `message` free of anything that could have come out of the rejected body. A
 * body that failed validation is exactly the body most likely to carry a
 * credential, so echoing it back is the realistic leak.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { z } from "zod";

import { DETAILS_LIMIT, HttpError, boundDetails, envelope } from "../errors.ts";
import { projectIssues, readJsonBody, validate } from "../validate.ts";

const RUNS = { numRuns: 200 } as const;

const runRequestSchema = z.object({
  sessionId: z.string().min(1),
  message: z.object({ role: z.literal("user"), text: z.string() }),
  conversationMode: z.enum(["ask", "plan", "agent"]),
  permissionMode: z.enum(["ask", "auto", "deny"]),
  model: z.object({ provider: z.string(), modelId: z.string() }),
  mentions: z.array(z.string()).default([]),
});

/** A marker no schema accepts, so it can only appear if the body was echoed. */
const SECRET = "sk-live-CANARY-0123456789abcdefghijklmnop";

function expectCompleteEnvelope(error: unknown): HttpError {
  expect(error).toBeInstanceOf(HttpError);
  const httpError = error as HttpError;
  const { code, message, details, retryable } = httpError.envelope;

  expect(typeof code).toBe("string");
  expect(code.length).toBeGreaterThan(0);
  expect(typeof message).toBe("string");
  expect(message.length).toBeGreaterThan(0);
  expect(typeof retryable).toBe("boolean");
  expect(details === null || typeof details === "string").toBe(true);
  if (typeof details === "string") {
    expect(details.length).toBeLessThanOrEqual(DETAILS_LIMIT);
  }
  return httpError;
}

describe("Property 5: schema-invalid payloads yield a complete error envelope (R7.5)", () => {
  it("answers 422 with all four fields for any invalid body", () => {
    const invalidBody = fc.oneof(
      fc.constant(undefined),
      fc.constant(null),
      fc.constant({}),
      fc.string(),
      fc.integer(),
      fc.array(fc.anything()),
      fc.record({ sessionId: fc.integer() }),
      fc.record({ sessionId: fc.string(), conversationMode: fc.constant("shout") }),
      fc.object(),
    );

    fc.assert(
      fc.property(invalidBody, (body) => {
        let thrown: unknown;
        try {
          validate(runRequestSchema, body, "run request");
        } catch (cause) {
          thrown = cause;
        }
        const error = expectCompleteEnvelope(thrown);
        expect(error.status).toBe(422);
        expect(error.envelope.code).toBe("invalid_request");
        // A body the schema rejects will be rejected again unchanged.
        expect(error.envelope.retryable).toBe(false);
      }),
      RUNS,
    );
  });

  it("never echoes a rejected value into message or details", () => {
    const carrier = fc.oneof(
      fc.record({ sessionId: fc.constant(SECRET) }),
      fc.record({ apiKey: fc.constant(SECRET), sessionId: fc.integer() }),
      fc.record({
        sessionId: fc.constant("s1"),
        message: fc.record({ role: fc.constant("user"), text: fc.constant(SECRET) }),
      }),
      fc.constant({ nested: { deeply: { key: SECRET } } }),
    );

    fc.assert(
      fc.property(carrier, (body) => {
        try {
          validate(runRequestSchema, body, "run request");
          expect.unreachable("the schema should have rejected this body");
        } catch (cause) {
          const error = expectCompleteEnvelope(cause);
          expect(error.envelope.message).not.toContain(SECRET);
          expect(error.envelope.details ?? "").not.toContain(SECRET);
          expect(error.envelope.message).not.toMatch(/sk-/);
        }
      }),
      RUNS,
    );
  });

  it("names field paths, not field values", () => {
    try {
      validate(runRequestSchema, { sessionId: 7, conversationMode: "shout" }, "run request");
      expect.unreachable();
    } catch (cause) {
      const error = expectCompleteEnvelope(cause);
      expect(error.envelope.details).toContain("sessionId");
      expect(error.envelope.details).not.toContain("7");
    }
  });

  it("bounds details no matter how many issues there are", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 400 }), (fieldCount) => {
        const shape: Record<string, z.ZodTypeAny> = {};
        for (let i = 0; i < fieldCount; i += 1) shape[`field_${i}`] = z.string();
        const wide = z.object(shape);
        try {
          validate(wide, {}, "wide request");
          expect.unreachable();
        } catch (cause) {
          const error = expectCompleteEnvelope(cause);
          expect((error.envelope.details ?? "").length).toBeLessThanOrEqual(DETAILS_LIMIT);
        }
      }),
      { numRuns: 40 },
    );
  });

  it("accepts every valid body without throwing", () => {
    const validBody = fc.record({
      sessionId: fc.string({ minLength: 1 }),
      message: fc.record({ role: fc.constant("user" as const), text: fc.string() }),
      conversationMode: fc.constantFrom("ask" as const, "plan" as const, "agent" as const),
      permissionMode: fc.constantFrom("ask" as const, "auto" as const, "deny" as const),
      model: fc.record({ provider: fc.string(), modelId: fc.string() }),
      mentions: fc.array(fc.string()),
    });

    fc.assert(
      fc.property(validBody, (body) => {
        expect(() => validate(runRequestSchema, body, "run request")).not.toThrow();
      }),
      RUNS,
    );
  });
});

describe("envelope invariants (R9.8)", () => {
  it("clamps details to the limit and normalises empties to null", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 4000 }), (text) => {
        const bounded = boundDetails(text);
        if (text.trim().length === 0) {
          expect(bounded).toBeNull();
        } else {
          expect((bounded as string).length).toBeLessThanOrEqual(DETAILS_LIMIT);
        }
      }),
      RUNS,
    );
  });

  it("marks truncation rather than silently cutting", () => {
    const long = "x".repeat(DETAILS_LIMIT * 3);
    expect(boundDetails(long)?.endsWith("…")).toBe(true);
  });

  it("produces a frozen envelope so a handler cannot mutate one in flight", () => {
    const env = envelope("some_code", "A sentence.");
    expect(Object.isFrozen(env)).toBe(true);
  });

  it("defaults retryable to false rather than leaving it undefined", () => {
    expect(envelope("c", "m").retryable).toBe(false);
  });

  it("renders (root) for a top-level issue rather than an empty path", () => {
    expect(projectIssues([{ path: [], code: "invalid_type", expected: "object" }])).toEqual([
      { path: "(root)", code: "invalid_type", expected: "expected object" },
    ]);
  });
});

describe("body reader", () => {
  async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
    for (const part of parts) yield new TextEncoder().encode(part);
  }

  it("parses a JSON body split across chunks", async () => {
    await expect(readJsonBody(chunks('{"a"', ":1}"))).resolves.toEqual({ a: 1 });
  });

  it("returns undefined for an empty body rather than throwing", async () => {
    await expect(readJsonBody(chunks())).resolves.toBeUndefined();
  });

  it("rejects malformed JSON with a complete envelope", async () => {
    await expect(readJsonBody(chunks("{not json"))).rejects.toSatisfy((cause: unknown) => {
      const error = expectCompleteEnvelope(cause);
      return error.status === 422;
    });
  });

  it("rejects an oversized body while reading, not after", async () => {
    const oversize = readJsonBody(chunks("y".repeat(64), "y".repeat(64)), 32);
    await expect(oversize).rejects.toSatisfy((cause: unknown) => {
      const error = expectCompleteEnvelope(cause);
      return error.status === 413;
    });
  });
});
