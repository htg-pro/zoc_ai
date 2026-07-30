/**
 * Approval registry — zoc-agent-chat-rebuild R11.7, R11.9, R32.9.
 *
 * The three outcomes the endpoint maps to 200 / 409 / 410 are what this suite is
 * for. The 409-versus-410 distinction is the one worth testing: both are "you
 * cannot decide this now", and conflating them tells a user their approval was
 * duplicated when in fact it simply lapsed.
 */

import { describe, expect, it } from "vitest";

import { createApprovalRegistry } from "../approvals.ts";

function openToolRequest(registry: ReturnType<typeof createApprovalRegistry>, timeoutMs = 500) {
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("per-tool approval (R11.7)", () => {
  it("resolves an open request and reports the honoured scope", async () => {
    const registry = createApprovalRegistry({ runId: "run_1" });
    const pending = openToolRequest(registry);
    await tick();

    expect(registry.pending()).toHaveLength(1);
    expect(registry.decideTool("req_1", "approve", "run")).toBe("resolved");
    await expect(pending).resolves.toEqual({ decision: "approve", scope: "run" });
    expect(registry.pending()).toHaveLength(0);
  });

  it("answers already-decided for a second decision (the 409 case)", async () => {
    const registry = createApprovalRegistry({ runId: "run_1" });
    const pending = openToolRequest(registry);
    await tick();

    expect(registry.decideTool("req_1", "approve", "call")).toBe("resolved");
    await pending;
    expect(registry.decideTool("req_1", "reject", "call")).toBe("already-decided");
  });

  it("answers expired past the deadline (the 410 case), not already-decided", async () => {
    const registry = createApprovalRegistry({ runId: "run_1" });
    const pending = openToolRequest(registry, 20);
    await expect(pending).resolves.toMatchObject({ decision: "timeout" });

    // 410, not 409: the request was valid and the user took too long, which is a
    // different thing to tell them than "you already decided".
    expect(registry.decideTool("req_1", "approve", "call")).toBe("expired");
  });

  it("answers unknown for a request that never existed", () => {
    const registry = createApprovalRegistry({ runId: "run_1" });
    expect(registry.decideTool("req_nope", "approve", "call")).toBe("unknown");
  });

  it("narrows a scope the request did not offer rather than failing the call", async () => {
    const registry = createApprovalRegistry({ runId: "run_1" });
    const pending = registry.request({
      requestId: "req_2",
      toolName: "workspace_run_command",
      kind: "execute",
      reason: "destructive",
      paths: [],
      // `workspace` is deliberately withheld for an execute call.
      offeredScopes: ["call", "run"],
      timeoutMs: 500,
    });
    await tick();

    expect(registry.decideTool("req_2", "approve", "workspace")).toBe("resolved");
    // Narrowed to the safest scope rather than granting one that was not offered.
    await expect(pending).resolves.toEqual({ decision: "approve", scope: "call" });
  });

  it("exposes the pending request with everything the dock needs", async () => {
    const registry = createApprovalRegistry({ runId: "run_1" });
    void openToolRequest(registry);
    await tick();

    const pending = registry.pending()[0];
    expect(pending).toMatchObject({
      requestId: "req_1",
      runId: "run_1",
      toolName: "workspace_apply_hunks",
      reason: "out-of-plan-path",
      paths: ["src/a.ts"],
    });
    // An absolute deadline, so the surface can count down without a server poll.
    expect(Date.parse(pending?.expiresAt ?? "")).toBeGreaterThan(Date.now() - 1_000);
    registry.decideTool("req_1", "reject", "call");
  });
});

describe("plan approval on the same endpoint (R32.9)", () => {
  it("resolves a plan decision independently of tool requests", async () => {
    const registry = createApprovalRegistry({ runId: "run_1" });
    const plan = registry.awaitDecision({ runId: "run_1", planId: "plan_1", timeoutMs: 500 });
    await tick();

    expect(registry.decidePlan("run_1", "plan_1", "approve")).toBe("resolved");
    await expect(plan).resolves.toEqual({ decision: "approve" });
  });

  it("answers already-decided for a repeated plan decision", async () => {
    const registry = createApprovalRegistry({ runId: "run_1" });
    const plan = registry.awaitDecision({ runId: "run_1", planId: "plan_1", timeoutMs: 500 });
    await tick();
    registry.decidePlan("run_1", "plan_1", "approve");
    await plan;
    expect(registry.decidePlan("run_1", "plan_1", "reject")).toBe("unknown");
  });

  it("keeps plan and tool decisions in separate namespaces", async () => {
    const registry = createApprovalRegistry({ runId: "run_1" });
    const tool = openToolRequest(registry);
    const plan = registry.awaitDecision({ runId: "run_1", planId: "req_1", timeoutMs: 500 });
    await tick();

    // A plan id that collides with a request id must not cross-resolve.
    expect(registry.decidePlan("run_1", "req_1", "approve")).toBe("resolved");
    await expect(plan).resolves.toEqual({ decision: "approve" });
    expect(registry.pending()).toHaveLength(1);

    registry.decideTool("req_1", "reject", "call");
    await expect(tool).resolves.toMatchObject({ decision: "reject" });
  });
});

describe("run release", () => {
  it("unblocks everything a terminated run was waiting on", async () => {
    const registry = createApprovalRegistry({ runId: "run_1" });
    const tool = openToolRequest(registry, 60_000);
    const plan = registry.awaitDecision({
      runId: "run_1",
      planId: "plan_1",
      timeoutMs: 60_000,
    });
    await tick();

    // Without this, a cancelled Run would hold its deferreds for ten minutes.
    registry.releaseRun("run_1");

    await expect(tool).resolves.toMatchObject({ decision: "reject" });
    await expect(plan).resolves.toEqual({ decision: "reject" });
    expect(registry.pending()).toHaveLength(0);
  });

  it("leaves another run's requests alone", async () => {
    const registry = createApprovalRegistry({ runId: "run_1" });
    const tool = openToolRequest(registry, 500);
    await tick();
    registry.releaseRun("run_other");
    expect(registry.pending()).toHaveLength(1);
    registry.decideTool("req_1", "approve", "call");
    await expect(tool).resolves.toMatchObject({ decision: "approve" });
  });
});
