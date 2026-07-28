/**
 * Unit tests for the request validation gate — zoc-agent-chat-rebuild R7.5.
 *
 * Property 5 (2.6) sweeps arbitrary invalid bodies for a complete envelope.
 * These are the specific cases that sweep is unlikely to construct on its own,
 * and every one of them is a way the mapping could echo the request back:
 *
 *   - the invalid field's *name* is the credential (a record key, or a key on a
 *     strict object), so redaction has to happen on the path, not the value;
 *   - the schema author's own error message interpolates the input;
 *   - the caller passes a subject noun carrying a path or a run id.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { DETAILS_LIMIT, HttpError } from "../errors.ts";
import { REDACTED, readJsonBody, validate } from "../validate.ts";

/** Two shapes of the same secret: one punctuated, one identifier-shaped. */
const DASHED_KEY = "sk-live-CANARY-0123456789abcdef";
const UNDERSCORED_KEY = "sk_live_CANARY_0123456789abcdef";

const runRequest = z.object({
  sessionId: z.string().min(1),
  conversationMode: z.enum(["ask", "plan", "agent"]),
  mentions: z.array(z.string()).default([]),
});

function rejection(run: () => unknown): HttpError {
  try {
    run();
  } catch (cause) {
    expect(cause).toBeInstanceOf(HttpError);
    return cause as HttpError;
  }
  throw new Error("expected the schema to reject this body");
}

describe("validate: the 422 mapping (R7.5)", () => {
  it("answers 422 with all four envelope fields", () => {
    const error = rejection(() => validate(runRequest, {}, "run request"));

    expect(error.status).toBe(422);
    expect(error.envelope).toEqual({
      code: "invalid_request",
      message: "The run request was not in the expected shape.",
      details: expect.stringContaining("sessionId"),
      retryable: false,
    });
  });

  it("is not retryable, because the same body fails the same way", () => {
    const error = rejection(() => validate(runRequest, { sessionId: 1 }, "run request"));
    expect(error.envelope.retryable).toBe(false);
  });

  it("names the field and the expected type, not the value", () => {
    const error = rejection(() =>
      validate(runRequest, { sessionId: 12345, conversationMode: "shout" }, "run request"),
    );

    expect(error.envelope.details).toContain("sessionId: expected string");
    expect(error.envelope.details).not.toContain("12345");
    // The declared options are the schema's own, so naming them is the point.
    expect(error.envelope.details).toContain('"ask"');
    expect(error.envelope.details).not.toContain("shout");
  });

  it("reports a declared bound from the schema", () => {
    const bounded = z.object({ title: z.string().min(3).max(8) });

    expect(rejection(() => validate(bounded, { title: "a" }, "title")).envelope.details).toContain(
      "expected at least 3 characters",
    );
    expect(
      rejection(() => validate(bounded, { title: "aaaaaaaaaa" }, "title")).envelope.details,
    ).toContain("expected at most 8 characters");
  });

  it("accepts a valid body and applies the schema's defaults", () => {
    expect(
      validate(runRequest, { sessionId: "s1", conversationMode: "agent" }, "run request"),
    ).toEqual({ sessionId: "s1", conversationMode: "agent", mentions: [] });
  });
});

describe("validate: nothing from the request is echoed", () => {
  it("redacts a record key that is itself a credential", () => {
    const bag = z.record(z.string(), z.number());

    for (const key of [DASHED_KEY, UNDERSCORED_KEY]) {
      const error = rejection(() => validate(bag, { [key]: "not a number" }, "settings"));
      const details = error.envelope.details ?? "";

      expect(details).not.toContain(key);
      expect(details).not.toContain("CANARY");
      expect(details).toContain(REDACTED);
      // The failure is still legible: the shape is reported even though the
      // field name could not be.
      expect(details).toContain("expected number");
    }
  });

  it("keeps a record key that is an ordinary field name", () => {
    const bag = z.record(z.string(), z.number());
    const error = rejection(() => validate(bag, { retryBudget: "eight" }, "settings"));

    expect(error.envelope.details).toContain("retryBudget: expected number");
  });

  it("counts unrecognized keys instead of naming them", () => {
    const strict = z.strictObject({ sessionId: z.string() });
    const error = rejection(() =>
      validate(strict, { sessionId: "s1", [UNDERSCORED_KEY]: "x" }, "run request"),
    );
    const details = error.envelope.details ?? "";

    expect(details).toContain("1 unrecognized key");
    expect(details).not.toContain("CANARY");
    expect(details).not.toContain(UNDERSCORED_KEY);
  });

  it("ignores a schema author's message when it interpolates the input", () => {
    const nosy = z.object({
      token: z.string().superRefine((value, ctx) => {
        ctx.addIssue({ code: "custom", message: `the value ${value} was rejected` });
      }),
    });

    const error = rejection(() => validate(nosy, { token: DASHED_KEY }, "run request"));

    expect(error.envelope.details).toBe("token: failed a declared constraint");
    expect(error.envelope.details).not.toContain("CANARY");
  });

  it("redacts a declared literal that is itself a credential", () => {
    const compare = z.object({ token: z.literal(DASHED_KEY) });
    const error = rejection(() => validate(compare, { token: "wrong" }, "run request"));

    expect(error.envelope.details).toBe(`token: expected one of ${REDACTED}`);
  });

  it("drops a subject noun carrying a path or a run id rather than trimming it", () => {
    const error = rejection(() =>
      validate(runRequest, {}, "run request run_01H8XK for /home/ana/secrets"),
    );

    // Not "the run request for home ana secrets": a salvaged subject keeps the
    // words, and the words of a path are most of the path.
    expect(error.envelope.message).toBe("The request was not in the expected shape.");
  });

  it("keeps an ordinary subject noun", () => {
    const error = rejection(() => validate(runRequest, {}, "approval decision"));
    expect(error.envelope.message).toBe("The approval decision was not in the expected shape.");
  });

  it("bounds details however wide the schema is", () => {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (let i = 0; i < 200; i += 1) shape[`field_${i}`] = z.string();

    const error = rejection(() => validate(z.object(shape), {}, "wide request"));
    const details = error.envelope.details ?? "";

    expect(details.length).toBeLessThanOrEqual(DETAILS_LIMIT);
    expect(details).toContain("more");
  });
});

describe("readJsonBody", () => {
  async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
    for (const part of parts) yield new TextEncoder().encode(part);
  }

  async function rejectionOf(read: Promise<unknown>): Promise<HttpError> {
    try {
      await read;
    } catch (cause) {
      expect(cause).toBeInstanceOf(HttpError);
      return cause as HttpError;
    }
    throw new Error("expected the reader to reject this body");
  }

  it("rejects malformed JSON as 422 with the schema code", async () => {
    const error = await rejectionOf(readJsonBody(chunks('{"sessionId": ')));

    expect(error.status).toBe(422);
    expect(error.envelope.code).toBe("invalid_request");
    expect(error.envelope.retryable).toBe(false);
  });

  it("rejects an oversized body as 413 before buffering it all", async () => {
    const error = await rejectionOf(readJsonBody(chunks("y".repeat(64), "y".repeat(64)), 32));

    expect(error.status).toBe(413);
    expect(error.envelope.code).toBe("invalid_request");
  });
});
