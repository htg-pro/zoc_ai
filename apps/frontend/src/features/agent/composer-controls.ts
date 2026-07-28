/**
 * composer-controls.ts — one projection for every Composer control's state
 * (R16.1, R16.5–R16.7, R17.1, R17.5).
 *
 * A single function returns the mode control, the reasoning-effort control, and
 * the send gate together, so "locked while a run is active" and "locked in
 * read-only mode" cannot disagree between controls.
 */
import { AGENT_MODES, type AgentMode } from "./prepare-agent-run";
import type { RunGate } from "./model-availability";

export type ReasoningEffort = "low" | "medium" | "high";

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high"] as const;

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "low" || value === "medium" || value === "high";
}

export interface ComposerControls {
  mode: { value: AgentMode; options: readonly AgentMode[]; disabled: boolean };
  effort: {
    value: ReasoningEffort;
    options: readonly ReasoningEffort[];
    disabled: boolean;
    supported: boolean;
  };
  send: RunGate;
}

/**
 * R17.4 — the reasoning-effort field for a run request: the selected level when
 * the model supports one, and `undefined` (omitted entirely) when it does not,
 * so the Gateway issues the request with no defaulted effort parameter.
 */
export function buildReasoningEffortField(
  modelSupportsEffort: boolean,
  effort: ReasoningEffort,
): ReasoningEffort | undefined {
  return modelSupportsEffort ? effort : undefined;
}

/**
 * R17.4 — the frontend's transport-level gate for the reasoning-effort field.
 * Local llama.cpp GGUFs and the mock provider carry no effort parameter, so a
 * run against them must omit the field entirely. Cloud providers may carry one;
 * the Gateway (`model_runtime.reasoning_effort_capability`) makes the final
 * per-model decision and drops the field for a model without the parameter, so
 * this coarse provider gate never sends effort where it cannot apply.
 *
 * @deprecated Prefer {@link modelSupportsReasoningEffort}, which mirrors the
 * Gateway's per-model rule (OpenAI reasoning markers, Anthropic versions). A
 * local `deepseek-r1`/`qwq` GGUF does accept the parameter, so the coarse
 * provider-only gate was both over- and under-inclusive.
 */
export function providerSupportsReasoningEffort(provider: string | null | undefined): boolean {
  if (!provider) return false;
  return provider !== "llamacpp" && provider !== "mock";
}

/* ── Model-specific reasoning-effort capability (R17.2, R17.4) ────────────────
 *
 * Mirrors `zocai_gateway/model_runtime.reasoning_effort_capability` field for
 * field, so the Composer control's enabled/disabled state matches exactly which
 * runs will actually carry a reasoning-effort parameter. The frontend only
 * needs the boolean ("does this model accept an effort level"), but the shape
 * is returned too for parity and future per-shape UI.
 */
export type ReasoningCapability =
  | "openai"
  | "anthropic_adaptive"
  | "anthropic_budget"
  | "none";

/** OpenAI-compatible providers that route via the OpenAI-style parameter. */
const OPENAI_COMPATIBLE_PROVIDERS: ReadonlySet<string> = new Set([
  "openai",
  "google",
  "google-ai-studio",
  "googleaistudio",
  "groq",
  "xai",
  "llamacpp",
  "openai-compatible",
  "openrouter",
  "together",
  "deepseek",
  "mistral",
  "fireworks",
]);

/** Name markers for OpenAI-compatible reasoning models (o-series, GPT-5+, …). */
const OPENAI_REASONING_MARKERS: readonly string[] = [
  "o1",
  "o3",
  "o4",
  "gpt-5",
  "gpt-6",
  "reason",
  "think",
  "deepseek-r",
  "qwq",
  "-r1",
];

/** Parse a Claude major.minor (`claude-opus-4-6` → `[4, 6]`). */
function anthropicMinorVersion(model: string): [number, number] | null {
  const match = /(\d+)[.\-](\d+)/.exec(model);
  if (!match) return null;
  return [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10)];
}

function atLeast(version: [number, number], major: number, minor: number): boolean {
  return version[0] > major || (version[0] === major && version[1] >= minor);
}

/**
 * The reasoning-effort parameter shape a model accepts, or `"none"` (R17.4).
 * Kept identical to the Gateway's `reasoning_effort_capability`.
 */
export function reasoningEffortCapability(
  provider: string | null | undefined,
  model: string | null | undefined,
): ReasoningCapability {
  const p = (provider ?? "").trim().toLowerCase();
  const m = (model ?? "").trim().toLowerCase();
  if (!m) return "none";
  if (p === "anthropic") {
    const version = anthropicMinorVersion(m);
    if (version === null) return "none";
    if (atLeast(version, 4, 6)) return "anthropic_adaptive";
    if (atLeast(version, 4, 0) || (version[0] === 3 && version[1] === 7)) {
      return "anthropic_budget";
    }
    return "none";
  }
  if (
    OPENAI_COMPATIBLE_PROVIDERS.has(p) &&
    OPENAI_REASONING_MARKERS.some((mark) => m.includes(mark))
  ) {
    return "openai";
  }
  return "none";
}

/**
 * Whether the selected model accepts a reasoning-effort level at all. This is
 * the predicate the Composer control uses (R17.1): the control is always
 * rendered, but disabled + labelled when this is false, and the request omits
 * the field entirely (R17.4).
 */
export function modelSupportsReasoningEffort(
  provider: string | null | undefined,
  model: string | null | undefined,
): boolean {
  return reasoningEffortCapability(provider, model) !== "none";
}

export function composerControls(input: {
  mode: AgentMode;
  activeRunMode: AgentMode | null;
  effort: ReasoningEffort;
  modelSupportsEffort: boolean;
  readOnly: boolean;
  gate: RunGate;
}): ComposerControls {
  const runActive = input.activeRunMode !== null;
  // While a run is active the controls are locked and show the run's mode (R16.6).
  const lockedByRun = runActive || input.readOnly;
  return {
    mode: {
      value: input.activeRunMode ?? input.mode,
      options: AGENT_MODES,
      disabled: lockedByRun,
    },
    effort: {
      value: input.effort,
      options: REASONING_EFFORTS,
      // Unsupported models can never toggle it (R17.4); a live run locks it (R17.5).
      disabled: lockedByRun || !input.modelSupportsEffort,
      supported: input.modelSupportsEffort,
    },
    send: input.gate,
  };
}
