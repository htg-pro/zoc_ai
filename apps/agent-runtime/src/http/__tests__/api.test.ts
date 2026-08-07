/**
 * The composed route table — zoc-agent-chat-rebuild 9.7, design.md:1404.
 *
 * Feature: zoc-agent-chat-rebuild, task 9.7.
 *
 * A table test rather than a behaviour test. Its job is to notice an endpoint that
 * silently stopped being registered: every group is wired through one function, so a
 * refactor that drops a `register…` call would leave the group's own tests passing
 * (they register it themselves) and the running process missing a route. This is the
 * only test that would fail.
 */

import { describe, expect, it, vi } from "vitest";

import { registerApiRoutes, type ApiDeps } from "../api.ts";
import { Router } from "../routes.ts";
import { RunManager } from "../../agent/run-driver.ts";
import { RunStore, SlotManager } from "../../agent/run-store.ts";

function deps(): ApiDeps {
  const manager = new RunManager({ store: new RunStore(), slots: new SlotManager() });
  return {
    runs: {
      manager,
      plan: vi.fn(async () => ({
        provider: "openai",
        model: "gpt-4o",
        open: () => new ReadableStream(),
      })),
    },
    catalogue: { toolDescriptors: () => [] },
    benchmark: {
      benchmarkHistory: vi.fn(async () => ({
        ok: true as const,
        value: { modelId: "gpt-4o", runs: [] },
      })),
    },
    sessions: { generateTitle: vi.fn(async () => null) },
    editor: {
      generate: () =>
        (async function* empty() {
          /* no chunks */
        })(),
    },
    compaction: { hasActiveRun: () => false, prepare: vi.fn(async () => null) },
    permissions: { approvalsFor: () => null, auditEntries: () => [] },
    mcp: {
      control: {
        refresh: vi.fn(async () => ({ servers: [], tools: [] })),
        updateTool: vi.fn(() => null),
        reload: vi.fn(async () => ({ ok: true as const, value: { servers: [], tools: [] } })),
        test: vi.fn(async () => ({
          ok: true as const,
          value: { outcome: "success" as const, toolCount: 0, bareNames: [] },
        })),
      } as unknown as ApiDeps["mcp"]["control"],
    },
  };
}

/** Every endpoint 9.7 is responsible for, as method and path. */
const EXPECTED: ReadonlyArray<readonly [string, string]> = [
  ["POST", "/v1/runs"],
  ["GET", "/v1/runs/run_1/stream"],
  ["POST", "/v1/runs/run_1/cancel"],
  ["POST", "/v1/runs/run_1/approvals"],
  ["GET", "/v1/permissions/audit"],
  ["POST", "/v1/classify-intent"],
  ["GET", "/v1/providers"],
  ["GET", "/v1/models"],
  ["GET", "/v1/tools"],
  ["GET", "/v1/models/gpt-4o/benchmark"],
  ["POST", "/v1/sessions/s1/compact"],
  ["POST", "/v1/sessions/s1/title"],
  ["POST", "/v1/completions"],
  ["POST", "/v1/inline-edit"],
  ["GET", "/v1/mcp/servers"],
  ["PATCH", "/v1/mcp/tools/mcp__server__tool"],
  ["POST", "/v1/mcp/reload"],
  ["POST", "/v1/mcp/test"],
];

describe("registerApiRoutes", () => {
  it("registers every endpoint 9.7 owns", () => {
    const router = new Router();
    registerApiRoutes(router, deps());

    for (const [method, path] of EXPECTED) {
      expect(router.match(method, path), `${method} ${path}`).not.toBe(404);
      expect(router.match(method, path), `${method} ${path}`).not.toBe(405);
    }
  });

  it("distinguishes a wrong verb from a missing endpoint", () => {
    const router = new Router();
    registerApiRoutes(router, deps());

    expect(router.match("GET", "/v1/runs")).toBe(405);
    expect(router.match("GET", "/v1/nothing-here")).toBe(404);
  });

  it("keeps the MCP collection root undefined while registering its concrete routes", () => {
    const router = new Router();
    registerApiRoutes(router, deps());

    expect(router.match("GET", "/v1/mcp")).toBe(404);
  });
});
