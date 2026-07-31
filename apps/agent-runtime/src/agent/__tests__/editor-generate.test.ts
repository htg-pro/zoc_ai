/**
 * The editor generator — zoc-agent-chat-rebuild R6.2, R7.8, R13.5, task 22.11's prerequisite.
 *
 * The gap this closes is the interesting part of the file. 9.7 shipped the two editor routes with a
 * generator that always threw, on the stated grounds that the runtime is never told which model to ask.
 * It is: `editor-routes.ts`'s `modelSelection` puts `provider` and `model` on both bodies, and only the
 * credential is withheld. So the assertions below are mostly about the two halves of that split — the
 * request names the model, the vault supplies the key — plus the one case where throwing is still right.
 */

import { describe, expect, it, vi } from "vitest";

import { createEditorGenerator } from "../editor-generate.ts";
import { EmptySecretSource, type SecretSource } from "../../providers/keys.ts";
import type { EditorGenerateRequest } from "../../http/editor-routes.ts";

// ── Fixtures ──────────────────────────────────────────────────────────

function request(overrides: Partial<EditorGenerateRequest> = {}): EditorGenerateRequest {
  return {
    prompt: "complete this",
    provider: "openai",
    modelId: "gpt-5",
    temperature: 0.1,
    maxOutputTokens: 128,
    stopSequences: ["\n\n"],
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** A source holding one key, so a read can be asserted rather than assumed. */
function sourceWith(key: string): SecretSource {
  return { get: vi.fn().mockResolvedValue(key) };
}

/** A `streamText` stand-in that records its options and yields the given deltas. */
function fakeStream(deltas: readonly string[]) {
  const calls: Record<string, unknown>[] = [];
  const impl = ((options: Record<string, unknown>) => {
    calls.push(options);
    return {
      textStream: (async function* text() {
        for (const delta of deltas) yield delta;
      })(),
    };
  }) as unknown as EditorGeneratorStream;
  return { impl, calls };
}

type EditorGeneratorStream = NonNullable<
  Parameters<typeof createEditorGenerator>[0]["streamImpl"]
>;

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

describe("Feature: zoc-agent-chat-rebuild, task 22.11: the editor generator resolves its own key (R7.8)", () => {
  it("reads the key from the vault for the provider the request names", async () => {
    const secrets = sourceWith("sk-live-key");
    const { impl, calls } = fakeStream(["const ", "x = 1"]);
    const generate = createEditorGenerator({ secrets, streamImpl: impl });

    expect(await collect(generate(request()))).toEqual(["const ", "x = 1"]);
    // One read, of the provider-scoped name — never a key from the request body, which has no field
    // for one by construction.
    expect(secrets.get).toHaveBeenCalledTimes(1);
    expect(secrets.get).toHaveBeenCalledWith("provider.openai.api_key");
    expect(calls).toHaveLength(1);
  });

  it("passes the route's own sampling settings straight through", async () => {
    const { impl, calls } = fakeStream(["ok"]);
    const generate = createEditorGenerator({ secrets: sourceWith("sk-live-key"), streamImpl: impl });
    const signal = new AbortController().signal;

    await collect(
      generate(
        request({ temperature: 0.4, maxOutputTokens: 512, stopSequences: ["\n\n", "```"], signal }),
      ),
    );

    expect(calls[0]).toMatchObject({
      prompt: "complete this",
      temperature: 0.4,
      maxOutputTokens: 512,
      stopSequences: ["\n\n", "```"],
      abortSignal: signal,
    });
  });

  it("omits stopSequences entirely for inline edit, which must not truncate on a blank line", async () => {
    const { impl, calls } = fakeStream(["ok"]);
    const generate = createEditorGenerator({ secrets: sourceWith("sk-live-key"), streamImpl: impl });

    await collect(generate(request({ stopSequences: [] })));
    // Absent rather than `[]`: a replacement may legitimately contain a blank line.
    expect(calls[0]).not.toHaveProperty("stopSequences");
  });

  it("needs no key for a local model, and resolves it against the loopback default (R13.5)", async () => {
    const secrets = new EmptySecretSource();
    const { impl, calls } = fakeStream(["local"]);
    const generate = createEditorGenerator({ secrets, streamImpl: impl });

    expect(
      await collect(generate(request({ provider: "local-llamacpp", modelId: "qwen3-coder" }))),
    ).toEqual(["local"]);
    // The editor bodies carry no `baseUrl`, so a request cannot redirect a local model off loopback.
    expect(calls).toHaveLength(1);
  });
});

describe("Feature: zoc-agent-chat-rebuild, task 22.11: what the generator refuses", () => {
  const attempt = async (overrides: Partial<EditorGenerateRequest>): Promise<Error | null> => {
    const { impl } = fakeStream(["unreachable"]);
    const generate = createEditorGenerator({ secrets: sourceWith("sk-live-key"), streamImpl: impl });
    try {
      await collect(generate(request(overrides)));
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause : new Error(String(cause));
    }
  };

  it.each([
    ["no provider", { provider: null }],
    ["an empty provider", { provider: "  " }],
    ["the mock provider", { provider: "mock" }],
    ["no model", { modelId: null }],
    ["an empty model", { modelId: "  " }],
  ])("throws for %s, which the route turns into one quiet done", async (_label, overrides) => {
    const failure = await attempt(overrides);
    expect(failure?.message).toBe("No editor model is selected.");
  });

  it("surfaces no_key_configured for a cloud provider with an empty vault", async () => {
    const { impl, calls } = fakeStream(["unreachable"]);
    const generate = createEditorGenerator({
      secrets: new EmptySecretSource(),
      streamImpl: impl,
    });

    await expect(collect(generate(request()))).rejects.toThrow(/API key/u);
    // Never reached the model: a missing key is refused before a provider call is made, which is what
    // keeps a keystroke from costing a request that cannot succeed.
    expect(calls).toHaveLength(0);
  });

  it("does not read the vault at all when no model is selected", async () => {
    const secrets = sourceWith("sk-live-key");
    const { impl } = fakeStream(["unreachable"]);
    const generate = createEditorGenerator({ secrets, streamImpl: impl });

    await expect(collect(generate(request({ provider: null })))).rejects.toThrow();
    expect(secrets.get).not.toHaveBeenCalled();
  });

  it("holds no key between requests", async () => {
    const secrets = sourceWith("sk-live-key");
    const { impl } = fakeStream(["ok"]);
    const generate = createEditorGenerator({ secrets, streamImpl: impl });

    await collect(generate(request()));
    await collect(generate(request()));
    // Once per request, not once per generator: the credential lives in one local binding for the
    // length of one completion (5.2's discipline).
    expect(secrets.get).toHaveBeenCalledTimes(2);
  });
});
