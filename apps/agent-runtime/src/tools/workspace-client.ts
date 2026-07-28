/**
 * Workspace client — zoc-agent-chat-rebuild R6.1, R6.5, R6.6.
 *
 * Every call the runtime makes into Desktop_Core and Workspace_Services goes
 * through one wrapper, and the wrapper's job is a single conversion:
 *
 *   **a transport or service-unavailable failure becomes a tool *result*
 *   carrying `retryable: true`, never a thrown exception.**
 *
 * That is R6.6, and it is load-bearing rather than defensive. The runtime is a
 * long-lived process supervising a tool loop; a dead or restarting sidecar is an
 * ordinary condition, not an exceptional one. If it threw, one restarting
 * service would end the Run — and the user would lose a transcript for something
 * that resolved itself in 300 ms.
 *
 * The distinction the wrapper draws is between *the service could not answer*
 * (retryable) and *the service answered no* (not retryable). A 403 on a path
 * outside the workspace will be a 403 again on retry, so telling the model to
 * retry would be a loop; a connection refused will very likely succeed.
 */

import { ErrorCode } from "../http/errors.ts";

/** The `base_digest` sentinel for a file that did not exist (R10.15). */
export const ABSENT_DIGEST = "absent:0";

export type WorkspaceOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    };

/** HTTP statuses that mean "ask again later". */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 425, 429, 502, 503, 504]);

interface BridgeErrorBody {
  code?: string;
  message?: string;
}

export interface WorkspaceClientOptions {
  /** `ZOC_DESKTOP_BRIDGE_URL` — Desktop_Core's loopback bridge. */
  readonly bridgeUrl: string | null;
  /** `ZOC_WORKSPACE_SERVICES_URL` — the retained Python surface. */
  readonly servicesUrl: string | null;
  /** The per-launch bearer token, for the bridge only. */
  readonly token: string;
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
}

// ── Result shapes ─────────────────────────────────────────────────────────

export interface ReadResult {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly digest: string;
}

export type HunkAction = "create" | "modify" | "delete" | "rename";

export interface HunkFileRequest {
  readonly path: string;
  readonly action: HunkAction;
  readonly sourcePath?: string | null;
  readonly unifiedDiff?: string;
  readonly baseDigest?: string | null;
}

export interface AppliedFile {
  readonly path: string;
  readonly action: HunkAction;
  readonly created: boolean;
  readonly deleted: boolean;
  readonly bytesWritten: number;
}

export interface ApplyHunksResult {
  readonly planId: string;
  readonly applied: readonly AppliedFile[];
  readonly checkpointId: string | null;
}

export interface RunCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface ContextSearchHit {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly score: number;
  readonly text: string;
}

export class WorkspaceClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: WorkspaceClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * The one wrapper. Nothing in this class calls `fetch` directly.
   */
  private async call<T>(
    base: string | null,
    path: string,
    body: unknown,
    what: string,
    authenticate: boolean,
  ): Promise<WorkspaceOutcome<T>> {
    if (base === null || base.length === 0) {
      return {
        ok: false,
        code: ErrorCode.WORKSPACE_UNAVAILABLE,
        message: `${what} is not available: Zoc AI has not finished starting up.`,
        // Retryable: the endpoint arrives when the supervisor finishes its
        // handshake, which is a matter of milliseconds.
        retryable: true,
      };
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${base}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authenticate ? { authorization: `Bearer ${this.options.token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      // Connection refused, reset, DNS — the service is not answering.
      return {
        ok: false,
        code: ErrorCode.WORKSPACE_UNAVAILABLE,
        message: `${what} could not be reached. It may be restarting.`,
        retryable: true,
        ...(cause instanceof Error ? {} : {}),
      };
    }

    if (response.ok) {
      return { ok: true, value: (await response.json()) as T };
    }

    let envelope: BridgeErrorBody = {};
    try {
      envelope = (await response.json()) as BridgeErrorBody;
    } catch {
      /* a non-JSON error body is still an error, just an unlabelled one */
    }

    // 5xx and the explicit back-off statuses are transient; a 4xx is a refusal
    // that will be repeated.
    const retryable = response.status >= 500 || RETRYABLE_STATUSES.has(response.status);
    return {
      ok: false,
      code: envelope.code ?? (retryable ? ErrorCode.WORKSPACE_UNAVAILABLE : ErrorCode.INTERNAL),
      message: envelope.message ?? `${what} refused the request.`,
      retryable,
    };
  }

  /** Read one workspace file. Confined by Desktop_Core, not by the caller. */
  read(path: string): Promise<WorkspaceOutcome<ReadResult>> {
    return this.call(
      this.options.bridgeUrl,
      "/workspace/read",
      { path },
      "Reading a workspace file",
      true,
    );
  }

  /**
   * Apply a batch of hunks — **the single mutation path** (R10.16).
   *
   * All four `HunkAction`s ride this one call: a `create` is a hunk against a
   * non-existent path, a `delete` removes every line, a `rename` carries
   * `sourcePath` alongside the target. One call means one permission gate, one
   * out-of-plan-path check, and one checkpoint contract.
   */
  applyHunks(request: {
    planId: string;
    files: readonly HunkFileRequest[];
    checkpoint?: boolean;
  }): Promise<WorkspaceOutcome<ApplyHunksResult>> {
    return this.call(
      this.options.bridgeUrl,
      "/workspace/apply-hunks",
      {
        plan_id: request.planId,
        checkpoint: request.checkpoint ?? true,
        files: request.files.map((file) => ({
          path: file.path,
          action: file.action,
          source_path: file.sourcePath ?? null,
          unified_diff: file.unifiedDiff ?? "",
          base_digest: file.baseDigest ?? null,
        })),
      },
      "Applying workspace changes",
      true,
    );
  }

  runCommand(request: {
    command: string;
    args?: readonly string[];
    cwd?: string | null;
    timeoutMs?: number;
  }): Promise<WorkspaceOutcome<RunCommandResult>> {
    return this.call(
      this.options.bridgeUrl,
      "/workspace/run-command",
      {
        command: request.command,
        args: request.args ?? [],
        cwd: request.cwd ?? null,
        timeout_ms: request.timeoutMs ?? null,
      },
      "Running a command",
      true,
    );
  }

  /**
   * Semantic context search, against the retained Python index (R6.1).
   *
   * This one goes to Workspace_Services rather than the bridge, because the
   * index genuinely lives there — it is the one capability the Python surface
   * owns outright rather than one that migrated.
   */
  async contextSearch(
    sessionId: string,
    query: string,
    limit = 12,
  ): Promise<WorkspaceOutcome<readonly ContextSearchHit[]>> {
    const outcome = await this.call<{ results?: unknown[] }>(
      this.options.servicesUrl,
      `/v1/sessions/${encodeURIComponent(sessionId)}/index/query`,
      { query, limit },
      "Searching the workspace index",
      false,
    );
    if (!outcome.ok) return outcome;

    const hits = (outcome.value.results ?? []).map((raw) => {
      const row = raw as {
        chunk?: { file?: string; start_line?: number; end_line?: number; text?: string };
        score?: number;
      };
      return {
        path: row.chunk?.file ?? "",
        startLine: row.chunk?.start_line ?? 0,
        endLine: row.chunk?.end_line ?? 0,
        score: row.score ?? 0,
        text: row.chunk?.text ?? "",
      };
    });
    return { ok: true, value: hits };
  }
}

/** Build the client from the launch environment. */
export function workspaceClientFromEnv(
  env: NodeJS.ProcessEnv,
  token: string,
  fetchImpl?: typeof fetch,
): WorkspaceClient {
  return new WorkspaceClient({
    bridgeUrl: env.ZOC_DESKTOP_BRIDGE_URL ?? null,
    servicesUrl: env.ZOC_WORKSPACE_SERVICES_URL ?? null,
    token,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}
