/**
 * Tool registry — zoc-agent-chat-rebuild R5.3, R9.4, R10.10, R10.16, R11.3, R26.2.
 *
 * Feature: zoc-agent-chat-rebuild, R5.3, R9.4, R10.10, R10.16, R11.3, R26.2.
 *
 * Every tool is a `tool()` with a `zod` input schema and a `kind` tag. The tag is
 * what the permission gate reads: `read` and `search` are never gated; `write`,
 * `execute`, `network`, and `mcp` always are.
 *
 * ## There is no `write_file` and no `delete_file`, deliberately
 *
 * R10.16 asks for exactly this, and the reason is arithmetic. One gated mutation
 * path means **one** place the permission gate, the out-of-plan-path check, and
 * the checkpoint contract are enforced. Two more tools would mean three places —
 * and the two extra ones would be precisely the ones that skip the per-hunk
 * review R10.2 and R10.3 exist to guarantee.
 *
 * This declines part of what a reader of the tool list would reasonably expect,
 * and the decline is the point. A direct write tool is the obvious convenience:
 * one call instead of propose-then-review-then-apply. It would also silently void
 * the safety property — the moment one unreviewed path to the filesystem exists,
 * "nothing touches your files without your seeing it first" stops being true, and
 * gating the *other* path does not restore it. Permission_Mode does not close the
 * hole either, because `auto` exists precisely so that permitted writes proceed
 * without a prompt; an unreviewed write in `auto` is an unreviewed write.
 *
 * The cost is real and accepted: a one-line file creation costs the model a plan,
 * and every mutation must be expressed as hunks even when the whole file is one
 * hunk. That is why `create` and `delete` have single-whole-file hunk shapes —
 * they exist so the hunks-only path is expressible for all four actions.
 *
 * A reader who finds the model wanting a direct write should add the case to the
 * hunk vocabulary, not a second tool.
 *
 * ## The registry is shaped by Conversation_Mode, not filtered by it (R32.5)
 *
 * Ask mode's registry is *built* without the effectful tools. Filtering a full
 * registry afterwards would reach the same tool map by a route that has already
 * called `ctx.gated` for tools the mode does not offer — building a gated closure
 * for a tool the model cannot see is at best waste and at worst a live mutation
 * path one refactor away from being reachable. `propose_plan` goes too
 * (design.md:1536): a mode with no way to apply a plan should not invite one.
 *
 * `declare_complete` is in every mode (design.md:1538) because every mode has to
 * be able to end.
 */

import { tool, type Tool } from "ai";
import { z } from "zod";
import type { Capability, ConversationMode, ToolKind } from "@zoc-studio/shared-types";

import { PLAN_TOOL } from "./plan.ts";
import type { WorkspaceClient, WorkspaceOutcome } from "./workspace-client.ts";
import type { McpToolView } from "../mcp/control.ts";

export { PLAN_TOOL };

/** The single tool that mutates the workspace (R10.16). */
export const MUTATION_TOOL = "workspace_apply_hunks";

/** The loop's terminal signal. Carries no `execute` (R11.3). */
export const COMPLETION_TOOL = "declare_complete";

/** Tools that must never exist. Asserted by the registry guard. */
export const FORBIDDEN_TOOL_NAMES: readonly string[] = ["write_file", "delete_file"];

/** Namespace reserved for M2's MCP tools (R26.2). */
export const MCP_PREFIX = "mcp__";

export interface ToolDescriptor {
  readonly name: string;
  readonly kind: ToolKind;
  readonly description: string;
  /**
   * Null only when the Run has not supplied `propose_plan`'s implementation —
   * every other descriptor carries a real `tool()`. `declare_complete` carries
   * one too: a tool with no `execute` (R11.3), which is a different thing from no
   * tool at all. A null here is invisible to the model, and the loop's terminal
   * signal has to be *callable* for `hasToolCall` to ever fire.
   */
  readonly tool: Tool | null;
  /** Effective capability, used for read-only MCP declarations. */
  readonly capability?: Capability;
}

/** What the tool implementations need. Passed in, never module state. */
export interface ToolContext {
  readonly workspace: WorkspaceClient;
  readonly sessionId: string;
  /**
   * The Run these tools belong to, so an apply's checkpoint identifies it (R10.5).
   *
   * Optional because the catalogue route builds a registry with no Run behind it — it
   * needs the descriptors, not callable tools — and a required field there would be a
   * fabricated id in the one place that has none.
   */
  readonly runId?: string;
  /** Which registry to build. Ask mode gets the read-only one (R32.5). */
  readonly mode: ConversationMode;
  /**
   * `propose_plan`'s implementation, from `tools/plan.ts`.
   *
   * Injected rather than constructed here because its `execute` writes a
   * Message_Part and awaits the plan gate — a writer and an approval broker this
   * module deliberately does not know about. Omitted, the descriptor is still
   * listed for `GET /v1/tools` but carries no callable tool.
   */
  readonly proposePlan?: Tool | null;
  /**
   * Wrap a tool's `execute` in the permission gate. Supplied by task 8.3; the
   * registry takes it as a function so the registry itself stays free of policy.
   */
  readonly gated: <A, R>(
    name: string,
    kind: ToolKind,
    execute: (args: A) => Promise<R>,
    declared?: { readonly userDeclaredCapability?: Capability },
  ) => (args: A) => Promise<R>;
  /** Connected MCP tools, fetched from Workspace_Services for this Run. */
  readonly mcpTools?: readonly McpToolView[];
  /** Provider-defined tools already authorised for this Run. */
  readonly providerTools?: readonly ToolDescriptor[];
}

/**
 * Render a `WorkspaceOutcome` as a tool result.
 *
 * A failure becomes a *result*, not a throw (R6.6). The model sees `ok: false`
 * with `retryable`, which is information it can act on; a thrown exception would
 * end the Run and tell it nothing.
 */
function asToolResult<T>(outcome: WorkspaceOutcome<T>): Record<string, unknown> {
  if (outcome.ok) return { ok: true, ...(outcome.value as Record<string, unknown>) };
  return {
    ok: false,
    code: outcome.code,
    message: outcome.message,
    retryable: outcome.retryable,
  };
}

const hunkActionSchema = z.enum(["create", "modify", "delete", "rename"]);

/** One file's change. Kept as a named shape so `z.infer` survives `.refine()`. */
const hunkFileShape = z
  .object({
    path: z
      .string()
      .min(1)
      .describe("Workspace-relative path this change produces. For a rename, the target."),
    action: hunkActionSchema.describe(
      "create: a hunk against a non-existent file. delete: a hunk removing every " +
        "line. rename: carries sourcePath. modify: an ordinary hunk set.",
    ),
    sourcePath: z
      .string()
      .nullable()
      .optional()
      .describe("Required for a rename, forbidden otherwise: the path the file moves from."),
    unifiedDiff: z
      .string()
      .default("")
      .describe("Unified diff for this file. Empty only for a pure rename."),
    baseDigest: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Digest of the file the diff was generated against, from workspace_read. " +
          "A mismatch refuses the apply rather than clobbering a changed file.",
      ),
  })
  .refine((file) => (file.action === "rename") === (file.sourcePath != null), {
    message: "sourcePath is required for a rename and forbidden otherwise",
  });

const hunkFileSchema = hunkFileShape;

type HunkFileInput = z.infer<typeof hunkFileShape>;

/**
 * Build the tool registry for one Run.
 *
 * Per-Run rather than a module singleton, because every `execute` closes over the
 * Run's gate and workspace client — Run-scoped facts a shared instance would have
 * to thread through every call by hand.
 */
export function buildToolDescriptors(ctx: ToolContext): readonly ToolDescriptor[] {
  const descriptors: ToolDescriptor[] = [
    {
      name: "workspace_read",
      kind: "read",
      description:
        "Read one workspace file. Returns its content and a digest to pass back " +
        "as baseDigest when proposing changes to it.",
      tool: tool({
        description: "Read one workspace file.",
        inputSchema: z.object({
          path: z.string().min(1).describe("Workspace-relative path."),
        }),
        // `read` is never gated (R11.3), so it is not wrapped.
        execute: async ({ path }) => asToolResult(await ctx.workspace.read(path)),
      }),
    },
    {
      name: "workspace_search_context",
      kind: "search",
      description:
        "Semantic search over the workspace index. Mutates nothing; use it to " +
        "find the files a change should touch before reading them.",
      tool: tool({
        description: "Search the workspace index semantically.",
        inputSchema: z.object({
          query: z.string().min(1),
          limit: z.number().int().min(1).max(50).default(12),
        }),
        execute: async ({ query, limit }) =>
          asToolResult(await ctx.workspace.contextSearch(ctx.sessionId, query, limit)),
      }),
    },
  ];

  // Built, not filtered: see the header. `declare_complete` last, so it reads as
  // the terminal entry it is.
  if (ctx.mode !== "ask") descriptors.push(...effectfulDescriptors(ctx));
  descriptors.push(...mcpDescriptors(ctx));
  descriptors.push(...(ctx.providerTools ?? []));
  descriptors.push(completionDescriptor());

  assertRegistryIsWellFormed(descriptors);
  if (ctx.mode === "ask") assertReadOnlyRegistry(descriptors);
  return descriptors;
}

/**
 * Build MCP tools only from the enabled set. In Ask mode a tool marked read-only by
 * the user is safe to offer; execute-default tools are omitted before the model sees
 * them, matching the registration-time construction used by built-ins (R26.3/R26.5).
 */
export function mcpDescriptors(ctx: ToolContext): ToolDescriptor[] {
  return (ctx.mcpTools ?? [])
    .filter((entry) => entry.enabled)
    .filter((entry) => ctx.mode !== "ask" || entry.capability === "read")
    .map((entry) => {
      const capability: Capability = entry.capability === "read" ? "read" : "execute";
      return {
        name: entry.name,
        kind: "mcp" as const,
        capability,
        description:
          entry.description ?? `Call the ${entry.bareName} tool on MCP server ${entry.serverId}.`,
        tool: tool({
          description: entry.description ?? `Call ${entry.bareName} on ${entry.serverId}.`,
          inputSchema: z.record(z.string(), z.unknown()),
          execute: ctx.gated(
            entry.name,
            "mcp",
            async (args: Record<string, unknown>) =>
              asToolResult(await ctx.workspace.callMcp(entry.sourceName, args)),
            { userDeclaredCapability: capability },
          ),
        }),
      } satisfies ToolDescriptor;
    });
}

/**
 * The tools Ask mode does not get: the mutation path, the two execute tools, and
 * the plan.
 *
 * A function rather than a branch inside the array literal so that in Ask mode
 * none of these `tool()` calls happens at all — `ctx.gated` is never invoked for
 * a tool the model will not see.
 */
function effectfulDescriptors(ctx: ToolContext): ToolDescriptor[] {
  return [
    {
      // The one and only mutation path.
      name: MUTATION_TOOL,
      kind: "write",
      description:
        "Apply a reviewed set of file changes as hunks. This is the only way to " +
        "change a file: creates, modifications, deletions, and renames all go " +
        "through it. Every call is checkpointed so it can be rolled back.",
      tool: tool({
        description: "Apply a batch of file changes as hunks.",
        inputSchema: z.object({
          planId: z.string().min(1).describe("The plan these changes belong to."),
          files: z.array(hunkFileSchema).min(1).max(64),
        }),
        execute: ctx.gated(MUTATION_TOOL, "write", async ({ planId, files }) =>
          asToolResult(
            await ctx.workspace.applyHunks({
              planId,
              ...(ctx.runId === undefined ? {} : { runId: ctx.runId }),
              files: files.map((file: HunkFileInput) => ({
                path: file.path,
                action: file.action,
                sourcePath: file.sourcePath ?? null,
                unifiedDiff: file.unifiedDiff,
                baseDigest: file.baseDigest ?? null,
              })),
            }),
          ),
        ),
      }),
    },
    {
      name: "workspace_run_command",
      kind: "execute",
      description:
        "Run a command in the workspace root. Output is captured and returned; " +
        "the command is killed if it exceeds its timeout.",
      tool: tool({
        description: "Run a command in the workspace.",
        inputSchema: z.object({
          command: z.string().min(1),
          args: z.array(z.string()).default([]),
          cwd: z.string().nullable().optional(),
          timeoutMs: z.number().int().min(1_000).max(600_000).default(120_000),
        }),
        execute: ctx.gated("workspace_run_command", "execute", async (args) =>
          asToolResult(
            await ctx.workspace.runCommand({
              command: args.command,
              args: args.args,
              cwd: args.cwd ?? null,
              timeoutMs: args.timeoutMs,
            }),
          ),
        ),
      }),
    },
    {
      name: "workspace_run_tests",
      kind: "execute",
      description:
        "Run the project's test command and report whether it passed. Use it to " +
        "verify a change rather than asserting the change is correct.",
      tool: tool({
        description: "Run the project's tests.",
        inputSchema: z.object({
          command: z.string().min(1).describe("The full test command, e.g. 'pnpm'."),
          args: z.array(z.string()).default(["test"]),
          timeoutMs: z.number().int().min(1_000).max(900_000).default(600_000),
        }),
        execute: ctx.gated("workspace_run_tests", "execute", async (args) =>
          asToolResult(
            await ctx.workspace.runCommand({
              command: args.command,
              args: args.args,
              timeoutMs: args.timeoutMs,
            }),
          ),
        ),
      }),
    },
    {
      // Read-class: it emits a Message_Part and touches nothing (R32.11).
      name: PLAN_TOOL,
      kind: "read",
      description:
        "Propose a multi-file change plan before writing anything. Every file " +
        "you intend to change must appear here first.",
      // Owned by tools/plan.ts, which owns the plan part writer and the gate.
      tool: ctx.proposePlan ?? null,
    },
  ];
}

/**
 * The loop's terminal signal — a tool with an input schema and no `execute`.
 *
 * The absence of `execute` is what makes it terminal: the SDK has nothing to run,
 * so the step ends with the call unresolved and `hasToolCall(COMPLETION_TOOL)` in
 * `stopWhen` fires. It has to be a real entry in the tool map for any of that to
 * happen — a descriptor with `tool: null` is a tool the model is never told about,
 * and a terminal signal the model cannot send is a loop that only ever stops at
 * `stepCountIs`.
 *
 * `summary` is required because the value of this call is the summary. Without it
 * the loop's last act would carry no account of what it did.
 */
function completionDescriptor(): ToolDescriptor {
  return {
    name: COMPLETION_TOOL,
    kind: "read",
    description:
      "Declare the task complete. Call this when there is nothing left to do; " +
      "it ends the run.",
    tool: tool({
      description: "Declare the task complete. This ends the run.",
      inputSchema: z.object({
        summary: z
          .string()
          .min(1)
          .describe("One or two sentences on what changed and how it was verified."),
      }),
      // No `execute`, deliberately. See this function's doc comment.
    }),
  };
}

/**
 * Refuse a malformed registry at construction.
 *
 * The collision check lands now rather than with M2's MCP insertion, so
 * registering an MCP server later is an insertion rather than a naming migration
 * (R26.2).
 */
export function assertRegistryIsWellFormed(descriptors: readonly ToolDescriptor[]): void {
  const seen = new Set<string>();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.name)) {
      throw new Error(`tool name collision: ${descriptor.name}`);
    }
    seen.add(descriptor.name);

    if (FORBIDDEN_TOOL_NAMES.includes(descriptor.name)) {
      throw new Error(
        `${descriptor.name} is forbidden by R10.16: ${MUTATION_TOOL} is the single ` +
          "gated mutation path. Add the case to the hunk vocabulary instead.",
      );
    }

    if (descriptor.kind === "write" && descriptor.name !== MUTATION_TOOL) {
      throw new Error(
        `${descriptor.name} is tagged write but is not ${MUTATION_TOOL}. R10.16 ` +
          "permits exactly one mutation path.",
      );
    }
  }

  // Every mode can end (design.md:1538), and the signal must be callable and
  // unexecutable — the two halves of R11.3 that a `tool: null` would each break.
  const completion = descriptors.find((descriptor) => descriptor.name === COMPLETION_TOOL);
  if (completion === undefined) {
    throw new Error(`${COMPLETION_TOOL} is missing: no mode may lack a way to end.`);
  }
  if (completion.tool === null) {
    throw new Error(
      `${COMPLETION_TOOL} carries no tool, so the model is never told about it and ` +
        "hasToolCall can never fire. R11.3 wants a tool with no execute, not no tool.",
    );
  }
  if (completion.tool.execute !== undefined) {
    throw new Error(
      `${COMPLETION_TOOL} has an execute. R11.3 makes its absence the terminal ` +
        "signal; an execute would resolve the call and let the loop continue.",
    );
  }
}

/**
 * Refuse an Ask-mode registry that can reach the workspace (R32.5).
 *
 * Asserted rather than trusted, because the property that matters here is not
 * "the builder currently omits these" but "no Ask-mode Run can be handed a
 * mutation path". A future tool added to the wrong list fails at construction.
 */
export function assertReadOnlyRegistry(descriptors: readonly ToolDescriptor[]): void {
  for (const descriptor of descriptors) {
    if (descriptor.kind !== "read" && descriptor.kind !== "search") {
      if (descriptor.capability === "read") continue;
      throw new Error(
        `${descriptor.name} is tagged ${descriptor.kind} but Ask mode's registry is ` +
          "read-only (R32.5).",
      );
    }
    if (descriptor.name === PLAN_TOOL) {
      throw new Error(
        `${PLAN_TOOL} has no place in Ask mode: a mode that cannot apply a plan ` +
          "should not offer to write one (design.md:1536).",
      );
    }
  }
}

/**
 * The tool map `ToolLoopAgent` takes.
 *
 * A descriptor with no tool is skipped — which after the well-formedness check
 * means only `propose_plan` on a Run that did not supply it. `declare_complete` is
 * always here, with no `execute`.
 */
export function toToolMap(descriptors: readonly ToolDescriptor[]): Record<string, Tool> {
  const map: Record<string, Tool> = {};
  for (const descriptor of descriptors) {
    if (descriptor.tool !== null) map[descriptor.name] = descriptor.tool;
  }
  return map;
}

/** Kind lookup for the permission gate. */
export function kindOf(descriptors: readonly ToolDescriptor[], name: string): ToolKind | null {
  return descriptors.find((descriptor) => descriptor.name === name)?.kind ?? null;
}

/** Public tool list for `GET /v1/tools`. Carries no schema internals. */
export function toolCatalogue(
  descriptors: readonly ToolDescriptor[],
): ReadonlyArray<{ name: string; kind: ToolKind; description: string; gated: boolean }> {
  return descriptors.map((descriptor) => ({
    name: descriptor.name,
    kind: descriptor.kind,
    description: descriptor.description,
    gated:
      descriptor.capability !== "read" &&
      descriptor.kind !== "read" &&
      descriptor.kind !== "search",
  }));
}
