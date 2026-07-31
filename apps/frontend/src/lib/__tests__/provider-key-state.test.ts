/**
 * Provider key state — zoc-agent-chat-rebuild task 22.1 (R13.2, R13.3, R14.2, R23).
 *
 * Three claims, and the first two are about what the renderer is *not* given:
 *
 *   1. The catalogue answers key **presence**, never a key value (R14.2).
 *   2. The keychain key format is unchanged, so keys saved by an earlier build
 *      still resolve after the upgrade (R23) — and the Agent_Runtime, which builds
 *      the same string in `providers/keys.ts`, finds what the renderer saved.
 *   3. A key write refreshes the badge without a reload (R13.3), and an unrelated
 *      secret does not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const secrets = vi.hoisted(() => ({
  has: vi.fn(),
  listeners: new Set<(key: string) => void>(),
}));

vi.mock("@/lib/secure-store", () => ({
  secureStore: {
    has: secrets.has,
    get: vi.fn(),
    set: vi.fn(),
    clear: vi.fn(),
    status: vi.fn(),
  },
  subscribeSecrets: (cb: (key: string) => void) => {
    secrets.listeners.add(cb);
    return () => secrets.listeners.delete(cb);
  },
}));

import {
  BUILTIN_PROVIDERS,
  providerHasKey,
  providerKeyName,
  providerKeyStates,
  subscribeProviderKeys,
  type ProviderConfig,
} from "@/lib/providers";

function fireSecretChange(key: string): void {
  for (const listener of [...secrets.listeners]) listener(key);
}

const provider = (id: string): ProviderConfig => ({
  id,
  name: id,
  baseUrl: "https://example.invalid/v1",
  requiresKey: true,
  builtin: false,
  models: [{ id: "m", name: "M" }],
});

beforeEach(() => {
  secrets.has.mockReset();
  secrets.has.mockResolvedValue(false);
  secrets.listeners.clear();
});

afterEach(() => {
  secrets.listeners.clear();
});

describe("Feature: zoc-agent-chat-rebuild, task 22.1: the keychain key format", () => {
  it("keeps `provider.{id}.api_key` verbatim, which is what makes an upgrade keep its keys (R23)", () => {
    expect(providerKeyName("anthropic")).toBe("provider.anthropic.api_key");
    expect(providerKeyName("custom-my-gateway-abc")).toBe("provider.custom-my-gateway-abc.api_key");
  });

  it("asks the vault under that exact name and gets back a boolean, never a value (R14.2)", async () => {
    secrets.has.mockResolvedValue(true);

    await expect(providerHasKey("openai")).resolves.toBe(true);

    expect(secrets.has).toHaveBeenCalledWith("provider.openai.api_key");
    // A boolean is the whole answer. The renderer's legitimate need is "is this
    // provider configured", and that need never requires the key itself.
    expect(typeof (await providerHasKey("openai"))).toBe("boolean");
  });
});

describe("Feature: zoc-agent-chat-rebuild, task 22.1: key state for the picker", () => {
  it("reads every provider in one pass, so no two rows disagree", async () => {
    secrets.has.mockImplementation((key: string) =>
      Promise.resolve(key === "provider.anthropic.api_key"),
    );

    const states = await providerKeyStates([provider("openai"), provider("anthropic")]);

    expect(states.get("openai")).toBe(false);
    expect(states.get("anthropic")).toBe(true);
    expect(states.size).toBe(2);
  });

  it("defaults to the stored catalogue, so the picker and Settings see one list", async () => {
    const states = await providerKeyStates();
    for (const builtin of BUILTIN_PROVIDERS) {
      expect(states.has(builtin.id)).toBe(true);
    }
  });

  it("reports the vault's answer for a keyless provider rather than papering over it", async () => {
    // The gate is `!requiresKey || hasKey` and it lives in one place
    // (`features/chat/header/model-catalogue.ts`). If this function returned `true`
    // for a keyless provider, the gate would have two sources of truth for one rule.
    const local = { ...provider("local-llamacpp"), requiresKey: false };
    const states = await providerKeyStates([local]);
    expect(states.get("local-llamacpp")).toBe(false);
  });
});

describe("Feature: zoc-agent-chat-rebuild, task 22.1: the badge refresh (R13.3)", () => {
  it("fires for a provider key and names the provider", () => {
    const seen = vi.fn();
    subscribeProviderKeys(seen);

    fireSecretChange("provider.anthropic.api_key");

    expect(seen).toHaveBeenCalledWith("anthropic");
  });

  it("ignores a secret that is not a provider key", () => {
    const seen = vi.fn();
    subscribeProviderKeys(seen);

    fireSecretChange("vault.master");
    fireSecretChange("provider.openai.other");
    fireSecretChange("api_key");

    // The badge holding still while an unrelated secret moves is the difference
    // between a filtered subscription and a re-render on every write.
    expect(seen).not.toHaveBeenCalled();
  });

  it("stops firing once unsubscribed", () => {
    const seen = vi.fn();
    const stop = subscribeProviderKeys(seen);

    stop();
    fireSecretChange("provider.groq.api_key");

    expect(seen).not.toHaveBeenCalled();
  });
});

describe("Feature: zoc-agent-chat-rebuild, task 22.1: AI SDK model ids (R13.1)", () => {
  it("lists Anthropic under the ids the AI SDK provider package takes", () => {
    const anthropic = BUILTIN_PROVIDERS.find((p) => p.id === "anthropic");
    const ids = anthropic?.models.map((m) => m.id) ?? [];

    expect(ids).toContain("claude-opus-5");
    expect(ids).toContain("claude-sonnet-5");
    // No `-latest` alias: the runtime's context-window table is keyed by the id in
    // this list, and an alias resolves to a different string there, which would
    // size the meter against the 8k default instead of the model's real window.
    expect(ids.some((id) => id.endsWith("-latest"))).toBe(false);
  });

  it("gives every built-in model a context window the meter can size against (R12.10)", () => {
    for (const builtin of BUILTIN_PROVIDERS) {
      for (const model of builtin.models) {
        expect(model.contextWindow, `${builtin.id}/${model.id}`).toBeGreaterThan(0);
      }
    }
  });
});
