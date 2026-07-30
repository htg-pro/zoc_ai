/**
 * System-instruction assembler — zoc-agent-chat-rebuild R30.1, R30.3, R30.4.
 *
 * Four steps, in this order, and the order is the contract:
 *
 *   1. **Discover.** Ask Workspace_Services for the rules sources it found and
 *      their contents. R6.3's capability table keeps `rules` there because
 *      discovery and file reads belong where the filesystem is — **the runtime
 *      does not walk the tree itself.** That is why discovery arrives through an
 *      injected port rather than a `readdir` call: there is no filesystem access
 *      in this module to accidentally reach for.
 *   2. **Order.** Apply the precedence `rules-sources.ts` computes, which is the
 *      renderer's own classifier copied verbatim, so the Rules display and the
 *      prompt cannot disagree about what applies or in what order.
 *   3. **Merge.** Concatenate the ordered rule text, then append the workspace
 *      facts the loop needs and cannot get from a tool call.
 *   4. **Return both.** `instructions` goes to `buildAgent` (9.6);
 *      `appliedSources` is written to `ZocMessageMetadata.rulesSources` on finish,
 *      which makes R30.4's "display which sources were applied" a read of
 *      existing metadata rather than a second discovery pass.
 *
 * **A malformed source is never fatal.** It is skipped, its reason recorded, and
 * the Run proceeds on the sources that did read. The alternative — failing the Run
 * — means one unreadable file in a subdirectory nobody is working in stops all
 * work, and the user's only signal is a Run that will not start.
 *
 * Deliberately out of scope: R30.2's enable/disable map and R30.5's in-place
 * editing are the M2 rules *editor*. M1 applies every well-formed source it finds
 * and records which ones those were.
 */

import { classifyRuleSources, type RuleSource } from "./rules-sources.ts";

/** Hard ceiling on one source's contribution, in characters. */
export const MAX_SOURCE_CHARS = 32_000;

/** Hard ceiling on the merged rule text, before the workspace facts are added. */
export const MAX_RULES_CHARS = 96_000;

/**
 * One discovered rule source as Workspace_Services reports it.
 *
 * `content` is null when the service could not read it; `error` then carries the
 * reason. Two fields rather than an empty string because an unreadable file and an
 * empty file are different facts, and only one of them belongs in `skipped`.
 */
export interface RuleDocument {
  readonly path: string;
  readonly content: string | null;
  readonly error?: string | null;
}

/**
 * The discovery port.
 *
 * A function rather than a client object so 9.10 can drive the assembler with a
 * literal source list and no HTTP, and so the module has no opinion about
 * where the sources came from.
 */
export type DiscoverRules = (sessionId: string) => Promise<readonly RuleDocument[]>;

/**
 * The shape of the client half of the port, structurally.
 *
 * Declared here rather than importing `WorkspaceClient` so this module keeps its
 * one dependency (`rules-sources.ts`) and no path into `tools/`. `WorkspaceClient`
 * satisfies it by shape, and 9.10 satisfies it with an object literal.
 */
export interface RulesDiscoveryClient {
  discoverRules(
    sessionId: string,
  ): Promise<
    | { readonly ok: true; readonly value: readonly RuleDocument[] }
    | { readonly ok: false; readonly message: string }
  >;
}

/**
 * Adapt the Workspace_Services client to the discovery port.
 *
 * A failed call becomes one synthetic document carrying the reason rather than a
 * thrown error, so an unreachable rules service lands in `skipped` through the
 * same per-source path an unreadable file does — one reporting mechanism, and the
 * Run still starts.
 */
export function discoverRulesVia(client: RulesDiscoveryClient): DiscoverRules {
  return async (sessionId: string) => {
    const outcome = await client.discoverRules(sessionId);
    if (outcome.ok) return outcome.value;
    return [{ path: "(discovery)", content: null, error: outcome.message }];
  };
}

/** Workspace facts the loop cannot derive from a tool call. */
export interface WorkspaceFacts {
  readonly workspaceRoot: string;
  /** The detected project test command, or null when none was detected. */
  readonly testCommand?: string | null;
  readonly permissionMode: string;
  readonly conversationMode?: string | null;
}

export interface AssembleInstructionsInput extends WorkspaceFacts {
  readonly sessionId: string;
  readonly discoverRules: DiscoverRules;
}

/** A source that was discovered but did not make it into the prompt. */
export interface SkippedSource {
  readonly path: string;
  readonly reason: string;
}

export interface AssembledInstructions {
  readonly instructions: string;
  /**
   * Workspace-relative paths of the sources actually applied, in merge order.
   * Written straight to `ZocMessageMetadata.rulesSources`.
   */
  readonly appliedSources: readonly string[];
  /** Discovered sources excluded from the prompt, each with its reason. */
  readonly skipped: readonly SkippedSource[];
}

/**
 * Why a document cannot be used, or null when it can.
 *
 * Whitespace-only counts as unusable: a file of blank lines contributes a heading
 * and nothing under it, and listing it in `appliedSources` would tell the user a
 * rule applied when no rule text reached the model.
 */
function rejectionReason(document: RuleDocument): string | null {
  if (typeof document.path !== "string" || document.path.trim().length === 0) {
    return "The source has no path.";
  }
  if (document.error !== null && document.error !== undefined && document.error !== "") {
    return document.error;
  }
  if (document.content === null || document.content === undefined) {
    return "The source could not be read.";
  }
  if (typeof document.content !== "string") {
    return "The source content was not text.";
  }
  if (document.content.trim().length === 0) return "The source is empty.";
  // A NUL byte means a binary file matched a rules glob. Feeding it to a provider
  // wastes context at best and trips a content filter at worst.
  if (document.content.includes("\u0000")) return "The source is not UTF-8 text.";
  return null;
}

function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit)}\n…[truncated]`, truncated: true };
}

/**
 * Assemble the Run's system instructions.
 *
 * Discovery failure is not fatal either: a Run with no rules is a valid Run, and
 * refusing to start one because the rules service is restarting would make an
 * unrelated outage look like a broken agent. The reason lands in `skipped` under a
 * synthetic path so it is still visible.
 */
export async function assembleInstructions(
  input: AssembleInstructionsInput,
): Promise<AssembledInstructions> {
  const skipped: SkippedSource[] = [];

  let discovered: readonly RuleDocument[] = [];
  try {
    discovered = (await input.discoverRules(input.sessionId)) ?? [];
  } catch (cause) {
    skipped.push({
      path: "(discovery)",
      reason:
        cause instanceof Error && cause.message.length > 0
          ? cause.message
          : "Rules discovery was unavailable.",
    });
  }

  // Index by path so ordering can be applied to the classified list without
  // re-scanning, and so a duplicate path resolves to one entry rather than
  // contributing its text twice.
  const byPath = new Map<string, RuleDocument>();
  for (const document of discovered) {
    const reason = rejectionReason(document);
    if (reason !== null) {
      skipped.push({ path: document?.path ?? "(unnamed)", reason });
      continue;
    }
    if (byPath.has(document.path)) continue;
    byPath.set(document.path, document);
  }

  const ordered: RuleSource[] = classifyRuleSources([...byPath.keys()]);

  const applied: string[] = [];
  const blocks: string[] = [];
  let budget = MAX_RULES_CHARS;

  for (const source of ordered) {
    const document = byPath.get(source.path);
    if (document?.content === null || document?.content === undefined) continue;

    const bounded = truncate(document.content.trim(), MAX_SOURCE_CHARS);
    if (bounded.text.length > budget) {
      // Stop rather than partially include: a rule cut mid-sentence can invert
      // its own meaning, and "half of this rule applies" is not a thing a user
      // can reason about. The remainder is reported as skipped.
      skipped.push({
        path: source.path,
        reason: "Skipped: the merged rules budget was exhausted.",
      });
      continue;
    }
    budget -= bounded.text.length;

    blocks.push(`## ${source.label} — ${source.path}\n\n${bounded.text}`);
    applied.push(source.path);
    if (bounded.truncated) {
      skipped.push({
        path: source.path,
        reason: `Truncated at ${MAX_SOURCE_CHARS} characters.`,
      });
    }
  }

  const sections: string[] = [BASE_INSTRUCTIONS];
  if (blocks.length > 0) {
    sections.push(`# Project rules\n\n${blocks.join("\n\n")}`);
  }
  sections.push(renderWorkspaceFacts(input));

  return {
    instructions: sections.join("\n\n"),
    appliedSources: applied,
    skipped,
  };
}

/**
 * The workspace facts block.
 *
 * Last rather than first, so a project rule cannot be displaced from the top of
 * the prompt by boilerplate — and so the permission mode, which is the fact most
 * likely to change between two otherwise identical Runs, sits nearest the
 * conversation where recency helps.
 */
function renderWorkspaceFacts(facts: WorkspaceFacts): string {
  const lines = [
    "# Workspace",
    "",
    `- Workspace root: ${facts.workspaceRoot}`,
    `- Permission mode: ${facts.permissionMode}`,
  ];
  if (facts.conversationMode !== null && facts.conversationMode !== undefined) {
    lines.push(`- Conversation mode: ${facts.conversationMode}`);
  }
  lines.push(
    facts.testCommand !== null && facts.testCommand !== undefined && facts.testCommand !== ""
      ? `- Project test command: ${facts.testCommand}`
      : "- Project test command: none detected. Ask before guessing one.",
  );
  return lines.join("\n");
}

/**
 * The invariant part of the prompt.
 *
 * Kept short on purpose. Every sentence here competes for attention with the
 * user's own project rules, and the tool descriptions in the registry already
 * carry the per-tool guidance that would otherwise be restated.
 */
export const BASE_INSTRUCTIONS = [
  "You are Zoc AI, a coding agent working inside the user's workspace.",
  "",
  "- Prefer reading the workspace over asking the user for information a tool can retrieve.",
  "- Paths are workspace-relative. Never construct an absolute path from the workspace root.",
  "- Propose a plan before writing files when a change spans more than one file.",
  "- Call `declare_complete` when the request is satisfied. Do not narrate that you are finishing instead of calling it.",
].join("\n");
