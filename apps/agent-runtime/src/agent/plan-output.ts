/**
 * Structured plan output — zoc-agent-chat-rebuild R5.3, R10.1, R10.10, R10.11,
 * R10.14.
 *
 * Feature: zoc-agent-chat-rebuild, R5.3, R10.1, R10.10, R10.11, R10.14.
 *
 * The plan is produced through a schema, not parsed out of prose. `Output.object()`
 * uses the schema for *both* generation and validation, so a provider that returns
 * a malformed object fails at the schema rather than three layers downstream where
 * the failure looks like a rendering bug.
 *
 * ## The partial stream, and why the part id is stable
 *
 * A plan over eight files takes several seconds to generate. Emitting it only when
 * complete means the plan card appears fully formed after a long blank pause;
 * emitting each partial to the **same** `data-zoc-plan` part id means the card
 * fills in file by file, because the surface reconciles a data part by id rather
 * than appending a row. Using a fresh id per partial would render eight plan cards.
 *
 * ## One retry, then fail
 *
 * A validation failure gets exactly one retry with the validation message
 * appended — the same recovery the existing agent pipeline specifies. Two retries
 * would triple the latency of a failure mode that is usually deterministic: a
 * model that cannot produce the shape once rarely produces it on the third ask.
 * After the retry the Run fails with `plan_invalid`.
 */

import { z } from "zod";

import { ErrorCode } from "../http/errors.ts";

/** Maximum files one plan may touch. A plan larger than this is not reviewable. */
export const MAX_PLAN_FILES = 40;

const hunkActionSchema = z.enum(["create", "modify", "delete", "rename"]);

/**
 * One target file. Mirrors `PlanFile` on the wire (R10.10, R10.11, R10.14).
 *
 * `sourcePath` carries both ends of a move, so a rename is a rename rather than a
 * delete plus a create with a lost origin.
 */
export const planFileSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .describe(
        "Workspace-relative path this file will have AFTER the change. For a " +
          "rename, the target path.",
      ),
    action: hunkActionSchema.describe("What happens to this file."),
    sourcePath: z
      .string()
      .nullable()
      .default(null)
      .describe("Only for a rename: the path the file moves from. Null otherwise."),
    rationale: z
      .string()
      .min(1)
      .max(300)
      .describe("One sentence on why this file is being changed."),
    addedLines: z.number().int().min(0).describe("Lines this change adds."),
    removedLines: z.number().int().min(0).describe("Lines this change removes."),
    hunkCount: z.number().int().min(0).describe("How many separate hunks."),
  })
  .refine((file) => (file.action === "rename") === (file.sourcePath !== null), {
    message: "sourcePath is required for a rename and must be null otherwise",
  });

/** The plan schema the model generates against. */
export const planSchema = z.object({
  title: z.string().min(1).max(120).describe("A short imperative summary of the whole change."),
  files: z
    .array(planFileSchema)
    .min(1)
    .max(MAX_PLAN_FILES)
    .describe("Every file the change touches. Do not omit one."),
  verificationCommand: z
    .string()
    .nullable()
    .default(null)
    .describe("The command that verifies this change, or null when there is none."),
});

export type PlanDraft = z.infer<typeof planSchema>;

/** A partial plan, as it arrives. Every field may be missing mid-stream. */
export type PartialPlan = {
  title?: string;
  files?: Array<Partial<z.infer<typeof planFileSchema>>>;
  verificationCommand?: string | null;
};

/**
 * A plan the runtime refused, with the reason the retry prompt appends.
 *
 * The fields are declared and assigned rather than written as constructor parameter
 * properties. That is not a style choice: `node --experimental-strip-types` erases types
 * without transforming, so a parameter property is `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` —
 * it needs a constructor body generated for it. The process starts through
 * `--experimental-strip-types` (`package.json`'s `start`, and the handshake test's spawn),
 * so one parameter property anywhere in the module graph makes the runtime fail to boot
 * while `tsc` and `vitest` both stay green.
 */
export class PlanInvalidError extends Error {
  readonly code = ErrorCode.PLAN_INVALID;
  /** The validation detail, appended to the retry prompt. */
  readonly detail: string;

  constructor(message: string, detail: string) {
    super(message);
    this.name = "PlanInvalidError";
    this.detail = detail;
  }
}

/**
 * Validate a plan, refusing the shapes the schema alone cannot catch.
 *
 * `files_are_unique_by_path` is the one that matters in practice: a model asked to
 * change a file twice emits it twice, and two plan entries for one path make the
 * per-hunk review ambiguous about which set of decisions applies.
 */
export function validatePlan(candidate: unknown): PlanDraft {
  const parsed = planSchema.safeParse(candidate);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 6)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new PlanInvalidError("The plan was not in the expected shape.", detail);
  }

  const paths = parsed.data.files.map((file) => file.path);
  const duplicates = [...new Set(paths.filter((path, index) => paths.indexOf(path) !== index))];
  if (duplicates.length > 0) {
    throw new PlanInvalidError(
      "The plan lists the same file more than once.",
      // The paths are the model's own output about the user's own workspace, so
      // naming them is not a leak — and a reviewer needs to know which file.
      `duplicate paths: ${duplicates.join(", ")}`,
    );
  }

  return parsed.data;
}

/**
 * Generate a plan, retrying once on a validation failure.
 *
 * `generate` is injected rather than constructed here so the retry policy is
 * testable without a provider: the interesting behaviour is "exactly one retry,
 * with the validation message appended", and that is a property of this function
 * rather than of any model.
 */
export async function generatePlanWithOneRetry(options: {
  generate: (extraInstruction: string | null) => Promise<unknown>;
  onPartial?: (partial: PartialPlan) => void;
}): Promise<PlanDraft> {
  try {
    return validatePlan(await options.generate(null));
  } catch (first) {
    if (!(first instanceof PlanInvalidError)) throw first;

    const retryInstruction =
      "Your previous plan did not validate against the required schema. " +
      `Fix exactly this and return the plan again: ${first.detail}`;
    // One retry. Not two.
    return validatePlan(await options.generate(retryInstruction));
  }
}

/**
 * Merge a partial object into the accumulated plan draft.
 *
 * Merging rather than replacing, because a provider streaming an object emits
 * progressively complete snapshots and a later snapshot can be *shorter* in a
 * field it has not reached yet. Replacing would make the card flicker fields away.
 */
export function mergePartial(into: PartialPlan, next: PartialPlan): PartialPlan {
  return {
    title: next.title ?? into.title,
    files:
      next.files !== undefined && next.files.length >= (into.files?.length ?? 0)
        ? next.files
        : into.files,
    verificationCommand:
      next.verificationCommand !== undefined ? next.verificationCommand : into.verificationCommand,
  };
}

/** Count the files a partial plan has resolved enough to render. */
export function renderableFileCount(partial: PartialPlan): number {
  return (partial.files ?? []).filter(
    (file) => typeof file.path === "string" && file.path.length > 0,
  ).length;
}
