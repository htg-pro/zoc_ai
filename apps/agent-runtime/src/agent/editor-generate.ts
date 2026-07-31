/**
 * The editor routes' generator — zoc-agent-chat-rebuild R6.2, R7.8, R13.5, task 22.11's prerequisite.
 *
 * `/v1/completions` and `/v1/inline-edit` were ported at 9.7 with their generator left as a throwing
 * stub, and the stub's stated reason was that "a real generator needs a selected model for the editor,
 * which is app state the runtime is not given". That reason does not hold: both body schemas carry
 * `provider` and `model` (`editor-routes.ts`'s `modelSelection`), so the request names the model and only
 * the *credential* is withheld — which is exactly the split R7.8 asks for. The runtime resolves the key
 * itself, from the same vault and through the same module a Run uses.
 *
 * So this closes the gap rather than working around it. Without it, 22.11 and 22.12 would repoint two
 * working Gateway clients at a runtime that answers every request with one empty `done`, and editor
 * autocomplete and ⌘K would silently stop working — a regression dressed as a migration, and an
 * especially quiet one because both routes fail quiet by contract.
 *
 * ## What a missing selection does, and why that is still a throw
 *
 * A request with no provider, or with `mock`, has no model to ask. Throwing hands the route its
 * fail-quiet path: one `done`, no completion, no toast. That is the correct behaviour for an editor with
 * nothing configured, and it is what the previous stub did for *every* request.
 *
 * ## Why the key is resolved per request rather than held
 *
 * `keys.ts`'s discipline is that a resolved key lives in a local binding for the length of one operation
 * and is never assigned to module scope (5.2). An editor generator that cached one would be the one place
 * in the runtime holding a credential across requests, and it would do so for the component called on
 * every keystroke.
 */

import { streamText } from "ai";

import { resolveKey, type SecretSource } from "../providers/keys.ts";
import { resolveModel } from "../providers/registry.ts";
import type { EditorGenerateRequest } from "../http/editor-routes.ts";

/** Providers that name no real model, so there is nothing to ask. */
const UNCONFIGURED = new Set(["", "mock"]);

export interface EditorGeneratorDeps {
  readonly secrets: SecretSource;
  /** Injected in tests, so the generator is assertable without a provider. */
  readonly streamImpl?: typeof streamText;
}

/**
 * Build the `generate` port `registerEditorRoutes` takes.
 *
 * Returns an async iterable rather than a stream for the reason the port documents: the routes are
 * testable with a generator function and no provider.
 */
export function createEditorGenerator(
  deps: EditorGeneratorDeps,
): (request: EditorGenerateRequest) => AsyncIterable<string> {
  const stream = deps.streamImpl ?? streamText;

  return function generate(request: EditorGenerateRequest): AsyncIterable<string> {
    return (async function* run() {
      const provider = (request.provider ?? "").trim();
      const modelId = (request.modelId ?? "").trim();
      if (UNCONFIGURED.has(provider) || modelId.length === 0) {
        throw new Error("No editor model is selected.");
      }

      // Resolved before the model, and thrown from rather than defaulted: `resolveModel` raises
      // `no_key_configured` for a cloud provider with no key, which the route turns into a quiet
      // `done` — the same outcome the old Gateway path had when the key was missing from the body.
      const apiKey = await resolveKey(provider, deps.secrets);
      // `baseUrl` is deliberately absent from the editor bodies, so a local model resolves against
      // `DEFAULT_LOCAL_BASE_URL` and `assertLoopback` still guarantees R13.5 — an editor request can
      // name a local model but cannot redirect one off the loopback interface.
      const resolved = resolveModel({ model: { provider, modelId }, apiKey });

      const result = stream({
        model: resolved.model,
        prompt: request.prompt,
        temperature: request.temperature,
        maxOutputTokens: request.maxOutputTokens,
        ...(request.stopSequences.length === 0
          ? {}
          : { stopSequences: [...request.stopSequences] }),
        abortSignal: request.signal,
      });

      for await (const delta of result.textStream) {
        yield delta;
      }
    })();
  };
}
