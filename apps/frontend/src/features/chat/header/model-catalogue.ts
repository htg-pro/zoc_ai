/**
 * The model picker's view model — zoc-agent-chat-rebuild R13.1, R13.2, R13.3, R13.6, R13.11, R13.12,
 * R13.13, task 22.2.
 *
 * What the picker shows about a model, and the one rule that decides whether a Run can start. Pure, because
 * Property 30's claim — submission gating is a function of key state alone — is a claim about a function and
 * would be untestable as a component's internal.
 *
 * ## Why gating reads `hasKey` and nothing else
 *
 * R13.2 and R13.3 make key *presence* the gate. Not key validity, not a reachability probe, not the last
 * Run's outcome: those are all things the surface would have to guess at, and each guess is a way to block a
 * Run that would have worked. Desktop_Core owns the vault and answers "is there a key for this provider"
 * (4.2's `secret_has`), and that answer is the whole input. A local model requires no key at all, so it is
 * submittable whatever the vault says — which is the case a gate written as "block unless a key exists"
 * gets backwards.
 *
 * ## Why the picker shows a fit state and not three numbers
 *
 * R13.13: resident memory and video memory stay a status-bar concern. The picker renders the *fit* — does
 * this model run on this machine — because that is the fact that changes which model a user picks, and the
 * three numbers behind it are the live-hardware-monitor Amendment 1 retired.
 *
 * ## Why a model with no benchmark history shows nothing
 *
 * R13.11 puts the mean Token_Rate on each row; R13.12 says a model with no recorded history shows no figure
 * at all. Not a dash, not "—", not "unknown": an empty slot. A placeholder reads as a measurement of zero,
 * and the row is scanned rather than read.
 */

import type { ProviderModel } from "@/lib/providers";

/** Desktop_Core's hardware-fit verdict for a local model (3.5, R13.6). */
export type HardwareFit = "fits" | "tight" | "exceeds";

export interface ModelChoice {
  readonly provider: string;
  /** The provider's own label, for the group heading. */
  readonly providerLabel: string;
  readonly modelId: string;
  readonly label: string;
  /** True for a cloud provider that authenticates with a key. */
  readonly requiresKey: boolean;
  /** Desktop_Core's answer for this provider's key (4.2). Never the key itself. */
  readonly hasKey: boolean;
  /** True for a model served by the bundled `llama-server`. */
  readonly local: boolean;
  /** Present for local models only (R13.6, R13.13). */
  readonly fit?: HardwareFit;
  /** Mean tokens per second from this model's recorded benchmark history, or absent (R13.11, R13.12). */
  readonly meanTokensPerSecond?: number;
  readonly contextLimit: number;
}

/**
 * Whether a Run can be submitted with this model (R13.2, R13.3).
 *
 * The entire rule, and it is one line on purpose: a second condition here is a second way for the panel to
 * refuse a Run the runtime would have accepted.
 */
export function isSubmittable(model: ModelChoice): boolean {
  return !model.requiresKey || model.hasKey;
}

/** Why submission is blocked, or `null`. Named so the empty state and the send control agree. */
export function gateReasonOf(model: ModelChoice): string | null {
  if (isSubmittable(model)) return null;
  // Names the provider rather than the model: the key is per provider, so "add a key for Anthropic" is the
  // action, and naming the model would send the user looking for a per-model setting that does not exist.
  return `${model.providerLabel} needs an API key before a run can start.`;
}

/** The badge a row carries about its key, or `null` when there is nothing to say. */
export function keyBadgeOf(model: ModelChoice): "key-missing" | null {
  // A model with a key gets no badge: a tick beside every cloud row is decoration, and the absence of the
  // warning is the signal.
  return model.requiresKey && !model.hasKey ? "key-missing" : null;
}

/**
 * The Approval control's display label per wire value, and `formatRunElapsed`.
 *
 * Here rather than beside their components for the fast-refresh reason the rest of the feature follows: a
 * module exporting both a component and a value is a refresh boundary. Both are read by more than their own
 * component anyway — the label by any summary of the mode, the duration by the pill and by a test.
 *
 * **`ask` reads as `Confirm`, and the wire value does not change.** R11.1 names the three modes and the
 * protocol keeps `ask`; no user should have to distinguish Conversation_Mode `Ask` from Permission_Mode `ask`
 * by capitalisation. Display only — recorded because it is exactly the kind of thing a later pass would
 * otherwise "fix" back.
 */
export const PERMISSION_MODE_LABELS: Readonly<Record<"ask" | "auto" | "deny", string>> = {
  ask: "Confirm",
  auto: "Auto",
  deny: "Deny",
};

/** `0:14` — minutes and seconds, the resolution a Run's elapsed time is read at. */
export function formatRunElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}:${(seconds % 60).toString().padStart(2, "0")}`;
}

/** The words a fit state reads as. */
export const FIT_LABELS: Readonly<Record<HardwareFit, string>> = {
  fits: "fits this machine",
  tight: "tight on memory",
  exceeds: "larger than this machine",
};

export interface ModelGroup {
  readonly provider: string;
  readonly providerLabel: string;
  readonly models: readonly ModelChoice[];
}

/**
 * Models grouped by provider, in the order the providers were given.
 *
 * The caller's order rather than alphabetical: the catalogue lists the providers a user configured, and
 * re-sorting would move the one they use most away from where they left it. Within a group the model order
 * is the catalogue's too, for the same reason.
 */
export function groupByProvider(models: readonly ModelChoice[]): readonly ModelGroup[] {
  const groups: ModelGroup[] = [];
  for (const model of models) {
    const existing = groups.find((group) => group.provider === model.provider);
    if (existing === undefined) {
      groups.push({
        provider: model.provider,
        providerLabel: model.providerLabel,
        models: [model],
      });
      continue;
    }
    (existing.models as ModelChoice[]).push(model);
  }
  return groups;
}

/** `42 tok/s`, or `null` for a model with no recorded history (R13.12). */
export function formatMeanRate(model: ModelChoice): string | null {
  const rate = model.meanTokensPerSecond;
  if (rate === undefined || !Number.isFinite(rate) || rate <= 0) return null;
  // The same threshold `usage-figures.ts` uses for the live figure, so the two never disagree about
  // whether a rate is a whole number.
  return rate < 100 ? `${rate.toFixed(1).replace(/\.0$/, "")} tok/s` : `${String(Math.round(rate))} tok/s`;
}

/**
 * Build a choice from a catalogue entry plus the two facts the catalogue does not hold.
 *
 * Written as a function rather than assembled at each call site because `hasKey` and the benchmark mean come
 * from different sources — Desktop_Core's vault and the runtime's benchmark store — and pairing them with
 * the wrong model is exactly the kind of mistake that produces a picker showing one model's key state
 * against another's name.
 */
export function modelChoice(input: {
  readonly provider: string;
  readonly providerLabel: string;
  readonly model: ProviderModel;
  readonly requiresKey: boolean;
  readonly hasKey: boolean;
  readonly local: boolean;
  readonly fit?: HardwareFit;
  readonly meanTokensPerSecond?: number;
  readonly contextLimit: number;
}): ModelChoice {
  return {
    provider: input.provider,
    providerLabel: input.providerLabel,
    modelId: input.model.id,
    // `name` in the catalogue, `label` here: the picker's vocabulary is `label` everywhere else, and an
    // entry with an empty name falls back to the wire id rather than rendering a blank row.
    label: input.model.name.trim().length > 0 ? input.model.name : input.model.id,
    requiresKey: input.requiresKey,
    hasKey: input.hasKey,
    local: input.local,
    ...(input.fit === undefined ? {} : { fit: input.fit }),
    ...(input.meanTokensPerSecond === undefined
      ? {}
      : { meanTokensPerSecond: input.meanTokensPerSecond }),
    contextLimit: input.contextLimit,
  };
}
