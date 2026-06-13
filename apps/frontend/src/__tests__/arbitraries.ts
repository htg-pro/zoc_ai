/**
 * Shared fast-check arbitraries for the studio-ui-redesign property tests.
 *
 * These generate values over the real `@llama-studio/shared-types` unions so
 * the property tests exercise the same shapes the runtime consumes. Edge cases
 * called out in the design prework (empty lists, whitespace-only messages, odd
 * diffs, `total = 0` plans, out-of-order / duplicate `seq`, reduced-motion
 * on/off) are produced here rather than as separate tests.
 */
import fc from "fast-check";
import type {
  AgentEvent,
  DiffPatch,
  Message,
  Plan,
  PlanStep,
  PlanStepStatus,
  ReplitCheckpoint,
  Session,
  SessionStatus,
  ToolCall,
  ToolCallStatus,
} from "@llama-studio/shared-types";

const PLAN_STEP_STATUSES: PlanStepStatus[] = [
  "pending",
  "running",
  "done",
  "failed",
  "repairing",
  "skipped",
];

const SESSION_STATUSES: SessionStatus[] = ["active", "idle", "closed"];

const TOOL_CALL_STATUSES: ToolCallStatus[] = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "needs_approval",
];

/** A short, stable id-like token. */
export const arbId = fc.hexaString({ minLength: 1, maxLength: 8 });

/** ISO timestamp from a bounded epoch range so ordering is meaningful. */
export const arbIsoDate = fc
  .integer({ min: 0, max: 4_102_444_800_000 })
  .map((ms) => new Date(ms).toISOString());

export const arbPlanStepStatus = fc.constantFrom(...PLAN_STEP_STATUSES);

export const arbPlanStep: fc.Arbitrary<PlanStep> = fc.record({
  id: arbId,
  title: fc.string({ maxLength: 40 }),
  detail: fc.option(fc.string({ maxLength: 40 }), { nil: null }),
  status: arbPlanStepStatus,
  attempt: fc.nat({ max: 5 }),
  error: fc.option(fc.string({ maxLength: 40 }), { nil: null }),
  done: fc.boolean(),
});

export const arbPlanSteps = (max = 12): fc.Arbitrary<PlanStep[]> =>
  fc.array(arbPlanStep, { maxLength: max });

export const arbPlan: fc.Arbitrary<Plan> = fc.record({
  id: arbId,
  goal: fc.string({ maxLength: 40 }),
  steps: arbPlanSteps(),
  created_at: arbIsoDate,
});

/** A plan whose steps have unique ids (useful for isolation properties). */
export const arbPlanUniqueIds: fc.Arbitrary<Plan> = fc
  .uniqueArray(arbId, { maxLength: 12 })
  .chain((ids) =>
    fc
      .tuple(...ids.map(() => arbPlanStepStatus))
      .map((statuses) => ({
        id: "plan",
        goal: "g",
        created_at: new Date(0).toISOString(),
        steps: ids.map((id, i) => ({
          id,
          title: `step-${i}`,
          detail: null,
          status: statuses[i],
          attempt: 0,
          error: null,
          done: statuses[i] === "done",
        })),
      })),
  );

export const arbSessionStatus = fc.constantFrom(...SESSION_STATUSES);

export const arbSession: fc.Arbitrary<Session> = fc.record({
  id: arbId,
  title: fc.string({ maxLength: 30 }),
  status: arbSessionStatus,
  workspace_root: fc.string({ maxLength: 20 }),
  provider: fc.option(fc.string({ maxLength: 10 }), { nil: null }),
  model: fc.option(fc.string({ maxLength: 16 }), { nil: null }),
  created_at: arbIsoDate,
  updated_at: arbIsoDate,
  messages: fc.constant([]),
  plan: fc.constant(null),
  tool_calls: fc.constant([]),
});

/** Sessions with unique ids — required for grouping/pin/delete isolation. */
export const arbSessionsUniqueIds: fc.Arbitrary<Session[]> = fc
  .uniqueArray(arbId, { maxLength: 12 })
  .chain((ids) =>
    fc.tuple(
      ...ids.map((id) =>
        arbSession.map((s) => ({ ...s, id })),
      ),
    ),
  )
  .map((arr) => arr as Session[]);

export const arbMessage: fc.Arbitrary<Message> = fc.record({
  id: arbId,
  role: fc.constantFrom("user", "assistant", "system", "tool") as fc.Arbitrary<
    Message["role"]
  >,
  content: fc.string({ maxLength: 40 }),
  name: fc.constant(null),
  tool_call_id: fc.constant(null),
  created_at: arbIsoDate,
});

export const arbToolCall: fc.Arbitrary<ToolCall> = fc.record({
  id: arbId,
  name: fc.string({ minLength: 1, maxLength: 16 }),
  arguments: fc.constant({}),
  status: fc.constantFrom(...TOOL_CALL_STATUSES),
  result: fc.constant(null),
  error: fc.option(fc.string({ maxLength: 20 }), { nil: null }),
  started_at: fc.constant(null),
  finished_at: fc.constant(null),
});

/**
 * AgentEvent with a controllable `seq`. Covers message, tool_call, plan_step,
 * error, and done variants — the ones the timeline/ingest logic branches on.
 */
export const arbAgentEvent = (sessionId = "s"): fc.Arbitrary<AgentEvent> =>
  fc.oneof(
    fc.record({
      type: fc.constant("message" as const),
      session_id: fc.constant(sessionId),
      seq: fc.nat({ max: 1000 }),
      at: arbIsoDate,
      message: arbMessage,
    }),
    fc.record({
      type: fc.constant("tool_call" as const),
      session_id: fc.constant(sessionId),
      seq: fc.nat({ max: 1000 }),
      at: arbIsoDate,
      tool_call: arbToolCall,
    }),
    fc.record({
      type: fc.constant("plan_step" as const),
      session_id: fc.constant(sessionId),
      seq: fc.nat({ max: 1000 }),
      at: arbIsoDate,
      step: arbPlanStep,
    }),
    fc.record({
      type: fc.constant("error" as const),
      session_id: fc.constant(sessionId),
      seq: fc.nat({ max: 1000 }),
      at: arbIsoDate,
      message: fc.string({ maxLength: 30 }),
      detail: fc.option(fc.string({ maxLength: 30 }), { nil: null }),
    }),
    fc.record({
      type: fc.constant("done" as const),
      session_id: fc.constant(sessionId),
      seq: fc.nat({ max: 1000 }),
      at: arbIsoDate,
      ok: fc.boolean(),
      summary: fc.option(fc.string({ maxLength: 30 }), { nil: null }),
    }),
  ) as fc.Arbitrary<AgentEvent>;

export const arbCheckpoint: fc.Arbitrary<ReplitCheckpoint> = fc.record({
  id: arbId,
  session_id: fc.constant("s"),
  task_id: fc.constant(null),
  label: fc.string({ maxLength: 20 }),
  snapshot_path: fc.string({ maxLength: 20 }),
  files: fc.array(fc.string({ maxLength: 12 }), { maxLength: 4 }),
  created_at: arbIsoDate,
});

/**
 * A minimal but well-formed unified diff string with a controllable number of
 * added/removed/context lines so review-summary aggregation can be checked.
 */
export const arbUnifiedDiff: fc.Arbitrary<{
  diff: string;
  adds: number;
  dels: number;
}> = fc
  .record({
    adds: fc.nat({ max: 6 }),
    dels: fc.nat({ max: 6 }),
    ctx: fc.nat({ max: 4 }),
  })
  .map(({ adds, dels, ctx }) => {
    const lines: string[] = ["@@ -1,1 +1,1 @@"];
    for (let i = 0; i < ctx; i++) lines.push(` ctx${i}`);
    for (let i = 0; i < dels; i++) lines.push(`-old${i}`);
    for (let i = 0; i < adds; i++) lines.push(`+new${i}`);
    return { diff: lines.join("\n"), adds, dels };
  });

export const arbDiffPatch: fc.Arbitrary<DiffPatch & { _adds: number; _dels: number }> =
  fc.tuple(arbId, fc.string({ minLength: 1, maxLength: 16 }), arbUnifiedDiff).map(
    ([id, file, d]) => ({
      id,
      file_path: file,
      unified_diff: d.diff,
      summary: null,
      _adds: d.adds,
      _dels: d.dels,
    }),
  );

/** A set of patches with unique ids — for apply/undo isolation properties. */
export const arbPatchesUniqueIds: fc.Arbitrary<
  Array<DiffPatch & { _adds: number; _dels: number }>
> = fc
  .uniqueArray(arbId, { minLength: 1, maxLength: 8 })
  .chain((ids) =>
    fc.tuple(...ids.map((id) => arbDiffPatch.map((p) => ({ ...p, id })))),
  )
  .map((arr) => arr as Array<DiffPatch & { _adds: number; _dels: number }>);
