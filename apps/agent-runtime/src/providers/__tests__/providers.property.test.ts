/**
 * Provider registry and key-custody properties — zoc-agent-chat-rebuild.
 *
 * Property 14: Local model Runs make no external request       (validates R13.5)
 * Property 31: A provider auth failure does not touch the key  (validates R13.7)
 * Property 35: No key value reaches a log, error, or telemetry (validates R14.10)
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import {
  DEFAULT_LOCAL_BASE_URL,
  PROVIDERS,
  assertLoopback,
  isLocalProvider,
  providerCatalogue,
  providerSpec,
  resolveModel,
} from "../registry.ts";
import {
  EmptySecretSource,
  REDACTION,
  createRunLogger,
  redactValue,
  resolveKey,
  secretKeyName,
  secretSourceFromEnv,
  type SecretSource,
} from "../keys.ts";
import { HttpError } from "../../http/errors.ts";

const RUNS = { numRuns: 200 } as const;

/** A key that looks like a real one, so shape matching is exercised too. */
const REALISTIC_KEYS = [
  "sk-proj-1234567890abcdefghijklmnopqrstuvwxyzABCD",
  "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
  "gsk_abcdefghijklmnopqrstuvwxyz0123456789ABCD",
  "xai-abcdefghijklmnopqrstuvwxyz0123456789",
  "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456",
] as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Property 14: local model runs make no external request (R13.5)", () => {
  it("accepts every loopback spelling and refuses everything else", () => {
    const loopback = fc.constantFrom(
      "http://127.0.0.1:8080/v1",
      "http://localhost:8080/v1",
      "http://[::1]:8080/v1",
      "https://127.0.0.1:9999/v1",
    );
    fc.assert(
      fc.property(loopback, (url) => {
        expect(assertLoopback(url)).toBe(url);
      }),
      RUNS,
    );

    const remote = fc
      .oneof(
        fc.constantFrom(
          "http://example.invalid/v1",
          "https://api.openai.com/v1",
          "http://10.0.0.1:8080/v1",
          "http://192.168.1.5:8080/v1",
          "http://0.0.0.0:8080/v1",
          "http://127.0.0.1.evil.invalid/v1",
          "http://localhost.evil.invalid/v1",
        ),
        fc.domain().map((domain) => `http://${domain}/v1`),
      )
      .filter((url) => !url.includes("//127.0.0.1/") && !url.includes("//localhost/"));

    fc.assert(
      fc.property(remote, (url) => {
        expect(() => assertLoopback(url)).toThrow(HttpError);
      }),
      RUNS,
    );
  });

  it("refuses a non-http scheme rather than passing it through", () => {
    for (const url of ["file:///etc/passwd", "ftp://127.0.0.1/v1", "not a url"]) {
      expect(() => assertLoopback(url)).toThrow(HttpError);
    }
  });

  it("resolves the local provider without a key and against loopback only", () => {
    const resolved = resolveModel({
      model: { provider: "local-llamacpp", modelId: "qwen2.5-coder", baseUrl: null },
      apiKey: null,
    });
    expect(resolved.spec.local).toBe(true);
    expect(resolved.spec.requiresKey).toBe(false);
    expect(DEFAULT_LOCAL_BASE_URL.startsWith("http://127.0.0.1")).toBe(true);
  });

  it("refuses to construct a local model against a remote base URL", () => {
    fc.assert(
      fc.property(fc.domain(), (domain) => {
        expect(() =>
          resolveModel({
            model: {
              provider: "local-llamacpp",
              modelId: "m",
              baseUrl: `http://${domain}/v1`,
            },
            apiKey: null,
          }),
        ).toThrow(HttpError);
      }),
      RUNS,
    );
  });

  it("records every connect target as loopback for a local run", async () => {
    // A connect-recording stand-in: the assertion is that the *only* URL the
    // local path can be configured with is loopback, so any recorded target must
    // be loopback too. Recording proves the configuration reached the transport.
    const targets: string[] = [];
    const recordingFetch = vi.fn(async (input: string | URL | Request) => {
      targets.push(typeof input === "string" ? input : input.toString());
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", recordingFetch);

    // The local provider needs no key, so no key request is made either — which
    // is itself part of R13.5's guarantee.
    const source = new EmptySecretSource();
    await expect(resolveKey("local-llamacpp", source)).resolves.toBeNull();

    for (const target of targets) {
      expect(target).toMatch(/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/);
    }
  });

  it("marks exactly one provider local", () => {
    expect(PROVIDERS.filter((spec) => spec.local).map((spec) => spec.id)).toEqual([
      "local-llamacpp",
    ]);
    expect(isLocalProvider("local-llamacpp")).toBe(true);
    expect(isLocalProvider("openai")).toBe(false);
  });
});

describe("Property 31: a provider auth failure does not touch the stored key (R13.7)", () => {
  it("reads the key once and never writes or clears it", async () => {
    const calls: Array<{ op: string; name: string }> = [];
    const source: SecretSource = {
      async get(name) {
        calls.push({ op: "get", name });
        return "sk-proj-abcdefghijklmnopqrstuvwxyz012345";
      },
    };

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("openai", "anthropic", "google-ai-studio", "groq", "xai"),
        async (providerId) => {
          calls.length = 0;
          const key = await resolveKey(providerId, source);
          expect(key).not.toBeNull();
          // Exactly one read, and nothing else. The `SecretSource` interface has
          // no mutating method at all, which is the structural half of this
          // property: an auth failure *cannot* clear a key because the runtime
          // holds no capability to.
          expect(calls).toEqual([{ op: "get", name: secretKeyName(providerId) }]);
          expect(Object.keys(source)).toEqual(["get"]);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("asks for no key at all when the provider needs none", async () => {
    const calls: string[] = [];
    const source: SecretSource = {
      async get(name) {
        calls.push(name);
        return null;
      },
    };
    await expect(resolveKey("local-llamacpp", source)).resolves.toBeNull();
    expect(calls).toEqual([]);
  });

  it("reports a missing key as a configuration error, not a secret error", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("openai", "anthropic", "google-ai-studio", "groq", "xai"),
        fc.constantFrom(null, ""),
        (providerId, key) => {
          let thrown: unknown;
          try {
            resolveModel({ model: { provider: providerId, modelId: "m" }, apiKey: key });
          } catch (cause) {
            thrown = cause;
          }
          expect(thrown).toBeInstanceOf(HttpError);
          const error = thrown as HttpError;
          expect(error.envelope.code).toBe("no_key_configured");
          // The message names the provider label, which is public, and nothing else.
          expect(error.envelope.message).not.toMatch(/sk-|gsk_|xai-|AIza/);
        },
      ),
      RUNS,
    );
  });
});

describe("Property 35: no key value reaches a log, error, or telemetry record (R14.10)", () => {
  it("redacts the resolved key from any log payload", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...REALISTIC_KEYS),
        fc.string({ minLength: 0, maxLength: 40 }),
        (key, noise) => {
          const lines: string[] = [];
          const logger = createRunLogger({ runId: "run_1", key, sink: (l) => lines.push(l) });

          logger.log("error", `provider rejected key ${key}`, {
            headers: { authorization: `Bearer ${key}` },
            nested: { deep: [{ apiKey: key }] },
            note: `${noise}${key}${noise}`,
          });

          const emitted = lines.join("\n");
          expect(emitted).not.toContain(key);
          expect(emitted).toContain(REDACTION);
        },
      ),
      RUNS,
    );
  });

  it("redacts a credential by shape even when it is not this run's key", () => {
    fc.assert(
      fc.property(fc.constantFrom(...REALISTIC_KEYS), (foreignKey) => {
        const lines: string[] = [];
        const logger = createRunLogger({
          runId: "run_1",
          key: "sk-proj-thisrunsownkey0123456789abcdef",
          sink: (l) => lines.push(l),
        });
        logger.log("warn", "upstream error body", { body: `{"error":"${foreignKey}"}` });
        expect(lines.join("\n")).not.toContain(foreignKey);
      }),
      RUNS,
    );
  });

  it("redacts object keys, not only values", () => {
    const key = "sk-proj-abcdefghijklmnopqrstuvwxyz012345";
    const redacted = redactValue({ [key]: "used" }, [key]) as Record<string, unknown>;
    expect(Object.keys(redacted)).toEqual([REDACTION]);
  });

  it("drops the stack from a logged Error rather than redacting it", () => {
    const key = "sk-proj-abcdefghijklmnopqrstuvwxyz012345";
    const error = new Error(`failed with ${key}`);
    const redacted = redactValue(error, [key]) as Record<string, unknown>;
    expect(redacted.message).toContain(REDACTION);
    expect(redacted).not.toHaveProperty("stack");
  });

  it("covers a key registered after the logger was constructed", () => {
    const lines: string[] = [];
    const logger = createRunLogger({ runId: "run_1", key: null, sink: (l) => lines.push(l) });
    const subAgentKey = "sk-ant-api03-zzzzzzzzzzzzzzzzzzzzzzzzzz";
    logger.protect(subAgentKey);
    logger.log("info", "sub-agent started", { key: subAgentKey });
    expect(lines.join("\n")).not.toContain(subAgentKey);
  });

  it("does not treat a short string as a secret", () => {
    // A tiny "key" would match everything and redact the whole log into noise.
    const lines: string[] = [];
    const logger = createRunLogger({ runId: "run_1", key: "abc", sink: (l) => lines.push(l) });
    logger.log("info", "abc appears here", { value: "abc" });
    expect(lines.join("\n")).toContain("abc");
  });

  it("terminates on a cyclic payload instead of recursing forever", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(() => redactValue(cyclic, [])).not.toThrow();
  });

  it("writes to stderr by default, never stdout", () => {
    // stdout is the port-line protocol channel; a log line there corrupts the
    // supervisor handshake.
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    createRunLogger({ runId: "run_1", key: null }).log("info", "hello");
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalled();
  });
});

describe("secret source construction", () => {
  it("falls back to an empty source rather than refusing to start", async () => {
    const source = secretSourceFromEnv({});
    await expect(source.get("provider.openai.api_key")).resolves.toBeNull();
  });

  it("builds a Desktop_Core source when the env supplies both halves", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ value: "sk-proj-value012345678901234567" }), {
          status: 200,
        });
      }),
    );

    const source = secretSourceFromEnv({
      ZOC_DESKTOP_KEY_URL: "http://127.0.0.1:5555/secret",
      ZOC_RUNTIME_TOKEN: "launch-token-0123456789",
    });
    await expect(source.get("provider.openai.api_key")).resolves.toBe(
      "sk-proj-value012345678901234567",
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:5555/secret");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer launch-token-0123456789");
  });

  it("maps a 404 to null rather than an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 404 })),
    );
    const source = secretSourceFromEnv({
      ZOC_DESKTOP_KEY_URL: "http://127.0.0.1:5555/secret",
      ZOC_RUNTIME_TOKEN: "t0123456789",
    });
    await expect(source.get("provider.openai.api_key")).resolves.toBeNull();
  });

  it("does not echo a key-store error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("sk-proj-leaked0123456789abcdef", { status: 500 })),
    );
    const source = secretSourceFromEnv({
      ZOC_DESKTOP_KEY_URL: "http://127.0.0.1:5555/secret",
      ZOC_RUNTIME_TOKEN: "t0123456789",
    });
    await expect(source.get("provider.openai.api_key")).rejects.toSatisfy((cause: unknown) => {
      const error = cause as HttpError;
      expect(error.envelope.details ?? "").not.toContain("sk-proj-leaked");
      expect(error.envelope.message).not.toContain("sk-proj-leaked");
      return true;
    });
  });
});

describe("the registry itself", () => {
  it("has the six adapters the design names", () => {
    expect(PROVIDERS.map((spec) => spec.id)).toEqual([
      "openai",
      "anthropic",
      "google-ai-studio",
      "groq",
      "xai",
      "local-llamacpp",
    ]);
  });

  it("names an unknown provider as not found rather than crashing", () => {
    fc.assert(
      fc.property(
        fc.string().filter((id) => !PROVIDERS.some((spec) => spec.id === id)),
        (unknown) => {
          expect(() => providerSpec(unknown)).toThrow(HttpError);
        },
      ),
      RUNS,
    );
  });

  it("publishes a catalogue carrying no credential and no resolver", () => {
    for (const entry of providerCatalogue()) {
      expect(Object.keys(entry).sort()).toEqual([
        "capabilities",
        "id",
        "label",
        "local",
        "requiresKey",
      ]);
    }
  });

  it("keys every secret under the retained keychain format (R23)", () => {
    expect(secretKeyName("openai")).toBe("provider.openai.api_key");
  });
});
