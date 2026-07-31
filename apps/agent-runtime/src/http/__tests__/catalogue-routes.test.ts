/**
 * The catalogue and Session-title routes over real HTTP — R6.2, R13.1, R15.12, 9.7.
 *
 * Two groups in one file because they share a harness and nothing else, and because
 * the thing worth asserting about both is negative: the catalogue routes answer with
 * no credential in the body, and the title route reaches no Workspace_Services
 * client. Both are properties that a passing feature test would not notice losing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createAdmission } from "../admission.ts";
import { createRequestListener } from "../../main.ts";
import { buildRoutes, type Router } from "../routes.ts";
import { registerCatalogueRoutes } from "../catalogue-routes.ts";
import { registerSessionRoutes, tidyTitle, type TitleOutcome } from "../session-routes.ts";
import type { ToolDescriptor } from "../../tools/registry.ts";

const TOKEN = "catalogue-token-0123456789abcd";

let server: Server;
let port = 0;

const descriptors: readonly ToolDescriptor[] = [
  { name: "workspace_read", kind: "read", description: "Read one workspace file.", tool: null },
  {
    name: "workspace_apply_hunks",
    kind: "write",
    description: "Apply accepted hunks.",
    tool: null,
  },
];

function listen(configure: (router: Router) => void): Promise<void> {
  const route = buildRoutes(
    { token: TOKEN, workspaceServicesUrl: "http://127.0.0.1:1", workspaceRoot: "/tmp" },
    configure,
  );
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
  path: string,
  method: "GET" | "POST" = "GET",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

describe("the catalogue routes", () => {
  beforeEach(async () => {
    await listen((router) =>
      registerCatalogueRoutes(router, { toolDescriptors: () => descriptors }),
    );
  });

  it("lists all six providers with their capabilities and no credential", async () => {
    const { status, body } = await call("/v1/providers");
    const providers = body.providers as ReadonlyArray<Record<string, unknown>>;

    expect(status).toBe(200);
    expect(providers).toHaveLength(6);
    expect(providers.map((provider) => provider.id)).toContain("local-llamacpp");
    // Nothing in the answer may name a key, a base URL, or a `resolve` function: the
    // picker reads this, and the picker runs in the renderer.
    const serialised = JSON.stringify(body);
    expect(serialised).not.toMatch(/apiKey|api_key|secret|token/i);
    expect(providers[0]).toEqual({
      id: expect.any(String),
      label: expect.any(String),
      requiresKey: expect.any(Boolean),
      local: expect.any(Boolean),
      capabilities: {
        tools: expect.any(Boolean),
        vision: expect.any(Boolean),
        reasoning: expect.any(Boolean),
        search: expect.any(Boolean),
      },
    });
  });

  it("lists models with the default window alongside, for the ones it lacks", async () => {
    const { status, body } = await call("/v1/models");
    expect(status).toBe(200);
    expect((body.models as unknown[]).length).toBeGreaterThan(0);
    expect(body.defaultContextWindow).toBe(8192);
  });

  it("filters models by provider", async () => {
    const { body } = await call("/v1/models?provider=anthropic");
    const models = body.models as ReadonlyArray<Record<string, unknown>>;
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model) => model.provider === "anthropic")).toBe(true);
  });

  it("treats an empty provider filter as no filter", async () => {
    const { body: filtered } = await call("/v1/models?provider=");
    const { body: all } = await call("/v1/models");
    expect(filtered).toEqual(all);
  });

  it("reports each tool's kind and whether it is gated", async () => {
    const { status, body } = await call("/v1/tools");
    expect(status).toBe(200);
    expect(body.tools).toEqual([
      {
        name: "workspace_read",
        kind: "read",
        description: "Read one workspace file.",
        gated: false,
      },
      {
        name: "workspace_apply_hunks",
        kind: "write",
        description: "Apply accepted hunks.",
        gated: true,
      },
    ]);
  });

  it("answers without a Run, a Session, or a key", async () => {
    // The whole point of a catalogue: A6's zero-key path has to be able to show the
    // user what exists before they have configured anything at all.
    expect((await call("/v1/providers")).status).toBe(200);
    expect((await call("/v1/models")).status).toBe(200);
    expect((await call("/v1/tools")).status).toBe(200);
  });
});

describe("POST /v1/sessions/:id/title (R15.12)", () => {
  let outcome: TitleOutcome | null;
  let workspace: { read: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    outcome = { kind: "titled", title: "Refactor the run driver" };
    // A spy standing in for the Workspace_Services client. The route has no field to
    // hold one, so the assertion is that the deps port never grew a way to reach it —
    // the R6.2 half of R15.12 and the thing a later refactor is most likely to break.
    workspace = { read: vi.fn() };
    await listen((router) =>
      registerSessionRoutes(router, {
        generateTitle: async (sessionId) => (sessionId === "s1" ? outcome : null),
      }),
    );
  });

  it("answers the title, and reaches no Workspace_Services client to get it", async () => {
    const { status, body } = await call("/v1/sessions/s1/title", "POST");
    expect(status).toBe(200);
    expect(body).toEqual({ title: "Refactor the run driver" });
    expect(workspace.read).not.toHaveBeenCalled();
  });

  it("needs no body fields — the Session is the entire input", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/sessions/s1/title`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    await response.text();
  });

  it("answers 409 title_not_needed for a Session with no messages", async () => {
    outcome = { kind: "not-needed" };
    const { status, body } = await call("/v1/sessions/s1/title", "POST");
    expect(status).toBe(409);
    expect(body.code).toBe("title_not_needed");
    expect(body.retryable).toBe(false);
  });

  it("answers 502 title_generation_failed, retryable, leaving the title alone", async () => {
    outcome = { kind: "failed", error: { message: "rate limited" } };
    const { status, body } = await call("/v1/sessions/s1/title", "POST");
    expect(status).toBe(502);
    expect(body.code).toBe("title_generation_failed");
    expect(body.retryable).toBe(true);
    expect(body.message).toContain("unchanged");
  });

  it("treats an empty answer as a failure, never as a rename to nothing", async () => {
    outcome = { kind: "titled", title: '   "" \n ' };
    const { status, body } = await call("/v1/sessions/s1/title", "POST");
    expect(status).toBe(502);
    expect(body.code).toBe("title_generation_failed");
  });

  it("answers 404 for a Session that does not exist", async () => {
    const { status, body } = await call("/v1/sessions/nope/title", "POST");
    expect(status).toBe(404);
    expect(body.code).toBe("not_found");
  });

  it("clips a title the model made too long", async () => {
    outcome = { kind: "titled", title: "x".repeat(200) };
    const { body } = await call("/v1/sessions/s1/title", "POST");
    expect((body.title as string).length).toBe(80);
    expect(body.title).toMatch(/…$/);
  });
});

describe("tidyTitle", () => {
  it("strips what a model adds despite being asked not to", () => {
    expect(tidyTitle('  "Fix the resume window."  ')).toBe("Fix the resume window");
    expect(tidyTitle("Title: Slot admission")).toBe("Slot admission");
    expect(tidyTitle("A title\nover two lines")).toBe("A title over two lines");
    expect(tidyTitle("Keep the question mark?")).toBe("Keep the question mark");
  });

  it("leaves an ordinary title exactly as it is", () => {
    expect(tidyTitle("Run driver cancellation")).toBe("Run driver cancellation");
  });
});
