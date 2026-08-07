/**
 * The composition root, end to end — zoc-agent-chat-rebuild §10's checkpoint.
 *
 * Feature: zoc-agent-chat-rebuild, task 10.
 *
 * §10 is "runtime tool loop end to end", and the gap the earlier tasks left is that every
 * module was tested against its own ports while nothing tested that they compose. These
 * tests drive `defaultRoute` — the exact function `main.ts` calls in production — through
 * real HTTP, with no route module registered by hand.
 *
 * Two of the assertions exist because the wiring was broken in exactly those places and
 * every unit test stayed green:
 *
 *   - **The route table reached the process.** `main.ts` called `buildRoutes(runtimeEnv)`,
 *     which registers `/health` and nothing else, so a running runtime answered 404 to
 *     every `/v1/*` path that 9.7 and 9.9 had built and tested.
 *   - **The key source survived the token scrub.** R3.4 deletes
 *     `process.env.ZOC_RUNTIME_TOKEN` before the table is built, and
 *     `secretSourceFromEnv` reads that variable — so handed the scrubbed environment it
 *     returns an empty source and every cloud Run fails `no_key_configured` with a
 *     correctly-configured vault behind it.
 *
 * The provider is never reached: no key is configured in these tests, so a cloud Run is
 * refused at `plan`. What is proven is admission, resolution, and the whole route surface.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createAdmission } from "../http/admission.ts";
import { createRequestListener } from "../main.ts";
import { buildRuntimeRoutes, defaultRoute } from "../composition.ts";
import { SlotManager } from "../agent/run-store.ts";
import type { RuntimeEnv } from "../main.ts";

const TOKEN = "composition-token-0123456789abc";

const env: RuntimeEnv = {
  token: TOKEN,
  workspaceServicesUrl: "http://127.0.0.1:1",
  workspaceRoot: "/tmp/zoc-composition",
};

let server: Server;
let port = 0;

function listen(route: ReturnType<typeof buildRuntimeRoutes>): Promise<void> {
  server = createServer(createRequestListener(createAdmission({ token: TOKEN }), route));
  return new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    }),
  );
}

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function call(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  init: { token?: string | null } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const token = init.token === undefined ? TOKEN : init.token;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

describe("defaultRoute serves the whole route table (§10)", () => {
  beforeEach(() => listen(defaultRoute(env)));

  it("answers /health without a token", async () => {
    const { status, body } = await call("GET", "/health", undefined, { token: null });
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "ok" });
  });

  it("serves every catalogue route the picker reads", async () => {
    // The regression this file exists for: `main.ts` used to build a table with `/health`
    // and nothing else, so all three of these answered 404 in a running runtime while
    // their own tests passed.
    const providers = await call("GET", "/v1/providers");
    expect(providers.status).toBe(200);
    expect((providers.body.providers as unknown[]).length).toBe(6);

    const models = await call("GET", "/v1/models");
    expect(models.status).toBe(200);
    expect((models.body.models as unknown[]).length).toBeGreaterThan(0);

    const tools = await call("GET", "/v1/tools");
    expect(tools.status).toBe(200);
    // A real registry, built with an ungated pass-through: the catalogue answers what
    // exists, and standing up a live gate for a `GET` would be half a Run.
    const names = (tools.body.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toContain("workspace_read");
    expect(names).toContain("declare_complete");
  });

  it("serves the permission and audit surface", async () => {
    const audit = await call("GET", "/v1/permissions/audit");
    expect(audit.status).toBe(200);
    expect(audit.body.entries).toEqual([]);

    // The gate's ruleset, reachable so the composer and the gate cannot drift.
    const intent = await call("POST", "/v1/classify-intent", { text: "rm -rf /" });
    expect(intent.status).toBe(200);
    expect(intent.body.destructive).toBe(true);
  });

  it("refuses every /v1 route without the launch token (R3.6)", async () => {
    for (const path of ["/v1/providers", "/v1/models", "/v1/tools"]) {
      expect((await call("GET", path, undefined, { token: null })).status, path).toBe(401);
    }
    expect((await call("POST", "/v1/runs", undefined, { token: null })).status).toBe(401);
  });

  it("does not serve a route no task has built", async () => {
    expect((await call("GET", "/v1/mcp")).status).toBe(404);
  });
});

describe("a Run reaches model resolution (§10)", () => {
  beforeEach(() => listen(defaultRoute(env)));

  it("refuses a cloud Run with no configured key, naming the provider", async () => {
    // The proof that `plan` really wires `resolveKey` to `resolveModel`: with no vault
    // endpoint the source is empty, and the refusal is the one R13.4 specifies rather than
    // a generic 500 from somewhere further in.
    const { status, body } = await call("POST", "/v1/runs", {
      sessionId: "s1",
      prompt: "explain this file",
      mode: "agent",
      permissionMode: "ask",
      modelRef: { provider: "openai", modelId: "gpt-4o" },
    });

    expect(status).toBe(400);
    expect(body.code).toBe("no_key_configured");
    expect(body.message).toContain("OpenAI");
  });

  it("refuses an unknown provider before anything is admitted", async () => {
    const { status, body } = await call("POST", "/v1/runs", {
      sessionId: "s1",
      prompt: "hello",
      mode: "agent",
      permissionMode: "ask",
      modelRef: { provider: "not-a-provider", modelId: "x" },
    });
    expect(status).toBe(404);
    expect(body.code).toBe("model_not_found");
  });

  it("refuses a local provider pointed off-box (R13.5)", async () => {
    // Configuration-time refusal, and it has to survive composition: the check lives in
    // `registry.ts` and only reaches a request because `plan` calls `resolveModel`.
    const { status, body } = await call("POST", "/v1/runs", {
      sessionId: "s1",
      prompt: "hello",
      mode: "agent",
      permissionMode: "ask",
      modelRef: {
        provider: "local-llamacpp",
        modelId: "qwen2.5-coder",
        baseUrl: "http://10.0.0.5:8080/v1",
      },
    });
    expect(status).toBe(422);
    expect(body.message).toContain("on this machine");
  });

  it("rejects a body carrying a credential (R7.8)", async () => {
    const { status, body } = await call("POST", "/v1/runs", {
      sessionId: "s1",
      prompt: "hello",
      mode: "agent",
      permissionMode: "ask",
      modelRef: { provider: "openai", modelId: "gpt-4o" },
      apiKey: "sk-must-never-CANARY-run",
    });
    expect(status).toBe(422);
    expect(JSON.stringify(body)).not.toContain("sk-must-never");
  });
});

describe("the gaps the composition root records", () => {
  beforeEach(() => listen(defaultRoute(env)));

  it("answers 404 for a title, because there is no transcript store to read", async () => {
    // Not `title_not_needed`: that code claims a Session exists and is empty. There is no
    // Session store with messages at all, so the honest answer is that the Session could
    // not be found — and the two stay distinguishable for whoever adds the endpoint.
    const { status, body } = await call("POST", "/v1/sessions/s1/title");
    expect(status).toBe(404);
    expect(body.code).toBe("not_found");
  });

  it("answers 404 for a manual fold, for the same reason", async () => {
    const { status, body } = await call("POST", "/v1/sessions/s1/compact");
    expect(status).toBe(404);
    expect(body.code).toBe("not_found");
  });

  it("reports the benchmark proxy's upstream as unreachable rather than empty", async () => {
    // `workspaceServicesUrl` points at a closed port here. A 502 with `retryable` is the
    // difference between "this model has no history" and "the store could not be read" —
    // R13.12 needs those apart, or the picker renders no figure for an outage.
    const { status, body } = await call("GET", "/v1/models/gpt-4o/benchmark");
    expect(status).toBe(502);
    expect(body.code).toBe("workspace_unavailable");
    expect(body.retryable).toBe(true);
  });

  it("fails quiet on the editor routes, with one done and no completion", async () => {
    // No editor model is configured, and both routes fail quiet by contract — so the
    // caller gets a well-formed stream rather than an error a ghost-text provider has
    // nowhere to render.
    const response = await fetch(`http://127.0.0.1:${port}/v1/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ prefix: "const ", suffix: "\n", language: "ts", filePath: "a.ts" }),
    });
    expect(response.status).toBe(200);
    const frames = await response.text();
    expect(frames).toContain("event: done");
    expect(frames).not.toContain("event: token");
  });
});

describe("Slot admission through the composed table", () => {
  it("queues the fourth Run at position 1", async () => {
    // A local provider needs no key, so these Runs get past `plan` and actually reach
    // admission — which is the only way to exercise the Slot manager through HTTP.
    await listen(
      buildRuntimeRoutes({ env, slots: new SlotManager({ capacity: 3, isLocal: () => false }) }),
    );

    const submissions = await Promise.all(
      ["s1", "s2", "s3", "s4"].map((sessionId) =>
        call("POST", "/v1/runs", {
          sessionId,
          prompt: "hello",
          mode: "agent",
          permissionMode: "ask",
          modelRef: {
            provider: "local-llamacpp",
            modelId: "qwen2.5-coder",
            baseUrl: "http://127.0.0.1:8080/v1",
          },
        }),
      ),
    );

    for (const submission of submissions) expect(submission.status).toBe(200);
    const positions = submissions.map((submission) => submission.body.queuePosition);
    expect(positions.filter((position) => position === null)).toHaveLength(3);
    expect(positions.filter((position) => position === 1)).toHaveLength(1);
  });
});
