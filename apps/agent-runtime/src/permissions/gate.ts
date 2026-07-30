/**
 * The server-held permission gate — zoc-agent-chat-rebuild R11.2–R11.7, R11.9,
 * R11.11, R32.5, R32.7–R32.9, R32.12.
 *
 * ## Two gates, composed in one direction only
 *
 * `gated()` consults the **Capability_Policy first** and its refusals are
 * terminal. Table B — the Permission_Mode matrix — is reached only for a
 * `(kind, mode)` pair the Capability_Policy has already permitted.
 *
 * That order is the whole of R11.11, and inverting it is Amendment 1's worst
 * failure mode: evaluating permission first would raise an approval request for
 * something that can never be approved — a dialog whose only correct answer is
 * "you cannot", which is worse than a refusal because it implies the opposite.
 * So a capability-refused call **never becomes an approval prompt**, and a test
 * asserts the absence of the `PermissionRequestPart` rather than trusting it.
 *
 * ## The deferred lives *inside* `execute`
 *
 * Both gates await a promise inside the tool's `execute` rather than ending the
 * agent invocation and resuming it. The agent invocation never ends, so one Run
 * stays one stream with one `seq` space — and Plan_Approval allocates no second
 * Run identifier (R32.9). The AI SDK's native `needsApproval` would have ended
 * the loop and required a new message to resume it, which would have split one
 * user turn across two Runs.
 */

import type { Capability, ToolKind } from "@zoc-studio/shared-types";

import { capabilityOf, checkCapability, type CapabilityDecision } from "./capability-policy.ts";
import { detectDestructiveIntent } from "./destructive-intent.ts";
import {
  evaluatePermission,
  type ActionRequest,
  type Decision,
  type PermissionConfig,
} from "./engine.ts";

/** How long an approval request stays open before the call is cancelled (R11.9). */
export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

export type PermissionMode = "ask" | "auto" | "deny";

export type GrantScope = "call" | "run" | "workspace";

export type ForcedReason = "out-of-plan-path" | "destructive";

export type ApprovalReason = "mode-ask" | ForcedReason;

export interface ApprovalOutcome {
  readonly decision: "approve" | "reject" | "timeout";
  readonly scope: GrantScope;
}

/** What the gate needs to emit. Supplied by the stream writer (task 9.1). */
export interface GateWriter {
  /** A Capability_Policy refusal. Does not end the Run (R32.12). */
  modeRefusal(toolName: string, code: string, message: string): void;
  /** A Table B refusal. Does not end the Run (R11.4). */
  toolRefusal(toolName: string, reason: string): void;
  /** An approval request the surface renders in the dock. */
  approvalRequest(request: {
    requestId: string;
    toolName: string;
    kind: ToolKind;
    reason: ApprovalReason;
    paths: readonly string[];
    offeredScopes: readonly GrantScope[];
    expiresAt: string;
  }): void;
  approvalTimeout(toolName: string): void;
  /** `run-lifecycle{state:"awaiting-approval"}` for the plan gate (R32.8). */
  awaitingApproval(planId: string): void;
}

/** The pending-approval registry the HTTP approval route resolves against. */
export interface ApprovalBroker {
  /** Open a request and await its decision or the deadline. */
  request(input: {
    requestId: string;
    toolName: string;
    kind: ToolKind;
    reason: ApprovalReason;
    paths: readonly string[];
    offeredScopes: readonly GrantScope[];
    timeoutMs: number;
  }): Promise<ApprovalOutcome>;
}

/** Standing grants recorded from an earlier "this Run" / "this workspace" scope. */
export interface GrantLedger {
  covers(request: ActionRequest): boolean;
  record(request: ActionRequest, scope: GrantScope): void;
}

export interface AuditLog {
  record(request: ActionRequest, decision: Decision, runId: string): void;
}

/** Run-scoped facts the gate reads. Never module state. */
export interface GateContext {
  readonly runId: string;
  /** The Conversation_Mode this Run was submitted in. Immutable (R7.11). */
  readonly mode: "ask" | "plan" | "agent";
  readonly permissionMode: PermissionMode;
  readonly policy: PermissionConfig;
  readonly workspaceRoot: string | null;
  /**
   * Plan_Approval for this Run (R32.9). Starts unapproved, transitions at most
   * once, and is scoped to the Run: never persisted, never inherited by a later
   * Run in the same Session.
   */
  planApproval: { approved: boolean; planId: string | null; approvedAt: string | null };
  /** Paths the approved plan declared. An out-of-plan write forces a prompt. */
  readonly planPaths: ReadonlySet<string>;
  readonly writer: GateWriter;
  readonly broker: ApprovalBroker;
  readonly grants: GrantLedger;
  readonly audit: AuditLog;
  /** Injected so the timeout is testable without waiting ten minutes. */
  readonly approvalTimeoutMs?: number;
  readonly now?: () => Date;
  readonly newRequestId?: () => string;
}

/** The shape a refused tool call returns to the model. */
export interface Refusal {
  readonly ok: false;
  readonly refused: true;
  readonly tool: string;
  readonly code: string;
  readonly message: string;
  /** Always false: a refusal is a decision, not a transient failure. */
  readonly retryable: false;
}

function refusal(tool: string, code: string, message: string): Refusal {
  return { ok: false, refused: true, tool, code, message, retryable: false };
}

/** Normalise a path for plan-membership comparison. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Commands that rewrite VCS history. Always force a prompt (R11.6). */
const VCS_HISTORY_REWRITES: readonly RegExp[] = [
  /\bgit\s+push\b[^\n]*(--force|-f)\b/i,
  /\bgit\s+reset\b[^\n]*--hard\b/i,
  /\bgit\s+rebase\b/i,
  /\bgit\s+filter-branch\b/i,
  /\bgit\s+filter-repo\b/i,
  /\bgit\s+commit\b[^\n]*--amend\b/i,
];

export function rewritesVcsHistory(command: string): boolean {
  return VCS_HISTORY_REWRITES.some((pattern) => pattern.test(command));
}

/** Describe a tool call as an `ActionRequest` the engine can evaluate. */
export function describeAction(
  kind: ToolKind,
  toolName: string,
  input: unknown,
): ActionRequest & { readonly paths: readonly string[] } {
  const args = (input ?? {}) as Record<string, unknown>;
  const paths = extractPaths(args);
  const command = typeof args.command === "string" ? args.command : toolName;
  const fullCommand = Array.isArray(args.args)
    ? `${command} ${(args.args as unknown[]).map(String).join(" ")}`
    : command;

  const destructive =
    kind === "write"
      ? paths.length === 0
        ? false
        : declaredDeletion(args)
      : kind === "execute"
        ? detectDestructiveIntent(fullCommand).destructive || rewritesVcsHistory(fullCommand)
        : false;

  return {
    kind: actionKindFor(kind),
    name: kind === "execute" ? fullCommand : toolName,
    ...(paths[0] !== undefined ? { target: paths[0] } : {}),
    destructive,
    readOnly: kind === "read" || kind === "search",
    network: kind === "network",
    sandboxable: kind === "execute",
    paths,
  };
}

function declaredDeletion(args: Record<string, unknown>): boolean {
  const files = Array.isArray(args.files) ? args.files : [];
  return files.some((file) => (file as { action?: string } | null)?.action === "delete");
}

function actionKindFor(kind: ToolKind): ActionRequest["kind"] {
  switch (kind) {
    case "write":
      return "fs";
    case "execute":
      return "terminal";
    case "mcp":
      return "mcp";
    default:
      return "agent_tool";
  }
}

function extractPaths(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  if (typeof args.path === "string") paths.push(args.path);
  if (Array.isArray(args.files)) {
    for (const file of args.files) {
      const entry = file as { path?: unknown; sourcePath?: unknown } | null;
      if (typeof entry?.path === "string") paths.push(entry.path);
      if (typeof entry?.sourcePath === "string") paths.push(entry.sourcePath);
    }
  }
  if (typeof args.cwd === "string") paths.push(args.cwd);
  return paths;
}

/**
 * The real forced-approval check, over the whole described request.
 *
 * Separate from `describeAction` because it needs every path the call touches,
 * not just the first one: a batch that writes eight in-plan files and one
 * out-of-plan file must prompt, and checking only `target` would miss it.
 */
export function forcedApprovalReasonFor(
  request: ActionRequest & { paths: readonly string[] },
  kind: ToolKind,
  ctx: Pick<GateContext, "planPaths">,
): ForcedReason | null {
  if (kind === "write") {
    const outOfPlan = request.paths.some((path) => !ctx.planPaths.has(normalizePath(path)));
    // R11.5. An empty plan-path set means no plan was declared, so every write
    // is out of plan — which is the correct reading, not an edge case: a write
    // with no reviewed plan behind it is exactly what must prompt.
    if (outOfPlan) return "out-of-plan-path";
  }
  if (request.destructive === true) return "destructive";
  if (kind === "execute" && detectDestructiveIntent(request.name).destructive) {
    return "destructive";
  }
  if (kind === "execute" && rewritesVcsHistory(request.name)) return "destructive";
  return null;
}

export function offeredScopesFor(kind: ToolKind): readonly GrantScope[] {
  // A workspace-wide grant for a destructive command is a footgun, so the
  // broadest scope is withheld for `execute` rather than offered and regretted.
  return kind === "execute" ? ["call", "run"] : ["call", "run", "workspace"];
}

/**
 * Wrap a tool's `execute` in both gates.
 *
 * Returns a function with the same signature, so the registry stays free of
 * policy and the tool definition does not change shape.
 */
export function createGate(ctx: GateContext) {
  const now = ctx.now ?? (() => new Date());
  const timeoutMs = ctx.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS;
  let requestCounter = 0;
  const newRequestId = ctx.newRequestId ?? (() => `req_${ctx.runId}_${(requestCounter += 1)}`);

  return function gated<A, R>(
    toolName: string,
    kind: ToolKind,
    execute: (args: A) => Promise<R>,
    declared?: { userDeclaredCapability?: Capability; providerExecuted?: boolean },
  ): (args: A) => Promise<R> {
    return async function gatedExecute(args: A): Promise<R> {
      const request = describeAction(kind, toolName, args);

      // ── Gate 1: Capability_Policy (R11.11, R32.12) ────────────────────
      const capability = capabilityOf(kind, declared);
      const verdict: CapabilityDecision = checkCapability(
        ctx.mode,
        ctx.planApproval.approved,
        capability,
      );
      if (!verdict.permitted) {
        const code = verdict.code as string;
        const message = verdict.message as string;
        ctx.writer.modeRefusal(toolName, code, message);
        ctx.audit.record(request, { effect: "deny", reason: code }, ctx.runId);
        // Terminal. Table B is never consulted, so no approval prompt is raised
        // for something that cannot be approved.
        return refusal(toolName, code, message) as unknown as R;
      }

      // ── Gate 2: Permission_Mode, over what gate 1 permitted ───────────
      const forced = forcedApprovalReasonFor(request, kind, ctx);
      const decision: Decision =
        ctx.permissionMode === "deny" && request.readOnly !== true
          ? { effect: "deny", reason: "Permission mode is set to deny." }
          : forced !== null
            ? { effect: "prompt", reason: forced }
            : ctx.permissionMode === "auto"
              ? { effect: "allow", reason: "Permission mode is set to auto." }
              : evaluatePermission(ctx.policy, request, ctx.workspaceRoot);

      if (decision.effect === "deny") {
        // R11.4: names the blocked tool and does not end the Run.
        ctx.writer.toolRefusal(toolName, decision.reason);
        ctx.audit.record(request, decision, ctx.runId);
        return refusal(toolName, "permission_denied", decision.reason) as unknown as R;
      }

      if (decision.effect === "prompt" && !ctx.grants.covers(request)) {
        const requestId = newRequestId();
        const expiresAt = new Date(now().getTime() + timeoutMs).toISOString();
        const reason: ApprovalReason = forced ?? "mode-ask";
        const offeredScopes = offeredScopesFor(kind);

        ctx.writer.approvalRequest({
          requestId,
          toolName,
          kind,
          reason,
          paths: request.paths,
          offeredScopes,
          expiresAt,
        });

        const outcome = await ctx.broker.request({
          requestId,
          toolName,
          kind,
          reason,
          paths: request.paths,
          offeredScopes,
          timeoutMs,
        });

        if (outcome.decision === "timeout") {
          ctx.writer.approvalTimeout(toolName);
          ctx.audit.record(request, { effect: "deny", reason: "approval timed out" }, ctx.runId);
          return refusal(
            toolName,
            "permission_timeout",
            "The approval request timed out, so the action was cancelled.",
          ) as unknown as R;
        }
        if (outcome.decision === "reject") {
          ctx.audit.record(request, { effect: "deny", reason: "rejected by the user" }, ctx.runId);
          return refusal(
            toolName,
            "permission_denied",
            "You declined this action.",
          ) as unknown as R;
        }
        // R11.7: record the grant at exactly the scope the user chose.
        ctx.grants.record(request, outcome.scope);
      }

      ctx.audit.record(request, decision, ctx.runId);
      return execute(args);
    };
  };
}

export type Gated = ReturnType<typeof createGate>;

/**
 * A simple in-memory grant ledger scoped to one Run (R11.7).
 *
 * `call` scope records nothing — it covers exactly the call that was approved,
 * and that call is already proceeding. Recording it would make the *next*
 * identical call skip its prompt, which is the `run` scope the user did not pick.
 */
export function createGrantLedger(): GrantLedger {
  const runGrants = new Set<string>();
  const workspaceGrants = new Set<string>();

  const keyFor = (request: ActionRequest) => `${request.kind}:${request.name}`;

  return {
    covers(request) {
      const key = keyFor(request);
      return runGrants.has(key) || workspaceGrants.has(key);
    },
    record(request, scope) {
      if (scope === "call") return;
      const key = keyFor(request);
      if (scope === "run") runGrants.add(key);
      else workspaceGrants.add(key);
    },
  };
}

/**
 * A bounded audit log, matching the 500-entry ceiling the `lib` original keeps.
 */
export function createAuditLog(limit = 500): AuditLog & {
  entries(): ReadonlyArray<{
    at: string;
    runId: string;
    kind: string;
    name: string;
    effect: string;
    reason: string;
  }>;
} {
  const entries: Array<{
    at: string;
    runId: string;
    kind: string;
    name: string;
    effect: string;
    reason: string;
  }> = [];
  return {
    record(request, decision, runId) {
      entries.push({
        at: new Date().toISOString(),
        runId,
        kind: request.kind,
        name: request.name,
        effect: decision.effect,
        reason: decision.reason,
      });
      if (entries.length > limit) entries.splice(0, entries.length - limit);
    },
    entries: () => entries,
  };
}
