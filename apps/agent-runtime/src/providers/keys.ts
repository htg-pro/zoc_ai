/**
 * Per-Run provider key resolution and structural log redaction —
 * zoc-agent-chat-rebuild R13.4, R13.7, R14.10.
 *
 * Two guarantees, and the second one is why this is a module rather than a
 * function:
 *
 *   1. **One key per Run, in a local binding.** `resolveKey` returns a value the
 *      caller holds for the Run's lifetime and drops. Nothing here caches into
 *      module scope, so there is no long-lived credential for a later bug to
 *      find and no cache to invalidate when the user rotates a key.
 *   2. **Redaction is structural, not best-effort.** The logger is *constructed*
 *      with a serialiser that replaces the resolved key wherever it appears in a
 *      payload. "Remember not to log the key" is not a guarantee; a serialiser
 *      that cannot emit it is.
 *
 * ## Why a loopback key service rather than a Tauri command
 *
 * The design specifies `desktopCore.secretGet(...)` and names
 * `runtime_secret_get(key, token)` as the command behind it, but a Tauri command
 * is invocable only from the webview — and this runtime is a separate OS process.
 * The transport therefore has to be something the runtime can actually speak.
 *
 * It is a loopback HTTP endpoint on Desktop_Core, authenticated with the *same*
 * per-launch token the runtime already holds, reached at
 * `ZOC_DESKTOP_KEY_URL`. That reuses the credential and the trust boundary
 * already established by the port handshake rather than inventing a second one.
 * The alternative — passing keys in the child environment at spawn — was
 * rejected: keys change while the app is running, and an environment handoff
 * would either go stale or force the runtime to cache credentials in memory,
 * which is exactly what guarantee (1) exists to avoid.
 */

import { ErrorCode, HttpError, envelope } from "../http/errors.ts";
import { providerSpec } from "./registry.ts";

/** The marker a redacted value is replaced with. */
export const REDACTION = "«redacted»";

/**
 * Credential prefixes worth catching on shape alone.
 *
 * Shape matching is a second line, not the primary one: the primary defence is
 * byte-identity against the key this Run actually resolved. These prefixes catch
 * the case that identity cannot — a key belonging to a *different* provider
 * appearing in a payload, for instance because a provider echoed the
 * `Authorization` header back inside an error body.
 */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgsk_[A-Za-z0-9_-]{16,}/g,
  /\bxai-[A-Za-z0-9_-]{16,}/g,
  /\bAIza[A-Za-z0-9_-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
];

/** The keychain key format. Retained verbatim so existing saved keys resolve (R23). */
export function secretKeyName(providerId: string): string {
  return `provider.${providerId}.api_key`;
}

/**
 * Where a key can be fetched from. An interface so a test can supply one
 * without a Desktop_Core process, and so the transport above is swappable.
 */
export interface SecretSource {
  get(name: string): Promise<string | null>;
}

export class DesktopCoreSecretSource implements SecretSource {
  // Declared and assigned rather than written as constructor parameter properties:
  // `--experimental-strip-types` erases types without transforming, so a parameter
  // property is `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` at boot even though `tsc` accepts it.
  private readonly endpoint: string;
  private readonly token: string;

  constructor(endpoint: string, token: string) {
    this.endpoint = endpoint;
    this.token = token;
  }

  async get(name: string): Promise<string | null> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ key: name }),
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      // No response body in the message: a key service error body could carry
      // the very thing this module exists to keep out of logs.
      throw new HttpError(
        502,
        envelope(ErrorCode.INTERNAL, "Zoc AI could not reach the secure key store.", {
          retryable: true,
        }),
      );
    }
    const body = (await response.json()) as { value?: string | null };
    const value = body.value ?? null;
    return value !== null && value.length > 0 ? value : null;
  }
}

/** A source that has nothing, for local-only runs and for tests. */
export class EmptySecretSource implements SecretSource {
  async get(): Promise<string | null> {
    return null;
  }
}

/**
 * Build the secret source from the launch environment.
 *
 * Falls back to `EmptySecretSource` rather than throwing when the key URL is
 * absent: a runtime launched without one can still serve `local-llamacpp`, and
 * refusing to start would take local models down for a cloud-only problem. A
 * cloud Run then fails with `no_key_configured`, which is the accurate error.
 */
export function secretSourceFromEnv(env: NodeJS.ProcessEnv): SecretSource {
  const endpoint = env.ZOC_DESKTOP_KEY_URL;
  const token = env.ZOC_RUNTIME_TOKEN_FOR_KEYS ?? env.ZOC_RUNTIME_TOKEN;
  if (!endpoint || !token) return new EmptySecretSource();
  return new DesktopCoreSecretSource(endpoint, token);
}

/**
 * Resolve the provider key for one Run.
 *
 * Returns `null` for a provider that needs no key (R13.4), which is not an
 * error — it is the local path, and treating a missing key as a failure there
 * would break the zero-key offline guarantee.
 */
export async function resolveKey(providerId: string, source: SecretSource): Promise<string | null> {
  const spec = providerSpec(providerId);
  if (!spec.requiresKey) return null;
  return source.get(secretKeyName(providerId));
}

// ── Redaction ─────────────────────────────────────────────────────────────

function redactString(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join(REDACTION);
  }
  for (const shape of CREDENTIAL_SHAPES) {
    out = out.replace(shape, REDACTION);
  }
  return out;
}

/**
 * Recursively redact a log payload.
 *
 * Object *keys* are redacted too, not just values. A payload shaped
 * `{ "sk-live-…": "used" }` is unusual but not impossible — it is what a naive
 * `Object.fromEntries` over a header map produces — and a redactor that only
 * walks values would pass it straight through.
 */
export function redactValue(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (depth > 8) return "«depth-limit»";
  if (typeof value === "string") return redactString(value, secrets);
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, secrets, depth + 1));
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message, secrets),
      // No stack: a stack can carry a URL with a query-string credential, and a
      // redacted stack is not worth the surface.
    };
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[redactString(key, secrets)] = redactValue(item, secrets, depth + 1);
    }
    return out;
  }
  // Functions, symbols, bigints: never logged as themselves.
  return String(typeof value);
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface RunLogger {
  log(level: LogLevel, message: string, payload?: unknown): void;
  /** Register another value to redact — e.g. a second key for a sub-agent. */
  protect(secret: string | null): void;
}

export interface LogSink {
  (line: string): void;
}

/**
 * Construct a logger that cannot emit the Run's key.
 *
 * The secret list is captured in the closure and consulted on every call, so a
 * key registered after construction — a sub-agent resolving its own — is covered
 * from that moment on.
 */
export function createRunLogger(options: {
  runId: string;
  key?: string | null;
  sink?: LogSink;
}): RunLogger {
  const secrets: string[] = [];
  const protect = (secret: string | null | undefined) => {
    if (secret && secret.length >= 8 && !secrets.includes(secret)) secrets.push(secret);
  };
  protect(options.key);

  // stderr, not stdout: stdout is the port-line protocol channel the supervisor
  // parses, and a log line on it would corrupt the handshake.
  const sink = options.sink ?? ((line: string) => process.stderr.write(`${line}\n`));

  return {
    protect,
    log(level, message, payload) {
      const record = {
        ts: new Date().toISOString(),
        level,
        runId: options.runId,
        message: redactString(message, secrets),
        ...(payload === undefined ? {} : { payload: redactValue(payload, secrets) }),
      };
      sink(JSON.stringify(record));
    },
  };
}
