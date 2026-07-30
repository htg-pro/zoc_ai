/**
 * The benchmark proxy over real HTTP — zoc-agent-chat-rebuild R13.11, R13.12, 9.9.
 *
 * The assertion that matters is the null one. R13.12 says a model with no recorded
 * history is listed with **no figure**, and the only way the picker can honour that is
 * if the route distinguishes "never measured" from "measured as slow" — so the tests
 * below pin `null` against `0` in the three ways the distinction can be lost: an empty
 * history, a history whose rates were never recorded, and an average that would round
 * a small number down.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createAdmission } from "../admission.ts";
import { createRequestListener } from "../../main.ts";
import { buildRoutes } from "../routes.ts";
import { registerBenchmarkRoutes } from "../benchmark-routes.ts";
import type { BenchmarkHistory, WorkspaceOutcome } from "../../tools/workspace-client.ts";

const TOKEN = "benchmark-token-0123456789ab";

let server: Server;
let port = 0;
let outcome: WorkspaceOutcome<BenchmarkHistory>;
let asked: string[];

function run(id: string, averageTokensPerSecond: number | null): BenchmarkHistory["runs"][number] {
  return { id, createdAt: "2026-07-30T00:00:00Z", averageTokensPerSecond };
}

beforeEach(async () => {
  asked = [];
  outcome = {
    ok: true,
    value: { modelId: "qwen2.5-coder", runs: [run("b2", 20), run("b1", 40)] },
  };

  const route = buildRoutes(
    { token: TOKEN, workspaceServicesUrl: "http://127.0.0.1:1", workspaceRoot: "/tmp" },
    (router) =>
      registerBenchmarkRoutes(router, {
        benchmarkHistory: async (modelId) => {
          asked.push(modelId);
          return outcome;
        },
      }),
  );
  server = createServer(createRequestListener(createAdmission({ token: TOKEN }), route));
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    }),
  );
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function get(
  modelId: string,
  init: { token?: string | null } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const token = init.token === undefined ? TOKEN : init.token;
  const response = await fetch(
    `http://127.0.0.1:${port}/v1/models/${encodeURIComponent(modelId)}/benchmark`,
    { headers: token === null ? {} : { authorization: `Bearer ${token}` } },
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

describe("GET /v1/models/:id/benchmark", () => {
  it("answers the mean and the run count, not the raw history", () => {
    return get("qwen2.5-coder").then(({ status, body }) => {
      expect(status).toBe(200);
      expect(body).toEqual({
        modelId: "qwen2.5-coder",
        runCount: 2,
        meanTokensPerSecond: 30,
      });
    });
  });

  it("passes the model id through, encoded in the path and decoded on the way out", async () => {
    await get("qwen2.5-coder:7b");
    expect(asked).toEqual(["qwen2.5-coder:7b"]);
  });

  it("answers null for a model with no recorded history (R13.12)", async () => {
    outcome = { ok: true, value: { modelId: "never-run", runs: [] } };
    const { status, body } = await get("never-run");

    expect(status).toBe(200);
    // Not `0`: zero tokens per second is a legible claim about a model and it would be
    // a false one, so the picker gets nothing to render rather than a wrong figure.
    expect(body).toEqual({ modelId: "never-run", runCount: 0, meanTokensPerSecond: null });
  });

  it("answers null when the runs exist but none recorded a rate", async () => {
    outcome = { ok: true, value: { modelId: "m1", runs: [run("b1", null), run("b2", null)] } };
    const { body } = await get("m1");

    // The count is honest — two runs happened — and the figure is still absent, because
    // averaging nothing is not zero.
    expect(body).toEqual({ modelId: "m1", runCount: 2, meanTokensPerSecond: null });
  });

  it("averages only the runs that recorded a rate", async () => {
    outcome = {
      ok: true,
      value: { modelId: "m1", runs: [run("b1", 30), run("b2", null), run("b3", 10)] },
    };
    const { body } = await get("m1");
    expect(body).toEqual({ modelId: "m1", runCount: 3, meanTokensPerSecond: 20 });
  });

  it("reports a Workspace_Services outage as retryable", async () => {
    outcome = {
      ok: false,
      code: "workspace_unavailable",
      message: "not reachable",
      retryable: true,
    };
    const { status, body } = await get("m1");

    expect(status).toBe(502);
    expect(body.code).toBe("workspace_unavailable");
    expect(body.retryable).toBe(true);
    // The upstream message is not forwarded; the sentence is the route's own (R9.8).
    expect(body.message).not.toContain("not reachable");
  });

  it("does not offer a retry for a refusal that would be refused again", async () => {
    outcome = { ok: false, code: "workspace_failed", message: "refused", retryable: false };
    const { status, body } = await get("m1");

    expect(status).toBe(502);
    expect(body.code).toBe("workspace_failed");
    expect(body.retryable).toBe(false);
  });

  it("refuses without the bearer token (R3.6)", async () => {
    const { status } = await get("m1", { token: null });
    expect(status).toBe(401);
    expect(asked).toEqual([]);
  });

  it("answers 405 for a write, since the store is not the runtime's", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/models/m1/benchmark`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(405);
    await response.text();
  });
});
