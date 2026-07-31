/**
 * Permission gate guards — zoc-agent-chat-rebuild.
 *
 * Property 16: The permission decision matrix holds in every mode  (R11.2–R11.6)
 * Property 17: A grant covers exactly its scope                    (R11.7)
 * Property 72: A Capability refusal never becomes an approval request (R11.11, R32.5, R32.12)
 * Property 73: Plan_Approval unlocks within one Run and one sequence space (R32.8, R32.9, R7.7)
 * Property 74: A rejected or timed-out plan leaves the workspace unmodified (R32.9, R10.9)
 *
 * The 21-cell matrix is driven from a table transcribed from the design's Table B,
 * so the document is the fixture rather than the code being its own reference.
 */

import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { ToolKind } from "@zoc-studio/shared-types";

import { DEFAULT_PERMISSION_CONFIG } from "../engine.ts";
import {
  APPROVAL_TIMEOUT_MS,
  createAuditLog,
  createGate,
  createGrantLedger,
  describeAction,
  forcedApprovalReasonFor,
  normalizePath,
  offeredScopesFor,
  rewritesVcsHistory,
  type GateContext,
  type GateWriter,
  type PermissionMode,
} from "../gate.ts";
import {
  createPlanApprovalBroker,
  createPlanGate,
  planApprovalApplies,
  type PlanGateContext,
} from "../plan-gate.ts";

const RUNS = { numRuns: 200 } as const;

interface Recorded {
  modeRefusals: Array<{ tool: string; code: string }>;
  toolRefusals: Array<{ tool: string; reason: string }>;
  approvalRequests: Array<{ toolName: string; reason: string; paths: readonly string[] }>;
  timeouts: string[];
  awaiting: string[];
}

function recordingWriter(): { writer: GateWriter; log: Recorded } {
  const log: Recorded = {
    modeRefusals: [],
    toolRefusals: [],
    approvalRequests: [],
    timeouts: [],
    awaiting: [],
  };
  const writer: GateWriter = {
    modeRefusal: (tool, code) => log.modeRefusals.push({ tool, code }),
    toolRefusal: (tool, reason) => log.toolRefusals.push({ tool, reason }),
    approvalRequest: (request) =>
      log.approvalRequests.push({
        toolName: request.toolName,
        reason: request.reason,
        paths: request.paths,
      }),
    approvalTimeout: (tool) => log.timeouts.push(tool),
    awaitingApproval: (planId) => log.awaiting.push(planId),
  };
  return { writer, log };
}

/** Table B, transcribed from the design. */
type Behaviour = "execute" | "prompt" | "refuse";

interface MatrixRow {
  readonly label: string;
  readonly kind: ToolKind;
  /** Paths the call touches. */
  readonly paths: readonly string[];
  /** Paths the plan declared. */
  readonly planPaths: readonly string[];
  readonly command?: string;
  readonly expect: Readonly<Record<PermissionMode, Behaviour>>;
}

const TABLE_B: readonly MatrixRow[] = [
  {
    label: "read",
    kind: "read",
    paths: ["src/a.ts"],
    planPaths: [],
    expect: { ask: "execute", auto: "execute", deny: "execute" },
  },
  {
    label: "search",
    kind: "search",
    paths: [],
    planPaths: [],
    expect: { ask: "execute", auto: "execute", deny: "execute" },
  },
  {
    label: "write inside plan paths",
    kind: "write",
    paths: ["src/a.ts"],
    planPaths: ["src/a.ts"],
    expect: { ask: "prompt", auto: "execute", deny: "refuse" },
  },
  {
    label: "write outside plan paths",
    kind: "write",
    paths: ["src/b.ts"],
    planPaths: ["src/a.ts"],
    // R11.5: `auto` still prompts.
    expect: { ask: "prompt", auto: "prompt", deny: "refuse" },
  },
  {
    label: "execute, non-destructive",
    kind: "execute",
    paths: [],
    planPaths: [],
    command: "pnpm",
    expect: { ask: "prompt", auto: "execute", deny: "refuse" },
  },
  {
    label: "execute, destructive match",
    kind: "execute",
    paths: [],
    planPaths: [],
    command: "rm -rf",
    // R11.6: `auto` still prompts.
    expect: { ask: "prompt", auto: "prompt", deny: "refuse" },
  },
  {
    label: "mcp with side effect",
    kind: "mcp",
    paths: [],
    planPaths: [],
    expect: { ask: "prompt", auto: "execute", deny: "refuse" },
  },
];

async function runCell(row: MatrixRow, permissionMode: PermissionMode) {
  const { writer, log } = recordingWriter();
  let brokerCalls = 0;
  let executed = false;

  const ctx: GateContext = {
    runId: "run_1",
    // `agent` mode, so Table A permits everything and Table B is what is under
    // test. Table A's own refusals are Property 72's subject.
    mode: "agent",
    permissionMode,
    policy: { ...DEFAULT_PERMISSION_CONFIG, trust: "trusted" },
    workspaceRoot: "/work/proj",
    planApproval: { approved: false, planId: null, approvedAt: null },
    planPaths: new Set(row.planPaths.map(normalizePath)),
    writer,
    broker: {
      async request() {
        brokerCalls += 1;
        return { decision: "approve", scope: "call" };
      },
    },
    grants: createGrantLedger(),
    audit: createAuditLog(),
    approvalTimeoutMs: 50,
  };

  const gated = createGate(ctx);
  const args =
    row.kind === "write"
      ? { files: row.paths.map((path) => ({ path, action: "modify" })) }
      : row.kind === "execute"
        ? { command: row.command ?? "true", args: [] }
        : { path: row.paths[0] ?? "src/a.ts" };

  const execute = gated(`tool_${row.kind}`, row.kind, async () => {
    executed = true;
    return { ok: true };
  });
  const result = (await execute(args)) as Record<string, unknown>;

  return { executed, brokerCalls, log, result };
}

describe("Property 16: the permission matrix holds in every mode (R11.2–R11.6)", () => {
  it("matches all 21 cells of Table B", async () => {
    // 7 rows × 3 permission modes.
    expect(TABLE_B).toHaveLength(7);
    let asserted = 0;

    for (const row of TABLE_B) {
      for (const permissionMode of ["ask", "auto", "deny"] as const) {
        const expected = row.expect[permissionMode];
        const { executed, brokerCalls, result } = await runCell(row, permissionMode);
        asserted += 1;

        const where = `${row.label} / ${permissionMode}`;
        if (expected === "execute") {
          expect(executed, where).toBe(true);
          expect(brokerCalls, where).toBe(0);
        } else if (expected === "prompt") {
          expect(brokerCalls, where).toBe(1);
          // Approved in this fixture, so it proceeds after the prompt.
          expect(executed, where).toBe(true);
        } else {
          expect(executed, where).toBe(false);
          expect(brokerCalls, where).toBe(0);
          expect(result.refused, where).toBe(true);
        }
      }
    }
    expect(asserted).toBe(21);
  });

  it("refuses every side-effecting call in deny without ending the run", async () => {
    for (const row of TABLE_B) {
      if (row.expect.deny !== "refuse") continue;
      const { executed, result, log } = await runCell(row, "deny");
      expect(executed).toBe(false);
      // R11.4: the refusal names the blocked tool.
      expect(log.toolRefusals[0]?.tool).toBe(`tool_${row.kind}`);
      // A refusal is a result, not a throw — the Run continues.
      expect(result.refused).toBe(true);
      expect(result.retryable).toBe(false);
    }
  });

  it("never gates a read or search call in any mode", async () => {
    for (const kind of ["read", "search"] as const) {
      for (const permissionMode of ["ask", "auto", "deny"] as const) {
        const row = TABLE_B.find((entry) => entry.kind === kind) as MatrixRow;
        const { executed, brokerCalls } = await runCell(row, permissionMode);
        expect(executed, `${kind}/${permissionMode}`).toBe(true);
        expect(brokerCalls).toBe(0);
      }
    }
  });
});

describe("Property 72: a Capability refusal never becomes an approval request (R11.11)", () => {
  it("raises no approval request for anything Table A refuses", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("ask" as const, "plan" as const),
        fc.constantFrom("ask" as const, "auto" as const, "deny" as const),
        fc.constantFrom("write" as const, "execute" as const),
        async (mode, permissionMode, kind) => {
          const { writer, log } = recordingWriter();
          let brokerCalls = 0;
          let executed = false;

          const ctx: GateContext = {
            runId: "run_1",
            mode,
            permissionMode,
            policy: { ...DEFAULT_PERMISSION_CONFIG, trust: "trusted" },
            workspaceRoot: "/work/proj",
            // Unapproved, so `plan` refuses write/execute and `ask` always does.
            planApproval: { approved: false, planId: null, approvedAt: null },
            planPaths: new Set(["src/a.ts"]),
            writer,
            broker: {
              async request() {
                brokerCalls += 1;
                return { decision: "approve", scope: "call" };
              },
            },
            grants: createGrantLedger(),
            audit: createAuditLog(),
            approvalTimeoutMs: 50,
          };

          const gated = createGate(ctx);
          const execute = gated("blocked_tool", kind, async () => {
            executed = true;
            return { ok: true };
          });
          const result = (await execute(
            kind === "write"
              ? { files: [{ path: "src/a.ts", action: "modify" }] }
              : { command: "pnpm", args: ["test"] },
          )) as Record<string, unknown>;

          // The assertion that pins the order rather than trusting it.
          expect(log.approvalRequests).toHaveLength(0);
          expect(brokerCalls).toBe(0);
          expect(executed).toBe(false);
          expect(log.modeRefusals[0]?.code).toBe("mode_not_permitted");
          // Names the blocked tool (R32.12).
          expect(log.modeRefusals[0]?.tool).toBe("blocked_tool");
          expect(result.code).toBe("mode_not_permitted");
        },
      ),
      RUNS,
    );
  });

  it("reaches Table B once Table A permits", async () => {
    const { writer, log } = recordingWriter();
    let brokerCalls = 0;
    const ctx: GateContext = {
      runId: "run_1",
      mode: "plan",
      permissionMode: "ask",
      policy: { ...DEFAULT_PERMISSION_CONFIG, trust: "trusted" },
      workspaceRoot: "/work/proj",
      // Approved, so `plan:true:write` permits and Table B is consulted.
      planApproval: { approved: true, planId: "plan_1", approvedAt: "now" },
      planPaths: new Set(["src/a.ts"]),
      writer,
      broker: {
        async request() {
          brokerCalls += 1;
          return { decision: "approve", scope: "call" };
        },
      },
      grants: createGrantLedger(),
      audit: createAuditLog(),
      approvalTimeoutMs: 50,
    };
    const gated = createGate(ctx);
    await gated("workspace_apply_hunks", "write", async () => ({ ok: true }))({
      files: [{ path: "src/a.ts", action: "modify" }],
    });

    expect(log.modeRefusals).toHaveLength(0);
    expect(brokerCalls).toBe(1);
  });

  it("does not silently apply an unapproved plan in auto mode", async () => {
    // The design's worked example: Plan mode, unapproved, Permission_Mode auto.
    const { writer, log } = recordingWriter();
    let executed = false;
    const ctx: GateContext = {
      runId: "run_1",
      mode: "plan",
      permissionMode: "auto",
      policy: { ...DEFAULT_PERMISSION_CONFIG, trust: "trusted" },
      workspaceRoot: "/work/proj",
      planApproval: { approved: false, planId: null, approvedAt: null },
      planPaths: new Set(["src/a.ts"]),
      writer,
      broker: {
        async request() {
          return { decision: "approve", scope: "call" };
        },
      },
      grants: createGrantLedger(),
      audit: createAuditLog(),
    };
    const gated = createGate(ctx);
    await gated("workspace_apply_hunks", "write", async () => {
      executed = true;
      return { ok: true };
    })({ files: [{ path: "src/a.ts", action: "modify" }] });

    expect(executed).toBe(false);
    expect(log.modeRefusals[0]?.code).toBe("mode_not_permitted");
  });
});

describe("Property 17: a grant covers exactly its scope (R11.7)", () => {
  it("does not carry a call-scope grant to the next call", async () => {
    const { writer } = recordingWriter();
    let brokerCalls = 0;
    const ctx: GateContext = {
      runId: "run_1",
      mode: "agent",
      permissionMode: "ask",
      policy: { ...DEFAULT_PERMISSION_CONFIG, trust: "trusted" },
      workspaceRoot: "/work/proj",
      planApproval: { approved: false, planId: null, approvedAt: null },
      planPaths: new Set<string>(),
      writer,
      broker: {
        async request() {
          brokerCalls += 1;
          return { decision: "approve", scope: "call" };
        },
      },
      grants: createGrantLedger(),
      audit: createAuditLog(),
    };
    const gated = createGate(ctx);
    const execute = gated("workspace_run_command", "execute", async () => ({ ok: true }));
    await execute({ command: "pnpm", args: ["test"] });
    await execute({ command: "pnpm", args: ["test"] });
    // Two prompts: `call` scope covers exactly the call that was approved.
    expect(brokerCalls).toBe(2);
  });

  it("carries a run-scope grant to a later identical call", async () => {
    const { writer } = recordingWriter();
    let brokerCalls = 0;
    const ctx: GateContext = {
      runId: "run_1",
      mode: "agent",
      permissionMode: "ask",
      policy: { ...DEFAULT_PERMISSION_CONFIG, trust: "trusted" },
      workspaceRoot: "/work/proj",
      planApproval: { approved: false, planId: null, approvedAt: null },
      planPaths: new Set<string>(),
      writer,
      broker: {
        async request() {
          brokerCalls += 1;
          return { decision: "approve", scope: "run" };
        },
      },
      grants: createGrantLedger(),
      audit: createAuditLog(),
    };
    const gated = createGate(ctx);
    const execute = gated("workspace_run_command", "execute", async () => ({ ok: true }));
    await execute({ command: "pnpm", args: ["test"] });
    await execute({ command: "pnpm", args: ["test"] });
    expect(brokerCalls).toBe(1);
  });

  it("withholds the workspace scope for an execute call", () => {
    // A workspace-wide standing grant for a destructive command is a footgun.
    expect(offeredScopesFor("execute")).toEqual(["call", "run"]);
    expect(offeredScopesFor("write")).toContain("workspace");
  });

  it("records nothing for a call-scope grant", () => {
    const ledger = createGrantLedger();
    const request = { kind: "terminal" as const, name: "pnpm test" };
    ledger.record(request, "call");
    expect(ledger.covers(request)).toBe(false);
    ledger.record(request, "run");
    expect(ledger.covers(request)).toBe(true);
  });
});

describe("forced approval (R11.5, R11.6)", () => {
  it("forces a prompt for any out-of-plan path in a batch", () => {
    const request = describeAction("write", "workspace_apply_hunks", {
      files: [
        { path: "src/a.ts", action: "modify" },
        { path: "src/b.ts", action: "modify" },
      ],
    });
    // Checking only the first path would miss this: eight in-plan files and one
    // out-of-plan file must still prompt.
    expect(forcedApprovalReasonFor(request, "write", { planPaths: new Set(["src/a.ts"]) })).toBe(
      "out-of-plan-path",
    );
    expect(
      forcedApprovalReasonFor(request, "write", {
        planPaths: new Set(["src/a.ts", "src/b.ts"]),
      }),
    ).toBeNull();
  });

  it("treats a write with no declared plan as out of plan", () => {
    const request = describeAction("write", "workspace_apply_hunks", {
      files: [{ path: "src/a.ts", action: "modify" }],
    });
    expect(forcedApprovalReasonFor(request, "write", { planPaths: new Set<string>() })).toBe(
      "out-of-plan-path",
    );
  });

  it("forces a prompt for a declared deletion", () => {
    const request = describeAction("write", "workspace_apply_hunks", {
      files: [{ path: "src/a.ts", action: "delete" }],
    });
    expect(request.destructive).toBe(true);
  });

  it("forces a prompt on every VCS history rewrite", () => {
    for (const command of [
      "git push --force origin main",
      "git push -f",
      "git reset --hard HEAD~3",
      "git rebase -i main",
      "git filter-branch --all",
      "git commit --amend",
    ]) {
      expect(rewritesVcsHistory(command), command).toBe(true);
    }
    for (const command of ["git status", "git log", "git push origin main"]) {
      expect(rewritesVcsHistory(command), command).toBe(false);
    }
  });

  it("forces a prompt on a destructive-intent match", () => {
    const request = describeAction("execute", "workspace_run_command", {
      command: "rm",
      args: ["-rf", "node_modules"],
    });
    expect(forcedApprovalReasonFor(request, "execute", { planPaths: new Set() })).toBe(
      "destructive",
    );
  });

  it("normalises a path before comparing it to the plan", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("src/a.ts", "./src/a.ts", "src\\a.ts", "src/a.ts/"),
        (variant) => {
          expect(normalizePath(variant)).toBe("src/a.ts");
        },
      ),
      RUNS,
    );
  });
});

describe("approval deadline (R11.9)", () => {
  it("cancels the call and emits a timeout part", async () => {
    const { writer, log } = recordingWriter();
    let executed = false;
    const ctx: GateContext = {
      runId: "run_1",
      mode: "agent",
      permissionMode: "ask",
      policy: { ...DEFAULT_PERMISSION_CONFIG, trust: "trusted" },
      workspaceRoot: "/work/proj",
      planApproval: { approved: false, planId: null, approvedAt: null },
      planPaths: new Set<string>(),
      writer,
      broker: {
        async request() {
          return { decision: "timeout", scope: "call" };
        },
      },
      grants: createGrantLedger(),
      audit: createAuditLog(),
      approvalTimeoutMs: 10,
    };
    const gated = createGate(ctx);
    const result = (await gated("workspace_run_command", "execute", async () => {
      executed = true;
      return { ok: true };
    })({ command: "pnpm", args: ["test"] })) as Record<string, unknown>;

    expect(executed).toBe(false);
    expect(log.timeouts).toEqual(["workspace_run_command"]);
    expect(result.code).toBe("permission_timeout");
  });

  it("keeps the documented ten-minute default", () => {
    expect(APPROVAL_TIMEOUT_MS).toBe(600_000);
  });
});

describe("Property 73: Plan_Approval unlocks within one Run (R32.8, R32.9, R7.7)", () => {
  it("emits awaiting-approval and unlocks write under the same runId", async () => {
    const { writer, log } = recordingWriter();
    const broker = createPlanApprovalBroker();
    const ctx: PlanGateContext = {
      runId: "run_1",
      mode: "plan",
      permissionMode: "auto",
      policy: { ...DEFAULT_PERMISSION_CONFIG, trust: "trusted" },
      workspaceRoot: "/work/proj",
      planApproval: { approved: false, planId: null, approvedAt: null },
      planPaths: new Set(["src/a.ts"]),
      writer,
      broker: {
        async request() {
          return { decision: "approve", scope: "call" };
        },
      },
      grants: createGrantLedger(),
      audit: createAuditLog(),
      approvalTimeoutMs: 2_000,
      planBroker: broker,
    };

    const planGated = createPlanGate(ctx);
    const gated = createGate(ctx);
    let wrote = false;
    const write = gated("workspace_apply_hunks", "write", async () => {
      wrote = true;
      return { ok: true };
    });

    // Before approval: the write is refused by Table A.
    await write({ files: [{ path: "src/a.ts", action: "modify" }] });
    expect(wrote).toBe(false);

    const pending = planGated({ planId: "plan_1", writePlan: () => undefined });
    // Give the broker a tick to register the deferred.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(log.awaiting).toEqual(["plan_1"]);
    expect(broker.decide("run_1", "plan_1", "approve")).toBe(true);
    await expect(pending).resolves.toMatchObject({ approved: true, planId: "plan_1" });

    // After approval: the *same* table now permits, with no unlock routine.
    await write({ files: [{ path: "src/a.ts", action: "modify" }] });
    expect(wrote).toBe(true);
    // Same Run throughout — no second run id was allocated.
    expect(ctx.runId).toBe("run_1");
    expect(ctx.planApproval.planId).toBe("plan_1");
  });

  it("does not gate propose_plan in agent or ask mode", async () => {
    expect(planApprovalApplies("plan")).toBe(true);
    expect(planApprovalApplies("agent")).toBe(false);
    expect(planApprovalApplies("ask")).toBe(false);

    for (const mode of ["agent", "ask"] as const) {
      const { writer, log } = recordingWriter();
      const ctx: PlanGateContext = {
        runId: "run_1",
        mode,
        permissionMode: "ask",
        policy: DEFAULT_PERMISSION_CONFIG,
        workspaceRoot: null,
        planApproval: { approved: false, planId: null, approvedAt: null },
        planPaths: new Set<string>(),
        writer,
        broker: {
          async request() {
            return { decision: "approve", scope: "call" };
          },
        },
        grants: createGrantLedger(),
        audit: createAuditLog(),
        planBroker: createPlanApprovalBroker(),
      };
      const writePlan = vi.fn();
      await expect(createPlanGate(ctx)({ planId: "plan_1", writePlan })).resolves.toMatchObject({
        approved: true,
      });
      expect(writePlan).toHaveBeenCalledTimes(1);
      // No pause: a prompt here would have no effect but delay.
      expect(log.awaiting).toEqual([]);
    }
  });

  it("writes the plan before pausing, not after", async () => {
    const order: string[] = [];
    const { writer } = recordingWriter();
    const broker = createPlanApprovalBroker();
    const ctx: PlanGateContext = {
      runId: "run_1",
      mode: "plan",
      permissionMode: "ask",
      policy: DEFAULT_PERMISSION_CONFIG,
      workspaceRoot: null,
      planApproval: { approved: false, planId: null, approvedAt: null },
      planPaths: new Set<string>(),
      writer: {
        ...writer,
        awaitingApproval: (planId) => order.push(`await:${planId}`),
      },
      broker: {
        async request() {
          return { decision: "approve", scope: "call" };
        },
      },
      grants: createGrantLedger(),
      audit: createAuditLog(),
      approvalTimeoutMs: 500,
      planBroker: broker,
    };
    const pending = createPlanGate(ctx)({
      planId: "plan_1",
      writePlan: () => {
        order.push("write");
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    broker.decide("run_1", "plan_1", "approve");
    await pending;
    // The user must have the plan in front of them while deciding.
    expect(order).toEqual(["write", "await:plan_1"]);
  });
});

describe("Property 74: a rejected or lapsed plan leaves the workspace unmodified (R32.9, R10.9)", () => {
  it("leaves planApproval false and writes nothing on rejection", async () => {
    const { writer } = recordingWriter();
    const broker = createPlanApprovalBroker();
    const ctx: PlanGateContext = {
      runId: "run_1",
      mode: "plan",
      permissionMode: "auto",
      policy: { ...DEFAULT_PERMISSION_CONFIG, trust: "trusted" },
      workspaceRoot: "/work/proj",
      planApproval: { approved: false, planId: null, approvedAt: null },
      planPaths: new Set(["src/a.ts"]),
      writer,
      broker: {
        async request() {
          return { decision: "approve", scope: "call" };
        },
      },
      grants: createGrantLedger(),
      audit: createAuditLog(),
      approvalTimeoutMs: 1_000,
      planBroker: broker,
    };

    const pending = createPlanGate(ctx)({ planId: "plan_1", writePlan: () => undefined });
    await new Promise((resolve) => setTimeout(resolve, 5));
    broker.decide("run_1", "plan_1", "reject");
    const outcome = await pending;

    expect(outcome.ok).toBe(false);
    expect(ctx.planApproval.approved).toBe(false);
    expect(ctx.planApproval.planId).toBeNull();

    let wrote = false;
    await createGate(ctx)("workspace_apply_hunks", "write", async () => {
      wrote = true;
      return { ok: true };
    })({ files: [{ path: "src/a.ts", action: "modify" }] });
    expect(wrote).toBe(false);
  });

  it("reaches a terminal outcome on timeout rather than hanging", async () => {
    const { writer } = recordingWriter();
    const ctx: PlanGateContext = {
      runId: "run_1",
      mode: "plan",
      permissionMode: "ask",
      policy: DEFAULT_PERMISSION_CONFIG,
      workspaceRoot: null,
      planApproval: { approved: false, planId: null, approvedAt: null },
      planPaths: new Set<string>(),
      writer,
      broker: {
        async request() {
          return { decision: "approve", scope: "call" };
        },
      },
      grants: createGrantLedger(),
      audit: createAuditLog(),
      // 20 ms rather than ten minutes.
      approvalTimeoutMs: 20,
      planBroker: createPlanApprovalBroker(),
    };
    const outcome = await createPlanGate(ctx)({
      planId: "plan_1",
      writePlan: () => undefined,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.code).toBe("permission_timeout");
    expect(ctx.planApproval.approved).toBe(false);
  });

  it("refuses a second decision for an already-decided plan (the 409 case)", async () => {
    const broker = createPlanApprovalBroker();
    const pending = broker.awaitDecision({
      runId: "run_1",
      planId: "plan_1",
      timeoutMs: 500,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(broker.decide("run_1", "plan_1", "approve")).toBe(true);
    await pending;
    // Already decided, and already removed.
    expect(broker.decide("run_1", "plan_1", "reject")).toBe(false);
  });

  it("reports no pending decision for an unknown run or plan", () => {
    const broker = createPlanApprovalBroker();
    expect(broker.decide("run_missing", "plan_1", "approve")).toBe(false);
    expect(broker.pending()).toEqual([]);
  });
});

describe("audit log", () => {
  it("bounds itself to the documented 500 entries", () => {
    const audit = createAuditLog();
    for (let i = 0; i < 600; i += 1) {
      audit.record(
        { kind: "terminal", name: `cmd_${i}` },
        { effect: "allow", reason: "x" },
        "run_1",
      );
    }
    expect(audit.entries()).toHaveLength(500);
    // The oldest are dropped, not the newest.
    expect(audit.entries()[499]?.name).toBe("cmd_599");
  });

  it("records a capability refusal as a deny", async () => {
    const { writer } = recordingWriter();
    const audit = createAuditLog();
    const ctx: GateContext = {
      runId: "run_1",
      mode: "ask",
      permissionMode: "auto",
      policy: DEFAULT_PERMISSION_CONFIG,
      workspaceRoot: null,
      planApproval: { approved: false, planId: null, approvedAt: null },
      planPaths: new Set<string>(),
      writer,
      broker: {
        async request() {
          return { decision: "approve", scope: "call" };
        },
      },
      grants: createGrantLedger(),
      audit,
      approvalTimeoutMs: 50,
    };
    await createGate(ctx)("workspace_apply_hunks", "write", async () => ({ ok: true }))({
      files: [{ path: "src/a.ts", action: "modify" }],
    });
    expect(audit.entries()[0]?.effect).toBe("deny");
    expect(audit.entries()[0]?.reason).toBe("mode_not_permitted");
  });
});
