/**
 * Workspace client — zoc-agent-chat-rebuild R6.1, R6.5, R6.6.
 *
 * Feature: zoc-agent-chat-rebuild, R6.1, R6.5, R6.6.
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
import { PathMutex } from "../agent/run-store.ts";

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

/** What a rollback restored (R10.6, R10.7). */
export interface RollbackResult {
  readonly checkpointId: string;
  /** Files restored — the figure the surface reports. A rename is one file. */
  readonly restoredFiles: number;
  /** Paths restored. A rename is two of them, so the two counts legitimately differ. */
  readonly restoredPaths: number;
}

/**
 * The bridge speaks snake_case, and every other result on this client happens to be
 * single-word.
 *
 * These two are not, so they are mapped explicitly rather than cast. The cast was the
 * original code and it was wrong in a way nothing would have noticed for a while:
 * `checkpoint_id` read as `checkpointId` is `undefined`, so an apply that *was*
 * checkpointed would have reported that it was not — and the surface renders that as
 * "this cannot be rolled back here" (R10.15).
 */
interface ApplyHunksWire {
  readonly plan_id?: string;
  readonly checkpoint_id?: string | null;
  readonly applied?: readonly {
    readonly path?: string;
    readonly action?: HunkAction;
    readonly created?: boolean;
    readonly deleted?: boolean;
    readonly bytes_written?: number;
  }[];
}

interface RollbackWire {
  readonly checkpoint_id?: string;
  readonly restored_files?: number;
  readonly restored_paths?: number;
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

/**
 * One discovered rule source, as `GET /v1/sessions/{id}/rules` returns it.
 *
 * Structurally the wire model `RuleDocument`, restated here rather than imported
 * from `@zoc/shared-types` so this module's shape matches the rest of the file
 * (every other result shape is local). `content: null` with `error` set is an
 * unreadable source, which the assembler skips with the reason recorded.
 */
export interface DiscoveredRule {
  readonly path: string;
  readonly content: string | null;
  readonly error: string | null;
}

/**
 * One recorded benchmark run, reduced to what the model picker reads.
 *
 * The Gateway's `ModelBenchmarkRun` carries eleven fields including a per-prompt
 * breakdown; three of them answer R13.11's question. Narrowing here rather than
 * forwarding the whole record keeps the runtime from having a second opinion about a
 * shape it does not own — and keeps a future field on the Python side from silently
 * becoming part of the runtime's wire contract.
 */
export interface BenchmarkRunSummary {
  readonly id: string;
  readonly createdAt: string;
  readonly averageTokensPerSecond: number | null;
}

export interface BenchmarkHistory {
  readonly modelId: string;
  /** Newest first, as `BenchmarkStore.history` returns them. */
  readonly runs: readonly BenchmarkRunSummary[];
}

export interface McpServerRuntime {
  readonly id: string;
  readonly transport: "stdio" | "sse" | "http";
  readonly scope: "user" | "workspace";
  readonly command: string | null;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly url: string | null;
  readonly disabled: boolean;
  readonly autoApprove: readonly string[];
  readonly status: "running" | "stopped" | "error";
  readonly errorReason: string | null;
}

export interface McpDiscoveredTool {
  readonly serverId: string;
  readonly bareName: string;
  /** Workspace_Services' transport name, used only for the proxied call. */
  readonly namespacedName: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly description: string | null;
}

export type McpTestOutcome =
  | {
      readonly outcome: "success";
      readonly toolCount: number;
      readonly bareNames: readonly string[];
    }
  | { readonly outcome: "validation-failure"; readonly reason: string }
  | { readonly outcome: "unsupported"; readonly transport: string }
  | { readonly outcome: "failure"; readonly reason: string };

export class WorkspaceClient {
  private readonly fetchImpl: typeof fetch;
  // Not a constructor parameter property: `--experimental-strip-types` cannot generate the
  // assignment one implies, so it is `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` at boot.
  private readonly options: WorkspaceClientOptions;
  /**
   * Serialises concurrent applies to the same file (R25.7, task 29.5).
   *
   * Owned by the client rather than passed in per Run, and that is the reason it
   * is correct: `composition.ts` builds exactly one `WorkspaceClient` per runtime
   * process and threads it into every Run's tool context, so a lock held here is
   * process-wide across Runs by construction — there is no wiring anyone can
   * forget, which is how it came to be missing in the first place.
   *
   * It has to be on this side. Desktop_Core's bridge serves **one thread per
   * connection** and `handle_apply_hunks` takes no lock, so two Runs applying at
   * once both read the file, both match `base_digest`, and both commit — the
   * second silently clobbering the first, with two transcripts each claiming to
   * describe the result. Serialising here closes that window: the loser now reads
   * the winner's bytes, its digest no longer matches, and it is refused with
   * `hunk_stale` through R10.8's existing path. One staleness mechanism, two
   * causes — which is why the lock only has to order, not detect.
   */
  private readonly applyLock = new PathMutex();

  constructor(options: WorkspaceClientOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * The one wrapper. Nothing in this class calls `fetch` directly.
   *
   * `body === undefined` means a GET: no `content-type`, no payload. Reads that
   * carry no arguments are GETs on the Python side (R30.1's rules discovery is
   * one), and forcing them through a POST would mean either inventing a body or
   * a second unwrapped `fetch` — and a second `fetch` is the thing this class
   * exists to prevent.
   *
   * `method` overrides that inference for the one route whose verb is neither:
   * the transcript replace is a `PUT`, because it is idempotent and replaces a
   * whole document (R15.6).
   */
  private async call<T>(
    base: string | null,
    path: string,
    body: unknown,
    what: string,
    authenticate: boolean,
    method?: "GET" | "POST" | "PUT",
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
        method: method ?? (body === undefined ? "GET" : "POST"),
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(authenticate ? { authorization: `Bearer ${this.options.token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
      // The taxonomy's two workspace codes, and they are two rather than one because
      // the surface treats them differently: `workspace_unavailable` renders a
      // tool-error row *with* a retry, `workspace_failed` renders one without. A
      // refusal offered as retryable is a button that fails identically every time.
      code:
        envelope.code ?? (retryable ? ErrorCode.WORKSPACE_UNAVAILABLE : ErrorCode.WORKSPACE_FAILED),
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
  async applyHunks(request: {
    planId: string;
    /** The Run this apply belongs to, so the checkpoint identifies it (R10.5). */
    runId?: string;
    files: readonly HunkFileRequest[];
    checkpoint?: boolean;
  }): Promise<WorkspaceOutcome<ApplyHunksResult>> {
    // A rename's source is written too — it is removed — so both of its paths are
    // locked, or two Runs renaming onto the same target would not contend.
    const paths = request.files.flatMap((file) =>
      file.sourcePath === null || file.sourcePath === undefined
        ? [file.path]
        : [file.path, file.sourcePath],
    );
    return this.applyLock.runAll(paths, () => this.applyHunksLocked(request));
  }

  private async applyHunksLocked(request: {
    planId: string;
    runId?: string;
    files: readonly HunkFileRequest[];
    checkpoint?: boolean;
  }): Promise<WorkspaceOutcome<ApplyHunksResult>> {
    const outcome = await this.call<ApplyHunksWire>(
      this.options.bridgeUrl,
      "/workspace/apply-hunks",
      {
        plan_id: request.planId,
        run_id: request.runId ?? "",
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
    if (!outcome.ok) return outcome;
    return {
      ok: true,
      value: {
        planId: outcome.value.plan_id ?? request.planId,
        checkpointId: outcome.value.checkpoint_id ?? null,
        applied: (outcome.value.applied ?? []).map((file) => ({
          path: file.path ?? "",
          action: file.action ?? "modify",
          created: file.created === true,
          deleted: file.deleted === true,
          bytesWritten: file.bytes_written ?? 0,
        })),
      },
    };
  }

  /**
   * Restore one checkpoint (R10.6, R10.7).
   *
   * Not a model-facing tool, deliberately: rolling back is the *user's* action on a
   * receipt, and offering it as a tool would let a Run undo a change the user had
   * accepted. It lives here because Desktop_Core owns the filesystem and the bridge is
   * the runtime's only way in — the surface reaches it through the Run that produced the
   * checkpoint.
   */
  async rollback(checkpointId: string): Promise<WorkspaceOutcome<RollbackResult>> {
    const outcome = await this.call<RollbackWire>(
      this.options.bridgeUrl,
      "/workspace/rollback",
      { checkpoint_id: checkpointId },
      "Rolling back an apply",
      true,
    );
    if (!outcome.ok) return outcome;
    return {
      ok: true,
      value: {
        checkpointId: outcome.value.checkpoint_id ?? checkpointId,
        restoredFiles: outcome.value.restored_files ?? 0,
        restoredPaths: outcome.value.restored_paths ?? 0,
      },
    };
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

  /**
   * Discovered project rules for a session (R30.1, R30.2).
   *
   * Goes to Workspace_Services because discovery and file reads belong where the
   * filesystem is — R6.3 keeps the `rules` capability there, and design.md's
   * assembler section is explicit that the runtime does not walk the tree
   * itself. What comes back is per-source contents, not the pre-merged `rules`
   * text the renderer displays, because ordering by convention precedence is the
   * runtime's job and a merged blob cannot be reordered.
   */
  async discoverRules(sessionId: string): Promise<WorkspaceOutcome<readonly DiscoveredRule[]>> {
    const outcome = await this.call<{ documents?: unknown[] }>(
      this.options.servicesUrl,
      `/v1/sessions/${encodeURIComponent(sessionId)}/rules`,
      undefined,
      "Reading the project rules",
      false,
    );
    if (!outcome.ok) return outcome;

    const documents = (outcome.value.documents ?? []).map((raw) => {
      const row = raw as { path?: unknown; content?: unknown; error?: unknown };
      return {
        path: typeof row.path === "string" ? row.path : "",
        content: typeof row.content === "string" ? row.content : null,
        error: typeof row.error === "string" ? row.error : null,
      };
    });
    return { ok: true, value: documents };
  }

  /**
   * One model's recorded benchmark history (R13.11).
   *
   * **The path was verified before this was written**, because 9.9 records that the
   * design specified the proxy against `BenchmarkStore.history`'s *signature* and never
   * confirmed an HTTP route — so assuming one was the single way the task could ship
   * broken. It is `GET /v1/model-benchmarks?modelId=<id>` in
   * `zocai_gateway/app.py`, admission-gated, answering `ModelBenchmarkHistory`.
   *
   * Unauthenticated for the same reason `discoverRules` is: the Gateway's
   * `require_admission` is a no-op on a loopback binding (R12.4), and the per-launch
   * token belongs to Desktop_Core's bridge rather than to the Python surface.
   *
   * An unknown model is a **200 with no runs**, not a 404 — `history` returns an empty
   * list for a model it has never seen — so "never measured" arrives here as data
   * rather than as a failure, which is what lets R13.12's no-figure case be
   * distinguished from a service that could not answer.
   */
  async benchmarkHistory(modelId: string): Promise<WorkspaceOutcome<BenchmarkHistory>> {
    const outcome = await this.call<{ modelId?: unknown; runs?: unknown[] }>(
      this.options.servicesUrl,
      `/v1/model-benchmarks?modelId=${encodeURIComponent(modelId)}`,
      undefined,
      "Reading the model benchmark history",
      false,
    );
    if (!outcome.ok) return outcome;

    const runs = (outcome.value.runs ?? []).map((raw) => {
      const row = raw as { id?: unknown; createdAt?: unknown; averageTokensPerSecond?: unknown };
      return {
        id: typeof row.id === "string" ? row.id : "",
        createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
        averageTokensPerSecond:
          typeof row.averageTokensPerSecond === "number" &&
          Number.isFinite(row.averageTokensPerSecond)
            ? row.averageTokensPerSecond
            : null,
      };
    });
    return {
      ok: true,
      value: {
        modelId: typeof outcome.value.modelId === "string" ? outcome.value.modelId : modelId,
        runs,
      },
    };
  }

  // ── MCP brokerage (R26) ────────────────────────────────────────────────

  async mcpServers(): Promise<WorkspaceOutcome<readonly McpServerRuntime[]>> {
    const outcome = await this.call<{ servers?: McpServerRuntime[] }>(
      this.options.servicesUrl,
      "/v1/mcp/servers",
      undefined,
      "Reading MCP server state",
      false,
    );
    if (!outcome.ok) return outcome;
    return { ok: true, value: outcome.value.servers ?? [] };
  }

  async mcpTools(): Promise<WorkspaceOutcome<readonly McpDiscoveredTool[]>> {
    const outcome = await this.call<{ tools?: McpDiscoveredTool[] }>(
      this.options.servicesUrl,
      "/v1/mcp/tools",
      undefined,
      "Discovering MCP tools",
      false,
    );
    if (!outcome.ok) return outcome;
    return { ok: true, value: outcome.value.tools ?? [] };
  }

  async reloadMcp(): Promise<WorkspaceOutcome<readonly McpServerRuntime[]>> {
    const outcome = await this.call<{ servers?: McpServerRuntime[] }>(
      this.options.servicesUrl,
      "/v1/mcp/reload",
      {},
      "Reloading MCP servers",
      false,
    );
    if (!outcome.ok) return outcome;
    return { ok: true, value: outcome.value.servers ?? [] };
  }

  async testMcp(candidate: Record<string, unknown>): Promise<WorkspaceOutcome<McpTestOutcome>> {
    return this.call<McpTestOutcome>(
      this.options.servicesUrl,
      "/v1/mcp/test",
      candidate,
      "Testing an MCP server",
      false,
    );
  }

  async callMcp(
    sourceName: string,
    arguments_: Record<string, unknown>,
  ): Promise<WorkspaceOutcome<Record<string, unknown>>> {
    const outcome = await this.call<{
      ok?: boolean;
      result?: Record<string, unknown>;
      code?: string;
      message?: string;
      retryable?: boolean;
    }>(
      this.options.servicesUrl,
      "/v1/mcp/call",
      { name: sourceName, arguments: arguments_ },
      `Calling MCP tool ${sourceName}`,
      false,
    );
    if (!outcome.ok) return outcome;
    if (outcome.value.ok === true) return { ok: true, value: outcome.value.result ?? {} };
    return {
      ok: false,
      code: outcome.value.code ?? "mcp_failed",
      message: outcome.value.message ?? "The MCP tool failed.",
      retryable: outcome.value.retryable === true,
    };
  }

  // ── Transcript persistence (R15.6) ──────────────────────────────────────
  //
  // The pair that closes the history gap. Until these routes existed the
  // `loadHistory` port answered `[]` and every Run was single-turn — stated in
  // `composition.ts`'s header rather than discovered from a user's transcript.
  //
  // Both are unauthenticated for the same reason `discoverRules` is: the
  // Gateway's `require_admission` is a no-op on a loopback binding (R12.4), and
  // the per-launch token belongs to Desktop_Core's bridge.

  /**
   * A Session's stored transcript, oldest first.
   *
   * The records are returned unparsed. They are AI SDK `UIMessage` documents and
   * the runtime hands them straight back to `createUIMessageStream` as
   * `originalMessages`; typing them here would mean re-declaring the Chat_Surface's
   * part union in a third place, and the two that already declare it are enough.
   */
  async listMessages(sessionId: string): Promise<WorkspaceOutcome<readonly unknown[]>> {
    const outcome = await this.call<{ messages?: unknown[] }>(
      this.options.servicesUrl,
      `/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      undefined,
      "Reading the session transcript",
      false,
    );
    if (!outcome.ok) return outcome;
    return { ok: true, value: outcome.value.messages ?? [] };
  }

  /**
   * Replace a Session's transcript with a completed Run's messages (R15.6).
   *
   * A replace rather than an append because `onFinish` hands over the *complete*
   * conversation: appending it would double every prior turn. Idempotent, so a
   * retry after a transport failure cannot corrupt the transcript — which is what
   * makes it safe for the persistence path to be retried at all.
   */
  async replaceMessages(
    sessionId: string,
    messages: readonly unknown[],
  ): Promise<WorkspaceOutcome<readonly unknown[]>> {
    const outcome = await this.call<{ messages?: unknown[] }>(
      this.options.servicesUrl,
      `/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      { messages },
      "Saving the session transcript",
      false,
      "PUT",
    );
    if (!outcome.ok) return outcome;
    return { ok: true, value: outcome.value.messages ?? [] };
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
