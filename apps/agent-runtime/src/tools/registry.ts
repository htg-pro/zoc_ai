/**
 * Tool registry — zoc-agent-chat-rebuild R5.3, R9.4, R10.10, R10.16, R11.3, R26.2.
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
 */

import { tool, type Tool } from "ai";
import { z } from "zod";
import type { ToolKind } from "@zoc-studio/shared-types";

import type { WorkspaceClient, WorkspaceOutcome } from "./workspace-client.ts";

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
  /** Null for `declare_complete`, which has no `execute` at all. */
  readonly tool: Tool | null;
}

/** What the tool implementations need. Passed in, never module state. */
export interface ToolContext {
  readonly workspace: WorkspaceClient;
  readonly sessionId: string;
  /**
   * Wrap a tool's `execute` in the permission gate. Supplied by task 8.3; the
   * registry takes it as a function so the registry itself stays free of policy.
   */
  readonly gated: <A, R>(
    name: string,
    kind: ToolKind,
    execute: (args: A) => Promise<R>,
  ) => (args: A) => Promise<R>;
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
  .refine(
    (file) => (file.action === "rename") === (file.sourcePath != null),
    { message: "sourcePath is required for a rename and forbidden otherwise" },
  );

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
      name: "propose_plan",
      kind: "read",
      description:
        "Propose a multi-file change plan before writing anything. Every file " +
        "you intend to change must appear here first.",
      tool: null, // Supplied by tools/plan.ts, which owns the plan part writer.
    },
    {
      name: COMPLETION_TOOL,
      kind: "read",
      description:
        "Declare the task complete. Call this when there is nothing left to do; " +
        "it ends the run.",
      // No `execute` at all — that absence *is* the terminal signal, which
      // `hasToolCall(COMPLETION_TOOL)` in `stopWhen` detects.
      tool: null,
    },
  ];

  assertRegistryIsWellFormed(descriptors);
  return descriptors;
}

/**
 * Refuse a malformed registry at construction.
 *
 * The collision check lands now rather than with M2's MCP insertion, so
 * registering an MCP server later is an insertion rather than a naming migration
 * (R26.2).
 */
export function assertRegistryIsWellFormed(
  descriptors: readonly ToolDescriptor[],
): void {
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
}

/** The tool map `ToolLoopAgent` takes, with the null-tool entries omitted. */
export function toToolMap(
  descriptors: readonly ToolDescriptor[],
): Record<string, Tool> {
  const map: Record<string, Tool> = {};
  for (const descriptor of descriptors) {
    if (descriptor.tool !== null) map[descriptor.name] = descriptor.tool;
  }
  return map;
}

/** Kind lookup for the permission gate. */
export function kindOf(
  descriptors: readonly ToolDescriptor[],
  name: string,
): ToolKind | null {
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
    gated: descriptor.kind !== "read" && descriptor.kind !== "search",
  }));
}
