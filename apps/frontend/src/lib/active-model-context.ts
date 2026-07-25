import { getProvider } from "./providers";
import { secureStore } from "./secure-store";
import { useApp } from "./store";

/** Model-selection fields accepted by the editor completion and inline-edit routes. */
export interface ActiveModelRequestContext {
  provider: string | null;
  model: string | null;
  apiKey: string | null;
  baseUrl: string | null;
}

/**
 * Resolve the currently selected editor model at request time.
 *
 * Local llama.cpp requests use the supervised server URL from the app store;
 * cloud requests use the configured provider URL and keychain-backed API key.
 * Reading lazily avoids stale credentials when a user changes models while an
 * editor is already mounted.
 */
export async function resolveActiveModelRequestContext(): Promise<ActiveModelRequestContext> {
  const state = useApp.getState();
  const provider = state.selectedModel.provider?.trim() || null;
  const model = state.selectedModel.model?.trim() || null;

  if (!provider || provider === "mock") {
    return { provider, model, apiKey: null, baseUrl: null };
  }
  if (provider === "llamacpp") {
    return {
      provider,
      model,
      apiKey: null,
      baseUrl: state.llamaCppStatus?.base_url ?? null,
    };
  }

  const config = getProvider(provider);
  const apiKey = await secureStore.get(`provider.${provider}.api_key`);
  return {
    provider,
    model,
    apiKey: apiKey?.trim() || null,
    baseUrl: config?.baseUrl ?? null,
  };
}
