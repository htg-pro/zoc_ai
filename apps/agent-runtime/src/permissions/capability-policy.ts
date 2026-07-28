/**
 * Capability_Policy — zoc-agent-chat-rebuild R11.10, R11.11, R32.3, R32.4,
 * R32.7, R32.9–R32.13.
 *
 * A faithful port of `mode_router.py`'s `Capability` / `Decision` / `PERMISSIONS`.
 *
 * **Pure by construction.** No imports beyond types, no I/O, no clock, no
 * randomness. All eighteen verdicts are a table lookup, which is what lets the
 * whole domain be asserted exhaustively rather than sampled — 18 cells is the
 * entire product, so enumeration is both cheaper and stronger than 100 draws
 * over the same space.
 *
 * **One module, two consumers.** The Agent_Runtime enforces it and the
 * Chat_Surface imports it directly through `@zoc-studio/agent-runtime/policy`
 * rather than keeping a copy. R32.13's tie-breaker stays the contract, but a
 * duplicated policy table is exactly the drift that tie-breaker exists to
 * survive; the renderer pays about a kilobyte for a type alias, a frozen record,
 * and two pure functions.
 */

import type { Capability, ConversationMode, ToolKind } from "@zoc-studio/shared-types";

/** `ErrorCode.MODE_NOT_PERMITTED` verbatim from the Python side. */
export const MODE_NOT_PERMITTED = "mode_not_permitted" as const;

export interface CapabilityDecision {
  readonly permitted: boolean;
  /** Present only on a refusal. */
  readonly code?: typeof MODE_NOT_PERMITTED;
  /**
   * Present only on a refusal. Free of identifiers and filesystem paths: this
   * string is rendered to the user verbatim.
   */
  readonly message?: string;
}

const PERMITTED: CapabilityDecision = Object.freeze({ permitted: true });

/**
 * The key shape: `` `${ConversationMode}:${boolean}:${Capability}` ``.
 *
 * (Conversation_Mode × Plan_Approval × Capability) = 3 × 2 × 3 = **18 cells**.
 */
export type PolicyKey = `${ConversationMode}:${boolean}:${Capability}`;

/**
 * The eighteen cells, written out literally.
 *
 * Written out rather than derived from rules on purpose: the table *is* the
 * specification, and a reviewer can check one cell without simulating a loop.
 * The Python original derives it from a nested loop, which is fine for building
 * a dictionary and poor for being read as a policy.
 *
 * The rules it encodes:
 *   - `read` is always permitted, in every mode, in either approval state.
 *   - `agent` permits all three.
 *   - `plan` permits `write` / `execute` only once the plan is approved.
 *   - `ask` permits neither, in either approval state.
 *
 * The two `ask:true` rows are defined anyway, even though `Ask` never reaches an
 * approval gate and so can never be evaluated with `planApproved = true`. A
 * total table is testable; a partial one needs a story about its holes, and
 * "unreachable" is a claim about the *callers* rather than about this module.
 */
export const PERMISSIONS: Readonly<Record<PolicyKey, boolean>> = Object.freeze({
  // ── ask: read-only, in both approval states (R32.4) ────────────────────
  "ask:false:read": true,
  "ask:false:write": false,
  "ask:false:execute": false,
  "ask:true:read": true,
  "ask:true:write": false,
  "ask:true:execute": false,

  // ── plan: read always; write/execute only after approval (R32.7) ───────
  "plan:false:read": true,
  "plan:false:write": false,
  "plan:false:execute": false,
  "plan:true:read": true,
  "plan:true:write": true,
  "plan:true:execute": true,

  // ── agent: all three, in both approval states (R32.10) ─────────────────
  "agent:false:read": true,
  "agent:false:write": true,
  "agent:false:execute": true,
  "agent:true:read": true,
  "agent:true:write": true,
  "agent:true:execute": true,
} satisfies Record<PolicyKey, boolean>);

function refusalMessage(mode: ConversationMode, capability: Capability): string {
  const what = capability === "write" ? "File changes" : "Commands";
  if (mode === "plan") {
    return `${what} are not available in Plan mode until you approve the plan.`;
  }
  return `${what} are not available in Ask mode. Switch to Agent mode to make changes.`;
}

/**
 * The total capability check.
 *
 * Total in the mathematical sense: every point in the domain has a defined
 * verdict, so there is no path where an absent cell reads as a refusal by
 * falsiness. That distinction matters — a missing cell and a `false` cell would
 * behave identically at runtime and mean completely different things.
 */
export function checkCapability(
  mode: ConversationMode,
  planApproved: boolean,
  capability: Capability,
): CapabilityDecision {
  const key: PolicyKey = `${mode}:${planApproved}:${capability}`;
  if (PERMISSIONS[key]) return PERMITTED;
  return Object.freeze({
    permitted: false,
    code: MODE_NOT_PERMITTED,
    message: refusalMessage(mode, capability),
  });
}

/**
 * The lossy `ToolKind` → `Capability` mapping. Six kinds onto three
 * Capabilities, in one place so it can be read or changed exactly once.
 *
 * Two of the six mappings are decisions rather than translations, and both are
 * worth stating because the obvious reading of each is wrong:
 *
 * - **`search` → `read`.** A local index query mutates nothing. It is a separate
 *   `ToolKind` for the timeline's shape vocabulary — the hollow diamond node —
 *   not for gating.
 *
 * - **`network` splits on who executes the call**, and the split is the whole
 *   reason this function takes a second argument. A *locally executed* network
 *   call takes `execute`, the strictest Capability: classing it as `read` would
 *   let `Ask` mode send workspace content to a third party, which is the one
 *   guarantee `Ask` exists to give and the one effect no checkpoint can roll
 *   back. A **provider-executed** call — provider-native web search — takes
 *   `read`, because it sends nothing the runtime was not already sending to that
 *   provider under that key and reaches no new host. It has no local `execute`
 *   for `gated()` to wrap, so its gate moves to *tool-registration* time rather
 *   than call time.
 *
 * `mcp` is `execute` by default, narrowable to `read` **only** by the user's
 * per-tool declaration from the R26.3 surface and never by server-supplied
 * metadata: a gate that asks the gated party to declare its own capability is
 * not a gate.
 */
export function capabilityOf(
  kind: ToolKind,
  declared?: {
    /** The user's per-tool narrowing for an MCP tool (R26.3). */
    readonly userDeclaredCapability?: Capability;
    /** True when the provider runs the network call inside its own inference. */
    readonly providerExecuted?: boolean;
  },
): Capability {
  switch (kind) {
    case "read":
      return "read";
    case "search":
      return "read";
    case "write":
      return "write";
    case "execute":
      return "execute";
    case "network":
      return declared?.providerExecuted === true ? "read" : "execute";
    case "mcp":
      // Only a *narrowing* is honoured, and only from the user. A declaration
      // that widened the capability would be the gated party granting itself a
      // permission.
      return declared?.userDeclaredCapability === "read" ? "read" : "execute";
  }
}

/**
 * Tools whose Capability is `read` despite not reading anything.
 *
 * `propose_plan` emits a Message_Part; `declare_complete` stops the loop.
 * Neither touches the workspace, and classing them as `read` is what makes
 * R32.11 hold with no special case: in `Agent` mode under Permission_Mode
 * `deny`, plan production is permitted because a plan is `read`-class, so the
 * Run reports the change it *would* make and leaves the workspace unmodified.
 */
export const READ_CLASS_CONTROL_TOOLS: ReadonlySet<string> = new Set([
  "propose_plan",
  "declare_complete",
]);

/** Every key in the table, for the exhaustive guard. */
export function policyKeys(): readonly PolicyKey[] {
  return Object.keys(PERMISSIONS) as PolicyKey[];
}

export const CONVERSATION_MODES: readonly ConversationMode[] = Object.freeze([
  "ask",
  "plan",
  "agent",
]);

export const CAPABILITIES: readonly Capability[] = Object.freeze([
  "read",
  "write",
  "execute",
]);

export const TOOL_KINDS: readonly ToolKind[] = Object.freeze([
  "read",
  "write",
  "execute",
  "search",
  "network",
  "mcp",
]);
