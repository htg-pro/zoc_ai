/**
 * Provider registry and the single model resolver — zoc-agent-chat-rebuild
 * R6.2, R13.1, R13.4, R13.5, R13.6.
 *
 * Six adapters, matching what the retained Python `model_runtime.py` already
 * talks to: an OpenAI-compatible `/chat/completions` path for most providers,
 * Anthropic's native Messages API, and a local llama.cpp endpoint.
 *
 * **Every model choice goes through `resolveModel`.** That is the point of this
 * module rather than a convenience: M1 reads the user's selection, and M2's
 * routing policy and fallback chain become a policy object consulted *inside*
 * that one function. Without the single entry point, model selection would be
 * scattered across the run handler and the registry, and R27.5's "name the
 * original model, the fallback model, and the reason" would have no one place to
 * be emitted from.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import type { LanguageModel } from "ai";

import { ErrorCode, HttpError, envelope } from "../http/errors.ts";

/** Hosts a local provider may be configured against (R13.5). */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]",
  "0:0:0:0:0:0:0:1",
]);

export const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:8080/v1";

/**
 * Refuse any non-loopback base URL, at configuration time.
 *
 * Configuration time, not request time: a local provider whose base URL points
 * off-box is a misconfiguration to reject before a single token of workspace
 * content is assembled into a prompt, not one to discover from a connect log
 * afterwards.
 */
export function assertLoopback(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new HttpError(
      422,
      envelope(ErrorCode.INVALID_REQUEST, "The local model endpoint is not a valid URL."),
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(
      422,
      envelope(ErrorCode.INVALID_REQUEST, "The local model endpoint must use http or https."),
    );
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new HttpError(
      422,
      envelope(
        ErrorCode.INVALID_REQUEST,
        "A local model endpoint must be on this machine. Zoc AI refuses to send " +
          "workspace content to a remote host under a local provider.",
      ),
    );
  }
  return baseUrl;
}

/** What a provider needs in order to hand back a model. */
export interface ResolveOpts {
  readonly apiKey: string | null;
  readonly modelId: string;
  readonly baseUrl?: string | null;
}

/**
 * Capability metadata the model picker and the gate both read.
 *
 * `search` is declared here in M1 with no M1 consumer, for the same reason the
 * wire union declares `SourcePart`: M2's provider-native search registers per
 * provider, and a flag added later would mean touching every entry again.
 */
export interface ProviderCapabilities {
  readonly tools: boolean;
  readonly vision: boolean;
  readonly reasoning: boolean;
  /** Provider-executed web search (R33). */
  readonly search: boolean;
}

export interface ProviderSpec {
  readonly id: string;
  readonly label: string;
  readonly requiresKey: boolean;
  readonly local: boolean;
  readonly capabilities: ProviderCapabilities;
  readonly resolve: (opts: ResolveOpts) => LanguageModel;
}

const CLOUD_DEFAULTS: ProviderCapabilities = {
  tools: true,
  vision: true,
  reasoning: false,
  search: false,
};

export const PROVIDERS: readonly ProviderSpec[] = Object.freeze([
  {
    id: "openai",
    label: "OpenAI",
    requiresKey: true,
    local: false,
    capabilities: { ...CLOUD_DEFAULTS, reasoning: true, search: true },
    resolve: ({ apiKey, modelId }) => createOpenAI({ apiKey: apiKey ?? undefined })(modelId),
  },
  {
    id: "anthropic",
    label: "Anthropic",
    requiresKey: true,
    local: false,
    capabilities: { ...CLOUD_DEFAULTS, reasoning: true, search: true },
    // Native Messages API, not the compatibility shim — the same reason
    // `model_runtime.py` keeps `_anthropic_tools_messages` separate from
    // `_openai_tools_chat`. The shim loses tool-use blocks and extended
    // thinking, which are two of the three things this runtime is for.
    resolve: ({ apiKey, modelId }) => createAnthropic({ apiKey: apiKey ?? undefined })(modelId),
  },
  {
    id: "google-ai-studio",
    label: "Google AI Studio",
    requiresKey: true,
    local: false,
    capabilities: { ...CLOUD_DEFAULTS, search: true },
    resolve: ({ apiKey, modelId }) =>
      createGoogleGenerativeAI({ apiKey: apiKey ?? undefined })(modelId),
  },
  {
    id: "groq",
    label: "Groq",
    requiresKey: true,
    local: false,
    // No server-side search facility (R33.2).
    capabilities: { ...CLOUD_DEFAULTS, vision: false },
    resolve: ({ apiKey, modelId }) => createGroq({ apiKey: apiKey ?? undefined })(modelId),
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    requiresKey: true,
    local: false,
    capabilities: { ...CLOUD_DEFAULTS },
    resolve: ({ apiKey, modelId }) => createXai({ apiKey: apiKey ?? undefined })(modelId),
  },
  {
    id: "local-llamacpp",
    label: "Local (llama.cpp)",
    requiresKey: false,
    local: true,
    capabilities: { tools: true, vision: false, reasoning: false, search: false },
    // R13.4/R13.5: no key, and the baseURL is loopback-only, so no request can
    // leave the machine.
    resolve: ({ baseUrl, modelId }) =>
      createOpenAICompatible({
        name: "local-llamacpp",
        baseURL: assertLoopback(baseUrl ?? DEFAULT_LOCAL_BASE_URL),
      })(modelId),
  },
]);

const BY_ID: ReadonlyMap<string, ProviderSpec> = new Map(PROVIDERS.map((spec) => [spec.id, spec]));

export function providerSpec(providerId: string): ProviderSpec {
  const spec = BY_ID.get(providerId);
  if (spec === undefined) {
    throw HttpError.notFound(
      ErrorCode.MODEL_NOT_FOUND,
      "That provider is not one Zoc AI knows about.",
    );
  }
  return spec;
}

export function isLocalProvider(providerId: string): boolean {
  return BY_ID.get(providerId)?.local ?? false;
}

/** The model reference a run request carries. */
export interface ModelRef {
  readonly provider: string;
  readonly modelId: string;
  readonly baseUrl?: string | null;
}

export interface ResolvedModel {
  readonly model: LanguageModel;
  readonly spec: ProviderSpec;
  readonly modelId: string;
  /**
   * Set when a routing policy chose a different model than the request asked
   * for, so R27.5's "name the original, the fallback, and the reason" has
   * somewhere to read from. Always null in M1, where the resolver honours the
   * user's selection exactly.
   */
  readonly substitutedFor: { readonly modelId: string; readonly reason: string } | null;
}

/**
 * The single place a model is chosen.
 *
 * `apiKey` is passed in rather than resolved here on purpose: key resolution has
 * its own module with its own redaction discipline (`keys.ts`), and a resolver
 * that fetched credentials would make every model-selection test need a secret
 * source.
 */
export function resolveModel(request: {
  readonly model: ModelRef;
  readonly apiKey: string | null;
}): ResolvedModel {
  const spec = providerSpec(request.model.provider);

  if (spec.requiresKey && (request.apiKey === null || request.apiKey.length === 0)) {
    throw new HttpError(
      400,
      envelope(
        ErrorCode.NO_KEY_CONFIGURED,
        `${spec.label} needs an API key before it can be used. Add one in Settings.`,
      ),
    );
  }

  // M2 inserts the routing policy here — one `if`, consulted before `resolve`,
  // writing `substitutedFor`.
  const model = spec.resolve({
    apiKey: request.apiKey,
    modelId: request.model.modelId,
    baseUrl: request.model.baseUrl ?? null,
  });

  return {
    model,
    spec,
    modelId: request.model.modelId,
    substitutedFor: null,
  };
}

/** Public catalogue shape for `GET /v1/providers`. Carries no credential. */
export function providerCatalogue(): ReadonlyArray<{
  id: string;
  label: string;
  requiresKey: boolean;
  local: boolean;
  capabilities: ProviderCapabilities;
}> {
  return PROVIDERS.map(({ id, label, requiresKey, local, capabilities }) => ({
    id,
    label,
    requiresKey,
    local,
    capabilities,
  }));
}
