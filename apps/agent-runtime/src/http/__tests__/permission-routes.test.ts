/**
 * Approval and audit endpoints over real HTTP — zoc-agent-chat-rebuild R11.7,
 * R11.9, R32.9.
 *
 * Feature: zoc-agent-chat-rebuild, R11.7, R11.9, R32.9.
 *
 * Exercised through the actual router and a real socket rather than by calling the
 * handlers, because two of the three things under test are HTTP facts: the status
 * code a repeated decision produces, and that one route accepts both decision
 * kinds without a second shape.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createAdmission } from "../admission.ts";
import { createRequestListener } from "../../main.ts";
import { buildRoutes } from "../routes.ts";
import { registerPermissionRoutes } from "../permission-routes.ts";
import { createApprovalRegistry } from "../../permissions/approvals.ts";

const TOKEN = "route-token-0123456789abcdefghij";

let server: Server;
let port = 0;
let registry: ReturnType<typeof createApprovalRegistry>;
const audit: Array<Record<string, unknown>> = [];

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(async () => {
  registry = createApprovalRegistry({ runId: "run_1" });
  audit.length = 0;
  for (let i = 0; i < 12; i += 1) {
    audit.push({ at: `t${i}`, runId: "run_1", name: `cmd_${i}`, effect: "allow" });
  }

  const route = buildRoutes(
    {
      token: TOKEN,
      workspaceServicesUrl: "http://127.0.0.1:1",
      workspaceRoot: "/tmp",
    },
    (router) =>
      registerPermissionRoutes(router, {
        approvalsFor: (runId) => (runId === "run_1" ? registry : null),
        auditEntries: (limit) => audit.slice(-limit),
      }),
  );

  server = createServer(createRequestListener(createAdmission({ token: TOKEN }), route));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  registry.releaseRun("run_1");
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

async function call(
  path: string,
  init: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const token = init.token === undefined ? TOKEN : init.token;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

function openToolRequest(timeoutMs = 2_000) {
  return registry.request({
    requestId: "req_1",
    toolName: "workspace_apply_hunks",
    kind: "write",
    reason: "out-of-plan-path",
    paths: ["src/a.ts"],
    offeredScopes: ["call", "run", "workspace"],
    timeoutMs,
  });
}

describe("POST /v1/runs/:id/approvals (R11.7)", () => {
  it("resolves a per-tool approval with 200", async () => {
    const pending = openToolRequest();
    await tick();

    const { status, body } = await call("/v1/runs/run_1/approvals", {
      method: "POST",
      body: { kind: "tool", requestId: "req_1", decision: "approve", scope: "run" },
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, decision: "approve" });
    await expect(pending).resolves.toEqual({ decision: "approve", scope: "run" });
  });

  it("carries the Plan_Approval decision on the same route", async () => {
    const plan = registry.awaitDecision({
      runId: "run_1",
      planId: "plan_1",
      timeoutMs: 2_000,
    });
    await tick();

    const { status } = await call("/v1/runs/run_1/approvals", {
      method: "POST",
      body: { kind: "plan", planId: "plan_1", decision: "approve" },
    });

    expect(status).toBe(200);
    await expect(plan).resolves.toEqual({ decision: "approve" });
  });

  it("answers 409 for an already-decided request", async () => {
    const pending = openToolRequest();
    await tick();
    await call("/v1/runs/run_1/approvals", {
      method: "POST",
      body: { kind: "tool", requestId: "req_1", decision: "approve" },
    });
    await pending;

    const { status, body } = await call("/v1/runs/run_1/approvals", {
      method: "POST",
      body: { kind: "tool", requestId: "req_1", decision: "reject" },
    });
    expect(status).toBe(409);
    expect(body.code).toBe("already_decided");
  });

  it("answers 410 past the deadline, distinct from 409", async () => {
    await expect(openToolRequest(20)).resolves.toMatchObject({ decision: "timeout" });

    const { status, body } = await call("/v1/runs/run_1/approvals", {
      method: "POST",
      body: { kind: "tool", requestId: "req_1", decision: "approve" },
    });
    expect(status).toBe(410);
    expect(body.code).toBe("decision_window_expired");
  });

  it("answers 404 for an unknown run", async () => {
    const { status, body } = await call("/v1/runs/run_missing/approvals", {
      method: "POST",
      body: { kind: "tool", requestId: "req_1", decision: "approve" },
    });
    expect(status).toBe(404);
    expect(body.code).toBe("run_not_found");
  });

  it("answers 422 with a complete envelope for a malformed decision", async () => {
    const { status, body } = await call("/v1/runs/run_1/approvals", {
      method: "POST",
      body: { kind: "tool", requestId: "req_1", decision: "maybe" },
    });
    expect(status).toBe(422);
    expect(Object.keys(body).sort()).toEqual(["code", "details", "message", "retryable"]);
  });

  it("requires the launch token", async () => {
    const { status } = await call("/v1/runs/run_1/approvals", {
      method: "POST",
      body: { kind: "tool", requestId: "req_1", decision: "approve" },
      token: null,
    });
    expect(status).toBe(401);
  });
});

describe("GET /v1/permissions/audit", () => {
  it("returns the log so Settings can read it back", async () => {
    const { status, body } = await call("/v1/permissions/audit");
    expect(status).toBe(200);
    expect((body.entries as unknown[]).length).toBe(12);
  });

  it("clamps a caller-supplied limit into range", async () => {
    for (const [limit, expected] of [
      ["5", 5],
      // 0 and a negative clamp to the floor of 1 rather than to the default: a
      // caller asking for "no entries" gets the smallest legal answer, and
      // silently substituting 200 would be a surprising amount of data.
      ["0", 1],
      ["-3", 1],
      // Above the ceiling clamps to 500, which the 12-entry fixture satisfies.
      ["9999", 12],
      // Unparseable falls back to the 200 default, capped by what exists.
      ["nonsense", 12],
    ] as const) {
      const { body } = await call(`/v1/permissions/audit?limit=${limit}`);
      expect((body.entries as unknown[]).length, `limit=${limit}`).toBe(expected);
    }
  });
});

describe("POST /v1/classify-intent", () => {
  it("uses the same ruleset the gate uses", async () => {
    for (const [text, destructive] of [
      ["rm -rf node_modules", true],
      ["git push --force origin main", true],
      ["please add a test for the parser", false],
    ] as const) {
      const { status, body } = await call("/v1/classify-intent", {
        method: "POST",
        body: { text },
      });
      expect(status).toBe(200);
      expect(body.destructive, text).toBe(destructive);
    }
  });

  it("reports the VCS-history rewrite separately from the pattern match", async () => {
    const { body } = await call("/v1/classify-intent", {
      method: "POST",
      body: { text: "git rebase -i main" },
    });
    // `git rebase` is a history rewrite but not in the destructive-intent
    // pattern list, so the two flags must be independently readable.
    expect(body.rewritesVcsHistory).toBe(true);
    expect(body.destructive).toBe(true);
  });

  it("answers 405 for the wrong verb rather than 404", async () => {
    const { status } = await call("/v1/classify-intent");
    expect(status).toBe(405);
  });
});
