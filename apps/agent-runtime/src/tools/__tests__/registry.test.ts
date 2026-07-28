/**
 * Tool registry guards and Property 15 — zoc-agent-chat-rebuild.
 *
 * Property 15: Workspace failure is retryable and non-fatal (validates R6.6)
 *
 * Plus the R10.16 guard, which is the assertion that pins the single-mutation-path
 * decision rather than trusting a comment: the tool-name set contains no
 * `write_file` and no `delete_file`, and every tool tagged `write` resolves to
 * `workspace_apply_hunks`.
 */

import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { ToolKind } from "@zoc-studio/shared-types";

import {
  COMPLETION_TOOL,
  FORBIDDEN_TOOL_NAMES,
  MCP_PREFIX,
  MUTATION_TOOL,
  assertRegistryIsWellFormed,
  buildToolDescriptors,
  kindOf,
  toToolMap,
  toolCatalogue,
  type ToolDescriptor,
} from "../registry.ts";
import { ABSENT_DIGEST, WorkspaceClient } from "../workspace-client.ts";

const RUNS = { numRuns: 200 } as const;

/** A gate that records calls and otherwise passes through. */
function recordingGate() {
  const gated: Array<{ name: string; kind: ToolKind }> = [];
  const gate = <A, R>(name: string, kind: ToolKind, execute: (args: A) => Promise<R>) => {
    gated.push({ name, kind });
    return execute;
  };
  return { gated, gate };
}

function descriptors(client: WorkspaceClient): readonly ToolDescriptor[] {
  const { gate } = recordingGate();
  return buildToolDescriptors({ workspace: client, sessionId: "sess_1", gated: gate });
}

function clientWith(fetchImpl: typeof fetch): WorkspaceClient {
  return new WorkspaceClient({
    bridgeUrl: "http://127.0.0.1:9/bridge",
    servicesUrl: "http://127.0.0.1:9",
    token: "token-0123456789",
    fetchImpl,
  });
}

describe("R10.16: exactly one mutation path", () => {
  const list = descriptors(clientWith(vi.fn()));

  it("contains no write_file and no delete_file", () => {
    const names = list.map((descriptor) => descriptor.name);
    for (const forbidden of FORBIDDEN_TOOL_NAMES) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("resolves every write-kind tool to workspace_apply_hunks", () => {
    const writers = list.filter((descriptor) => descriptor.kind === "write");
    expect(writers).toHaveLength(1);
    expect(writers[0]?.name).toBe(MUTATION_TOOL);
  });

  it("refuses a registry that adds a forbidden name", () => {
    for (const forbidden of FORBIDDEN_TOOL_NAMES) {
      expect(() =>
        assertRegistryIsWellFormed([
          { name: forbidden, kind: "write", description: "", tool: null },
        ]),
      ).toThrow(/R10\.16/);
    }
  });

  it("refuses a second write-kind tool under any name", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 24 }).filter((name) => name !== MUTATION_TOOL),
        (name) => {
          expect(() =>
            assertRegistryIsWellFormed([
              { name, kind: "write", description: "", tool: null },
            ]),
          ).toThrow(/single mutation path|R10\.16/);
        },
      ),
      RUNS,
    );
  });

  it("refuses a duplicate tool name", () => {
    expect(() =>
      assertRegistryIsWellFormed([
        { name: "workspace_read", kind: "read", description: "", tool: null },
        { name: "workspace_read", kind: "read", description: "", tool: null },
      ]),
    ).toThrow(/collision/);
  });

  it("covers all four HunkActions through the one tool", () => {
    // R10.10: no action needs a tool of its own.
    const mutation = list.find((descriptor) => descriptor.name === MUTATION_TOOL);
    expect(mutation).toBeDefined();
    const schema = JSON.stringify(mutation?.tool?.inputSchema ?? {});
    for (const action of ["create", "modify", "delete", "rename"]) {
      expect(schema).toContain(action);
    }
  });
});

describe("registry shape", () => {
  const list = descriptors(clientWith(vi.fn()));

  it("names built-ins with the workspace_ prefix or a control verb", () => {
    for (const descriptor of list) {
      const ok =
        descriptor.name.startsWith("workspace_") ||
        descriptor.name === "propose_plan" ||
        descriptor.name === COMPLETION_TOOL;
      expect(ok, `unexpected tool name ${descriptor.name}`).toBe(true);
    }
  });

  it("reserves the MCP namespace without using it in M1", () => {
    expect(MCP_PREFIX).toBe("mcp__");
    for (const descriptor of list) {
      expect(descriptor.name.startsWith(MCP_PREFIX)).toBe(false);
    }
  });

  it("gives declare_complete no execute at all", () => {
    const completion = list.find((descriptor) => descriptor.name === COMPLETION_TOOL);
    expect(completion).toBeDefined();
    // The absence *is* the terminal signal.
    expect(completion?.tool).toBeNull();
  });

  it("never gates read or search, and always gates the rest", () => {
    for (const entry of toolCatalogue(list)) {
      const shouldGate = entry.kind !== "read" && entry.kind !== "search";
      expect(entry.gated, entry.name).toBe(shouldGate);
    }
  });

  it("omits the null-tool entries from the agent's tool map", () => {
    const map = toToolMap(list);
    expect(Object.keys(map)).not.toContain(COMPLETION_TOOL);
    expect(Object.keys(map)).toContain("workspace_read");
    expect(Object.keys(map)).toContain(MUTATION_TOOL);
  });

  it("resolves a kind for every registered tool and null for anything else", () => {
    for (const descriptor of list) {
      expect(kindOf(list, descriptor.name)).toBe(descriptor.kind);
    }
    expect(kindOf(list, "no_such_tool")).toBeNull();
  });

  it("wraps exactly the gated tools and no others", () => {
    const { gated, gate } = recordingGate();
    buildToolDescriptors({
      workspace: clientWith(vi.fn()),
      sessionId: "sess_1",
      gated: gate,
    });
    const wrapped = gated.map((entry) => entry.name).sort();
    expect(wrapped).toEqual([
      MUTATION_TOOL,
      "workspace_run_command",
      "workspace_run_tests",
    ]);
  });
});

describe("Property 15: workspace failure is retryable and non-fatal (R6.6)", () => {
  it("turns every transport failure into a retryable result, never a throw", async () => {
    const failures = [
      () => Promise.reject(new Error("ECONNREFUSED")),
      () => Promise.reject(new TypeError("fetch failed")),
      () => Promise.reject(new Error("socket hang up")),
    ];

    for (const failure of failures) {
      const client = clientWith(failure as unknown as typeof fetch);
      const outcome = await client.read("src/index.ts");
      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.retryable).toBe(true);
      expect(outcome.ok === false && outcome.code).toBe("workspace_unavailable");
    }
  });

  it("marks a 5xx or back-off status retryable and a 4xx not", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(400, 403, 404, 409, 413, 422, 408, 425, 429, 500, 502, 503, 504),
        async (status) => {
          const client = clientWith(
            (async () =>
              new Response(JSON.stringify({ code: "x", message: "y" }), {
                status,
              })) as unknown as typeof fetch,
          );
          const outcome = await client.read("src/index.ts");
          expect(outcome.ok).toBe(false);
          const expected = status >= 500 || [408, 425, 429].includes(status);
          expect(outcome.ok === false && outcome.retryable, `status ${status}`).toBe(expected);
        },
      ),
      { numRuns: 30 },
    );
  });

  it("treats an unresolved endpoint as retryable rather than fatal", async () => {
    const client = new WorkspaceClient({
      bridgeUrl: null,
      servicesUrl: null,
      token: "t",
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    for (const outcome of [
      await client.read("a"),
      await client.applyHunks({ planId: "p", files: [{ path: "a", action: "modify" }] }),
      await client.runCommand({ command: "true" }),
      await client.contextSearch("s", "q"),
    ]) {
      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.retryable).toBe(true);
    }
  });

  it("surfaces a failure as a tool result the model can read", async () => {
    const client = clientWith(
      (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    );
    const list = descriptors(client);
    const read = list.find((descriptor) => descriptor.name === "workspace_read");
    const execute = read?.tool?.execute as (args: { path: string }) => Promise<unknown>;

    // The whole point: this resolves, it does not reject. A throw here would end
    // the Run for a service that is merely restarting.
    const result = (await execute({ path: "src/index.ts" })) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(typeof result.message).toBe("string");
  });

  it("does not mark a non-JSON error body as unreadable", async () => {
    const client = clientWith(
      (async () => new Response("<html>gateway timeout</html>", { status: 504 })) as unknown as typeof fetch,
    );
    const outcome = await client.read("a");
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.retryable).toBe(true);
    // The HTML body is not echoed into the message.
    expect(outcome.ok === false && outcome.message).not.toContain("<html>");
  });
});

describe("apply-hunks request shaping", () => {
  it("sends all four actions through one call with snake_case keys", async () => {
    const bodies: string[] = [];
    const client = clientWith((async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ plan_id: "p", applied: [], checkpoint_id: null }), {
        status: 200,
      });
    }) as unknown as typeof fetch);

    await client.applyHunks({
      planId: "plan_1",
      files: [
        { path: "new.ts", action: "create", unifiedDiff: "@@", baseDigest: ABSENT_DIGEST },
        { path: "old.ts", action: "modify", unifiedDiff: "@@", baseDigest: "sha256:aa" },
        { path: "gone.ts", action: "delete", unifiedDiff: "@@" },
        { path: "to.ts", action: "rename", sourcePath: "from.ts" },
      ],
    });

    expect(bodies).toHaveLength(1);
    const body = JSON.parse(bodies[0] as string) as Record<string, unknown>;
    expect(body.plan_id).toBe("plan_1");
    expect(body.checkpoint).toBe(true);
    const files = body.files as Array<Record<string, unknown>>;
    expect(files.map((file) => file.action)).toEqual([
      "create",
      "modify",
      "delete",
      "rename",
    ]);
    expect(files[0]?.base_digest).toBe(ABSENT_DIGEST);
    expect(files[3]?.source_path).toBe("from.ts");
  });

  it("keeps the absent-file digest distinct from an empty file's", () => {
    // R10.15, asserted on the TypeScript side too so both ends agree.
    expect(ABSENT_DIGEST).toBe("absent:0");
    expect(ABSENT_DIGEST).not.toMatch(/^sha256:/);
  });
});
