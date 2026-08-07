import { getProvider } from "./providers";
import { useApp } from "./store";

/** Model-selection fields accepted by the editor completion and inline-edit routes. */
export interface ActiveModelRequestContext {
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
}

/**
 * Resolve the currently selected editor model at request time.
 *
 * Local llama.cpp requests use the supervised server URL from the app store;
 * cloud requests use the configured provider URL. Reading lazily avoids a stale
 * selection when a user changes models while an editor is already mounted.
 *
 * **No credential (task 26.3, R14.2).** This used to return the keychain-backed
 * `apiKey` alongside the selection, and both consumers then had to name their
 * body fields one by one to keep it off the wire — `completions-client.ts` and
 * `inline-edit-client.ts` each carry a comment saying so. R7.8 puts key
 * resolution inside the runtime, so the field had no remaining reader and its
 * only effect was to hand every caller a value it had to remember not to send.
 * Dropping it from the type is what makes that impossible rather than merely
 * discouraged.
 */
export async function resolveActiveModelRequestContext(): Promise<ActiveModelRequestContext> {
  const state = useApp.getState();
  const provider = state.selectedModel.provider?.trim() || null;
  const model = state.selectedModel.model?.trim() || null;

  if (!provider || provider === "mock") {
    return { provider, model, baseUrl: null };
  }
  if (provider === "llamacpp") {
    return { provider, model, baseUrl: state.llamaCppStatus?.base_url ?? null };
  }

  return { provider, model, baseUrl: getProvider(provider)?.baseUrl ?? null };
}
