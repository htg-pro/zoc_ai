/**
 * The compact-now route over real HTTP — zoc-agent-chat-rebuild R34.4, R34.5.
 *
 * Feature: zoc-agent-chat-rebuild, R34.4, R34.5.
 *
 * Task 9.5's manual half. Exercised through the actual router and a real socket
 * rather than by calling the handler, because what task 9.5 promises here is a set
 * of HTTP facts: which status a fold answers with, and that the three refusals are
 * three distinguishable codes rather than one generic failure. A surface that
 * cannot tell `compaction_run_active` from `compaction_not_needed` cannot say why
 * the button did nothing.
 *
 * The Session behind the route is a fixture, not a store: `prepare` hands back an
 * `AssembledRequest` and a `CompactionContext` directly, which is the whole point
 * of the deps port — no run store, no message store, and no provider.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CompactionPart } from "@zoc-studio/shared-types";

import { createAdmission } from "../admission.ts";
import { createRequestListener } from "../../main.ts";
import { buildRoutes } from "../routes.ts";
import {
  registerCompactionRoutes,
  type CompactionRouteDeps,
  type CompactionTarget,
} from "../compaction-routes.ts";
import {
  RETAINED_TURN_FLOOR,
  type AssembledRequest,
  type HistoryMessage,
  type Summarise,
} from "../../agent/compaction.ts";

const TOKEN = "compact-token-0123456789abcdef";

let server: Server;
let port = 0;
let parts: CompactionPart[];
let activeRun: boolean;
let target: CompactionTarget | null;

/** `turns` one-message turns, four tokens each. */
function request(turns: number): AssembledRequest {
  const messages: HistoryMessage[] = Array.from({ length: turns }, (_unused, index) => ({
    id: `m${index}`,
    role: "user" as const,
    text: "word",
  }));
  return {
    instructions: "",
    pin: null,
    mentions: [],
    toolSchemas: [],
    messages,
    contextLimit: 100_000,
    sessionMessageCount: turns,
  };
}

function contextWith(summarise: Summarise): CompactionTarget["context"] {
  let seq = 0;
  return {
    summarise,
    newCompactionId: () => "cmp_fixture",
    writer: {
      compaction(payload) {
        seq += 1;
        const part: CompactionPart = {
          ...payload,
          type: "compaction",
          seq,
          runId: "run_1",
          messageId: "msg_manual",
          ts: new Date(0).toISOString(),
          agentName: null,
        };
        parts.push(part);
        return part;
      },
    },
  };
}

const summarises = (text: string): Summarise => vi.fn(async () => ({ text }));

beforeEach(async () => {
  parts = [];
  activeRun = false;
  target = { request: request(10), context: contextWith(summarises("a short summary")) };

  const deps: CompactionRouteDeps = {
    hasActiveRun: () => activeRun,
    prepare: async (sessionId) => (sessionId === "s1" ? target : null),
  };

  const route = buildRoutes(
    { token: TOKEN, workspaceServicesUrl: "http://127.0.0.1:1", workspaceRoot: "/tmp" },
    (router) => registerCompactionRoutes(router, deps),
  );

  server = createServer(createRequestListener(createAdmission({ token: TOKEN }), route));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

async function compact(
  sessionId = "s1",
  init: { method?: string; token?: string | null } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const token = init.token === undefined ? TOKEN : init.token;
  const response = await fetch(
    `http://127.0.0.1:${port}/v1/sessions/${encodeURIComponent(sessionId)}/compact`,
    {
      method: init.method ?? "POST",
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    },
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

describe("POST /v1/sessions/:id/compact (R34.4)", () => {
  it("returns the record's figures, because there is no stream to read them from", async () => {
    const { status, body } = await compact();

    expect(status).toBe(200);
    // Exactly the four documented fields: a manual fold's caller needs the
    // outcome, and nothing here is a substitute for the transcript row. The
    // figures are the module's own arithmetic — ten tokens in context, six
    // reclaimed from the six foldable turns, four spent on the summary.
    expect(body).toEqual({
      compactionId: "cmp_fixture",
      foldedTurnCount: 10 - RETAINED_TURN_FLOOR,
      contextTokensBefore: 10,
      contextTokensAfter: 8,
    });
    expect(parts).toHaveLength(1);
  });

  it("needs no body fields — the Session is the entire input (R34.8)", async () => {
    // Sent with no content-type and no body at all: if the route ever grew a
    // required field, this is the call that would start failing.
    const { status } = await compact();
    expect(status).toBe(200);
  });

  it("answers 409 compaction_run_active while a Run streams on the Session", async () => {
    activeRun = true;
    const { status, body } = await compact();

    expect(status).toBe(409);
    expect(body.code).toBe("compaction_run_active");
    // And nothing was folded: the in-flight Run's context is what it dispatched.
    expect(parts).toEqual([]);
  });

  it("does not assemble the request when a Run is active", async () => {
    activeRun = true;
    const prepare = vi.fn(async () => target);
    const route = buildRoutes(
      { token: TOKEN, workspaceServicesUrl: "http://127.0.0.1:1", workspaceRoot: "/tmp" },
      (router) => registerCompactionRoutes(router, { hasActiveRun: () => true, prepare }),
    );
    const local = createServer(createRequestListener(createAdmission({ token: TOKEN }), route));
    await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
    const localPort = (local.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${localPort}/v1/sessions/s1/compact`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    await new Promise<void>((resolve) => {
      local.close(() => resolve());
    });

    expect(response.status).toBe(409);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("answers 409 compaction_not_needed when the floor is the whole conversation", async () => {
    target = {
      request: request(RETAINED_TURN_FLOOR),
      context: contextWith(summarises("never called")),
    };

    const { status, body } = await compact();
    expect(status).toBe(409);
    expect(body.code).toBe("compaction_not_needed");
    expect(parts).toEqual([]);
  });

  it("answers 502 compaction_failed with retryable true, and folds nothing", async () => {
    target = {
      request: request(10),
      context: contextWith(async () => {
        throw new Error("the provider refused");
      }),
    };

    const { status, body } = await compact();
    expect(status).toBe(502);
    expect(body.code).toBe("compaction_failed");
    expect(body.retryable).toBe(true);
    // The failure reason travels as bounded `details`, never as the message the
    // user reads.
    expect(body.message).not.toContain("provider refused");
    expect(body.details).toContain("provider refused");
    expect(parts).toEqual([]);
  });

  it("distinguishes its two 409s by code, not by status alone", async () => {
    // A surface that can only see the status cannot tell the user to wait for the
    // run apart from "there is nothing to compact".
    activeRun = true;
    const active = await compact();
    activeRun = false;
    target = { request: request(2), context: contextWith(summarises("unused")) };
    const notNeeded = await compact();

    expect(active.status).toBe(notNeeded.status);
    expect(active.body.code).not.toBe(notNeeded.body.code);
  });

  it("answers 404 for an unknown session", async () => {
    const { status, body } = await compact("s-missing");
    expect(status).toBe(404);
    expect(body.code).toBe("not_found");
  });

  it("answers 405 for the wrong verb rather than 404", async () => {
    const { status } = await compact("s1", { method: "GET" });
    expect(status).toBe(405);
  });

  it("requires the launch token", async () => {
    const { status } = await compact("s1", { token: null });
    expect(status).toBe(401);
  });
});
