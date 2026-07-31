/**
 * Workspace-client rules discovery — zoc-agent-chat-rebuild R30.1, R6.3, R6.6.
 *
 * Task 9.4's transport half. Three things are pinned: the request is a GET with
 * no body (the Python route takes no arguments and a POST would mean inventing
 * one), a transport failure is reported rather than thrown (R6.6, so a
 * restarting Workspace_Services degrades a Run to "no rules" instead of ending
 * it), and the client satisfies `RulesDiscoveryClient` structurally — which is
 * what lets `discoverRulesVia` adapt it without `agent/` importing `tools/`.
 */

import { describe, expect, it, vi } from "vitest";

import { WorkspaceClient } from "../workspace-client.ts";
import { discoverRulesVia, type RulesDiscoveryClient } from "../../agent/system-instructions.ts";

function clientWith(fetchImpl: typeof fetch): WorkspaceClient {
  return new WorkspaceClient({
    bridgeUrl: "http://127.0.0.1:9/bridge",
    servicesUrl: "http://127.0.0.1:9",
    token: "token-0123456789",
    fetchImpl,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("WorkspaceClient.discoverRules", () => {
  it("GETs the session rules route with no body", async () => {
    const fetchImpl = vi.fn(async () => json({ active: false, documents: [] }));
    const outcome = await clientWith(fetchImpl as unknown as typeof fetch).discoverRules(
      "sess/one",
    );

    expect(outcome.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    // The session id is a path segment, so it is encoded.
    expect(url).toBe("http://127.0.0.1:9/v1/sessions/sess%2Fone/rules");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.headers).not.toHaveProperty("content-type");
  });

  it("normalizes documents, defaulting a missing error to null", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        active: true,
        sources: [".zoc/rules/style.md"],
        rules: "prefer clarity",
        documents: [
          { path: ".zoc/rules/style.md", content: "prefer clarity", error: null },
          { path: ".zoc/rules/binary.md", content: null, error: "not UTF-8" },
          { path: "AGENTS.md", content: "run the tests" },
        ],
      }),
    );

    const outcome = await clientWith(fetchImpl as unknown as typeof fetch).discoverRules("s1");
    expect(outcome).toEqual({
      ok: true,
      value: [
        { path: ".zoc/rules/style.md", content: "prefer clarity", error: null },
        { path: ".zoc/rules/binary.md", content: null, error: "not UTF-8" },
        { path: "AGENTS.md", content: "run the tests", error: null },
      ],
    });
  });

  it("treats a response with no documents as no rules", async () => {
    const fetchImpl = vi.fn(async () => json({ active: false, sources: [], rules: "" }));
    const outcome = await clientWith(fetchImpl as unknown as typeof fetch).discoverRules("s1");
    expect(outcome).toEqual({ ok: true, value: [] });
  });

  it("reports an unreachable service as retryable rather than throwing (R6.6)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const outcome = await clientWith(fetchImpl as unknown as typeof fetch).discoverRules("s1");

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.retryable).toBe(true);
  });

  it("reports a 404 as not retryable — an unknown session stays unknown", async () => {
    const fetchImpl = vi.fn(async () => json({ detail: "unknown session: s1" }, 404));
    const outcome = await clientWith(fetchImpl as unknown as typeof fetch).discoverRules("s1");

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.retryable).toBe(false);
  });

  it("reports a missing services URL without a network call", async () => {
    const fetchImpl = vi.fn();
    const client = new WorkspaceClient({
      bridgeUrl: "http://127.0.0.1:9/bridge",
      servicesUrl: null,
      token: "token-0123456789",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const outcome = await client.discoverRules("s1");
    expect(outcome.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is accepted by the assembler's discovery port by shape alone", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ documents: [{ path: "AGENTS.md", content: "run the tests", error: null }] }),
    );
    // The structural assignment *is* the assertion: `agent/` declares the port,
    // `tools/` implements it, and neither imports the other's concrete type.
    const port: RulesDiscoveryClient = clientWith(fetchImpl as unknown as typeof fetch);

    expect(await discoverRulesVia(port)("s1")).toEqual([
      { path: "AGENTS.md", content: "run the tests", error: null },
    ]);
  });
});

/**
 * The path here is the whole point of these tests.
 *
 * 9.9 records that the design specified the benchmark proxy against
 * `BenchmarkStore.history`'s *signature* and never confirmed an HTTP route, and that
 * assuming a path was the one way the task could ship broken. The route was located
 * before the client was written — `GET /v1/model-benchmarks?modelId=<id>` in
 * `zocai_gateway/app.py`, with the query parameter aliased to `modelId` — and this is
 * where that verification stops being a note in a task file.
 */
describe("WorkspaceClient.benchmarkHistory", () => {
  it("GETs the verified Gateway route with modelId as a query parameter", async () => {
    const fetchImpl = vi.fn(async () => json({ modelId: "qwen2.5-coder", runs: [] }));
    const outcome = await clientWith(fetchImpl as unknown as typeof fetch).benchmarkHistory(
      "qwen2.5-coder:7b",
    );

    expect(outcome.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    // A model id contains `:` and `/`, so it is encoded rather than interpolated raw.
    expect(url).toBe("http://127.0.0.1:9/v1/model-benchmarks?modelId=qwen2.5-coder%3A7b");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("keeps only the three fields the picker reads, defaulting a missing rate to null", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        modelId: "m1",
        runs: [
          {
            id: "b2",
            createdAt: "2026-07-30T00:00:00Z",
            averageTokensPerSecond: 24.5,
            prompts: [],
          },
          { id: "b1", createdAt: "2026-07-29T00:00:00Z" },
        ],
      }),
    );
    const outcome = await clientWith(fetchImpl as unknown as typeof fetch).benchmarkHistory("m1");

    expect(outcome).toEqual({
      ok: true,
      value: {
        modelId: "m1",
        runs: [
          { id: "b2", createdAt: "2026-07-30T00:00:00Z", averageTokensPerSecond: 24.5 },
          { id: "b1", createdAt: "2026-07-29T00:00:00Z", averageTokensPerSecond: null },
        ],
      },
    });
  });

  it("reads an unmeasured model as an empty history, not as a failure", async () => {
    // `BenchmarkStore.history` answers 200 with no runs for a model it has never seen,
    // which is what lets R13.12's no-figure case be told apart from a service that
    // could not answer.
    const fetchImpl = vi.fn(async () => json({ modelId: "never-run", runs: [] }));
    const outcome = await clientWith(fetchImpl as unknown as typeof fetch).benchmarkHistory(
      "never-run",
    );

    expect(outcome).toEqual({ ok: true, value: { modelId: "never-run", runs: [] } });
  });

  it("reports a transport failure rather than throwing (R6.6)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const outcome = await clientWith(fetchImpl as unknown as typeof fetch).benchmarkHistory("m1");

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("workspace_unavailable");
      expect(outcome.retryable).toBe(true);
    }
  });
});
