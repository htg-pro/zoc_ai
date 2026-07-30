/**
 * The three catalogue routes — zoc-agent-chat-rebuild R13.1, R13.4, 9.7.
 *
 * ```
 * GET /v1/providers            → 200 { providers: [...] }
 * GET /v1/models?provider=<id> → 200 { models: [...], defaultContextWindow }
 * GET /v1/tools                → 200 { tools: [...] }
 * ```
 *
 * All three are read-only, unconditional, and free of credentials — the model
 * picker, the Settings panels, and the tool inspector read them, and none of them
 * should have to open a Run to find out what exists.
 *
 * **They answer from tables, not from the providers.** A live model list per
 * provider would need a key for each, would fail offline, and would make the
 * picker's contents depend on which keys happen to be configured — so a user with
 * no OpenAI key would see an empty catalogue rather than a locked one. Settings
 * already has a live-fetch affordance for the cases where the real list matters;
 * these routes are the offline floor beneath it, which is what A6's zero-key path
 * needs.
 */

import { toolCatalogue, type ToolDescriptor } from "../tools/registry.ts";
import { DEFAULT_CONTEXT_WINDOW, modelCatalogue } from "../providers/models.ts";
import { providerCatalogue } from "../providers/registry.ts";
import { json, type Router } from "./routes.ts";

export interface CatalogueRoutesDeps {
  /**
   * The Run-independent tool set.
   *
   * Injected rather than built here because `buildToolDescriptors` needs a
   * `ToolContext` — a workspace client, a gate, a writer — and a catalogue route
   * that constructed one would be standing up half a Run to answer a `GET`.
   */
  toolDescriptors(): readonly ToolDescriptor[];
}

export function registerCatalogueRoutes(router: Router, deps: CatalogueRoutesDeps): void {
  router.get("/v1/providers", ({ res }) => {
    json(res, 200, { providers: providerCatalogue() });
  });

  router.get("/v1/models", ({ res, query }) => {
    const provider = query.get("provider");
    json(res, 200, {
      models: modelCatalogue(provider === null || provider.length === 0 ? undefined : provider),
      // Sent alongside so a caller that resolves a window for a model absent from
      // the list lands on the same figure the runtime will measure the Run against.
      defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
    });
  });

  router.get("/v1/tools", ({ res }) => {
    json(res, 200, { tools: toolCatalogue(deps.toolDescriptors()) });
  });
}
