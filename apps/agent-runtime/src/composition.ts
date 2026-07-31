/**
 * The composition root — zoc-agent-chat-rebuild §10's checkpoint.
 *
 * Everything §5 through §9 built, wired into one route table. Nothing here decides
 * policy or holds behaviour: it constructs the objects, hands each route module its
 * deps, and answers `buildRoutes`. That is deliberate and it is why this file is late
 * — the modules were written against ports precisely so that this could be the only
 * place that knows they all exist.
 *
 * **Why it exists as a separate module rather than inside `main.ts`.** `main.ts` owns
 * the process: the port line, the token scrub, the throw-to-envelope conversion. It
 * takes `route` as an option so the handshake test can drive admission without a
 * provider, and folding thirty constructions into it would make that seam a lie. So
 * `main.ts` calls `defaultRoute` and this file builds the rest.
 *
 * **One Run's objects are per-Run, and that is most of the work below.** A Run needs
 * its own approval registry, grant ledger, audit log, plan approval state, permission
 * gate, tool registry, and writer — because each of those is scoped to the Run by a
 * requirement: grants expire with it (R11.7), plan approval is never inherited
 * (R32.9), and the gate closes over the writer that numbers parts in this Run's `seq`
 * space (R7.7). The only things that outlive a Run are the store, the Slot manager,
 * the audit log, and the completion cache.
 *
 * ## The history gap, closed
 *
 * This header used to record a gap: the design has the runtime **rehydrate history
 * from Workspace_Services** so a 500-message Session does not re-upload every turn
 * (design.md:1337), and that endpoint did not exist. `SessionRegistry` held
 * `Session` metadata in a dict with no transcript, `listMessages` would have 404'd,
 * and the consequences were exact — every Run single-turn, compaction never
 * triggering, `messagesOutOfWindow` reading 0.
 *
 * The endpoint exists now: `GET`/`PUT /v1/sessions/{id}/messages` over a durable
 * per-Session store (`zocai_gateway/transcripts.py`). {@link RuntimeDeps.loadTranscript}
 * defaults to it, `transcript-history.ts` converts in both directions, and
 * `RunContext.persistence` is supplied, so a completed Run is written down instead
 * of being read once and lost. A test still injects its own port and gets its own
 * history with no sidecar in sight.
 *
 * What a read failure costs is stated where it is handled rather than here: the
 * Run starts single-turn and says so in the log. A *write* failure costs the
 * transcript and not the answer — the alternative, failing a Run because a
 * restarting sidecar refused a write, would lose something the user already read.
 */

import { streamRun, type RunContext } from "./agent/build-agent.ts";
import { createEditorGenerator } from "./agent/editor-generate.ts";
import { CompletionCache } from "./agent/editor-inference.ts";
import { createRunErrorClassifier } from "./agent/error-taxonomy.ts";
import { createTokenRateMeter } from "./agent/token-rate.ts";
import { RunManager, type OpenRunStream } from "./agent/run-driver.ts";
import { RunStore, SlotManager } from "./agent/run-store.ts";
import { assembleInstructions, discoverRulesVia } from "./agent/system-instructions.ts";
import type { AssembledRequest, HistoryMessage } from "./agent/compaction.ts";
import { pinFrom } from "./agent/compaction.ts";
import {
  compactionPartsFrom,
  createTranscriptHistory,
  historyFrom,
} from "./agent/transcript-history.ts";
import { registerApiRoutes, type ApiDeps } from "./http/api.ts";
import { buildRoutes } from "./http/routes.ts";
import type { RunRequest } from "./http/run-routes.ts";
import { createApprovalRegistry, type ApprovalRegistry } from "./permissions/approvals.ts";
import { createAuditLog, createGate, createGrantLedger } from "./permissions/gate.ts";
import { createPlanGate } from "./permissions/plan-gate.ts";
import { DEFAULT_PERMISSION_CONFIG } from "./permissions/engine.ts";
import { resolveKey, secretSourceFromEnv } from "./providers/keys.ts";
import { contextWindowFor } from "./providers/models.ts";
import { resolveModel } from "./providers/registry.ts";
import { buildToolDescriptors, type ToolDescriptor } from "./tools/registry.ts";
import { createProposePlanTool } from "./tools/plan.ts";
import { workspaceClientFromEnv, type WorkspaceClient } from "./tools/workspace-client.ts";
import type { RuntimeEnv } from "./main.ts";
import type { RunWriter } from "./agent/writer.ts";

/**
 * A Session's stored transcript, oldest first, excluding the turn being submitted.
 *
 * The port the missing endpoint would fill, now filled. It answers the *stored
 * records* rather than flattened history because one read has to serve two
 * derivations — the prior turns (`historyFrom`) and the compaction pin
 * (`pinFrom` over `compactionPartsFrom`) — and reading twice would let a Run
 * assemble its messages from one snapshot and its pin from another.
 *
 * Records are `unknown` on purpose: they are AI SDK `UIMessage` documents, whose
 * part union belongs to the Chat_Surface. `transcript-history.ts` is the one
 * module that interprets them.
 */
export type LoadTranscript = (sessionId: string) => Promise<readonly unknown[]>;

export interface RuntimeDeps {
  readonly env: RuntimeEnv;
  /**
   * Prior turns. Defaults to the Workspace_Services transcript store; a test
   * supplies its own so a Run can be driven with history and without a sidecar.
   */
  readonly loadTranscript?: LoadTranscript;
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
  readonly slots?: SlotManager;
  readonly now?: () => Date;
}

/** Everything one Run needs that is scoped to that Run alone. */
interface RunScope {
  readonly approvals: ApprovalRegistry;
  readonly descriptors: readonly ToolDescriptor[];
}

/**
 * Build one Run's gate, tool registry, and approval registry over its writer.
 *
 * Called from inside `streamRun`'s `bind`, which is the only moment the writer exists —
 * and the gate has to close over it, because a refusal and an approval request are both
 * Message_Parts in this Run's `seq` space.
 *
 * The plan gate and the tool gate share one `planApproval` object by reference. That is
 * the mechanism, not an accident: the plan gate flips `approved` when the user accepts,
 * and Table A reads the same field on the next tool call, so approving a plan widens
 * what the Run may do without anything being re-registered (R32.9).
 */
function bindRun(
  writer: RunWriter,
  options: {
    readonly runId: string;
    readonly sessionId: string;
    readonly mode: RunRequest["mode"];
    readonly permissionMode: RunRequest["permissionMode"];
    readonly workspace: WorkspaceClient;
    readonly workspaceRoot: string;
    readonly audit: ReturnType<typeof createAuditLog>;
  },
): RunScope {
  const approvals = createApprovalRegistry({ runId: options.runId });
  const planApproval = {
    approved: false,
    planId: null as string | null,
    approvedAt: null as string | null,
  };
  const planPaths = new Set<string>();

  const gateWriter = {
    modeRefusal: (toolName: string, code: string, message: string) => {
      writer.error({ code, message, details: `tool: ${toolName}`, retryable: false });
    },
    toolRefusal: (toolName: string, reason: string) => {
      writer.error({
        code: "permission_denied",
        message: reason,
        details: `tool: ${toolName}`,
        retryable: false,
      });
    },
    approvalRequest: (request: {
      requestId: string;
      toolName: string;
      kind: ToolDescriptor["kind"];
      reason: "mode-ask" | "out-of-plan-path" | "destructive";
      paths: readonly string[];
      offeredScopes: readonly ("call" | "run" | "workspace")[];
      expiresAt: string;
    }) => {
      writer.permission({
        requestId: request.requestId,
        // The gate does not see the model's `toolCallId`, and the surface reconciles the
        // dock row by `requestId`, so the two ids are the same string rather than one
        // being invented.
        toolCallId: request.requestId,
        toolName: request.toolName,
        kind: request.kind,
        prompt: `Allow ${request.toolName}?`,
        paths: [...request.paths],
        reason: request.reason,
        offeredScopes: [...request.offeredScopes],
        expiresAt: request.expiresAt,
        decision: null,
        decidedScope: null,
      });
    },
    approvalTimeout: (toolName: string) => {
      writer.error({
        code: "permission_timeout",
        message: "The approval request expired, so the step was cancelled.",
        details: `tool: ${toolName}`,
        retryable: true,
      });
    },
    awaitingApproval: () => {
      writer.lifecycle({ state: "awaiting-approval" });
    },
  };

  const gateContext = {
    runId: options.runId,
    mode: options.mode,
    permissionMode: options.permissionMode,
    policy: DEFAULT_PERMISSION_CONFIG,
    workspaceRoot: options.workspaceRoot,
    planApproval,
    planPaths,
    writer: gateWriter,
    broker: approvals,
    grants: createGrantLedger(),
    audit: options.audit,
  };

  const planGated = createPlanGate({ ...gateContext, planBroker: approvals });

  const descriptors = buildToolDescriptors({
    workspace: options.workspace,
    sessionId: options.sessionId,
    runId: options.runId,
    mode: options.mode,
    gated: createGate(gateContext),
    proposePlan: createProposePlanTool({
      writePlan: (plan) => writer.plan(plan),
      planGated,
      // The tool has already expanded a rename into both of its paths, so these are
      // recorded as given rather than re-derived.
      declarePaths: (paths) => {
        for (const path of paths) planPaths.add(path);
      },
    }),
  });

  return { approvals, descriptors };
}

/**
 * Build the runtime's whole route table.
 *
 * The order below is the dependency order and nothing else: process-scoped objects
 * first, then the per-Run factory, then the deps for each route group.
 */
export function buildRuntimeRoutes(
  deps: RuntimeDeps,
): (
  req: Parameters<ReturnType<typeof buildRoutes>>[0],
  res: Parameters<ReturnType<typeof buildRoutes>>[1],
) => Promise<void> {
  const { env } = deps;
  const now = deps.now ?? (() => new Date());

  // ── Process-scoped ──────────────────────────────────────────────────
  // The client reads two *environment* variables, not `RuntimeEnv`'s three fields: the
  // Desktop_Core bridge URL is optional and never validated at startup, because a runtime
  // launched without it still serves catalogues and still fails workspace tools cleanly.
  const workspace = workspaceClientFromEnv(process.env, env.token, deps.fetchImpl);
  // ── Transcript history (R15.6, R34.6) ───────────────────────────────
  //
  // The port this file's header used to describe as unfillable: the endpoint it
  // needed did not exist, so `loadHistory` answered `[]` and every Run was
  // single-turn. It exists now (`GET`/`PUT /v1/sessions/{id}/messages`), and the
  // header's promise — "whoever adds the endpoint supplies this port and nothing
  // else changes" — is what these three lines are.
  //
  // `deps.loadHistory` still wins when supplied, because a test drives history
  // without a sidecar and the handshake test has no Python process at all.
  const transcripts = createTranscriptHistory(workspace, (message, detail) => {
    // `stderr` rather than `console`, matching `bin.ts` and the redacting logger in
    // `providers/keys.ts`: the supervisor captures this stream, and nothing here can
    // carry a credential — the detail is a taxonomy code and a sentence.
    //
    // Logged, never thrown: a Session whose transcript cannot be read starts
    // single-turn and a Run whose transcript cannot be written still streams.
    process.stderr.write(`agent-runtime ${message}: ${detail}\n`);
  });
  const loadTranscript = deps.loadTranscript ?? transcripts.loadRecords;
  // **The token is spread back in on purpose, and getting this wrong is silent.**
  // `main.ts` deletes `process.env.ZOC_RUNTIME_TOKEN` before the route table is built —
  // that is R3.4's scrub — and `secretSourceFromEnv` reads exactly that variable to
  // authenticate against Desktop_Core's key endpoint. Handed the scrubbed environment it
  // returns an `EmptySecretSource`, and every cloud Run then fails `no_key_configured`
  // with a correctly-configured vault sitting behind it. `env.token` is the surviving
  // copy, so the source is built from the scrubbed environment plus that one field.
  const secrets = secretSourceFromEnv({ ...process.env, ZOC_RUNTIME_TOKEN: env.token });
  const store = new RunStore();
  const slots = deps.slots ?? new SlotManager();
  const manager = new RunManager({ store, slots, now });
  const audit = createAuditLog();
  const completions = new CompletionCache();
  const discoverRules = discoverRulesVia(workspace);

  /** The registries of Runs that are still live, for the approval route. */
  const approvalsByRun = new Map<string, ApprovalRegistry>();

  const apiDeps: ApiDeps = {
    runs: {
      manager,
      plan: async (request) => {
        // Resolution happens here, before admission, because a missing key or an unknown
        // provider is something the caller must be told *now* — whereas reading history
        // and dispatching belong inside `open`, which a queued Run does not reach.
        const apiKey = await resolveKey(request.modelRef.provider, secrets);
        const resolved = resolveModel({
          model: {
            provider: request.modelRef.provider,
            modelId: request.modelRef.modelId,
            baseUrl: request.modelRef.baseUrl ?? null,
          },
          apiKey,
        });

        return {
          provider: resolved.spec.id,
          model: resolved.modelId,
          open: openRunStream(request, resolved),
        };
      },
    },
    catalogue: {
      // Built with a no-op gate and no plan tool: `GET /v1/tools` reports what exists,
      // and constructing a live gate to answer a catalogue request would mean standing
      // up half a Run for a `GET`.
      toolDescriptors: () =>
        buildToolDescriptors({
          workspace,
          sessionId: "(catalogue)",
          mode: "agent",
          gated: (_name, _kind, execute) => execute,
          proposePlan: null,
        }),
    },
    benchmark: {
      benchmarkHistory: (modelId) => workspace.benchmarkHistory(modelId),
    },
    sessions: {
      // The title route needs the Session's messages and its own model, and there is no
      // transcript store to read either from. Answering `null` is a 404 — honest, and
      // distinguishable from `title_not_needed`, which claims a Session exists and is
      // empty. R15.3's auto-title is the same route, so both wait on the same endpoint.
      generateTitle: async () => null,
    },
    editor: {
      cache: completions,
      // R6.2's inference path, live. The request names the model and the runtime resolves the key,
      // which is the whole of R7.8 for the editor — see `agent/editor-generate.ts` for why the
      // "no selected model" premise the old stub carried was wrong.
      generate: createEditorGenerator({ secrets }),
    },
    compaction: {
      hasActiveRun: (sessionId) => manager.hasActiveRun(sessionId),
      // A manual fold needs the Session's stored history to fold. Same gap, same shape of
      // answer: 404 rather than a fold over nothing.
      prepare: async () => null,
    },
    permissions: {
      approvalsFor: (runId) => approvalsByRun.get(runId) ?? null,
      // Newest last from the log, newest-last slice out: the route's `limit` is "the most
      // recent n", and the log is append-ordered.
      auditEntries: (limit) => audit.entries().slice(-limit),
    },
  };

  return buildRoutes(env, (router) => registerApiRoutes(router, apiDeps));

  /**
   * The deferred dispatch for one admitted Run.
   *
   * A closure rather than a method because it captures everything the Run needs and is
   * called at most once, after a Slot is held — which is the whole reason `plan` returns
   * a thunk instead of a stream.
   */
  function openRunStream(
    request: RunRequest,
    resolved: ReturnType<typeof resolveModel>,
  ): OpenRunStream {
    return async (binding) => {
      const instructions = await assembleInstructions({
        sessionId: request.sessionId,
        discoverRules,
        workspaceRoot: env.workspaceRoot,
        permissionMode: request.permissionMode,
        conversationMode: request.mode,
      });

      // One read, two derivations: the prior turns and the compaction pin come
      // from the same snapshot, so a Run cannot assemble its messages from one
      // state of the transcript and its pin from another.
      const stored = await loadTranscript(request.sessionId);
      const messages: HistoryMessage[] = [
        ...historyFrom(stored),
        { id: binding.messageId, role: "user", text: request.prompt },
      ];

      const assembled: AssembledRequest = {
        instructions: instructions.instructions,
        // Derived from the newest `CompactionPart` in the stored transcript
        // (R34.6). Null for a Session that has never compacted, and null when the
        // store could not answer — a missing pin re-sends folded turns, which is
        // wasteful, where a fabricated one would drop turns the model needs.
        pin: pinFrom(compactionPartsFrom(stored)),
        mentions: request.mentions.map((mention) => mention.content ?? mention.ref),
        toolSchemas: [],
        messages,
        contextLimit: contextWindowFor({
          provider: resolved.spec.id,
          modelId: resolved.modelId,
        }),
        sessionMessageCount: messages.length,
      };

      let scope: RunScope | null = null;
      const context: RunContext = {
        runId: binding.runId,
        sessionId: binding.sessionId,
        messageId: binding.messageId,
        provider: resolved.spec.id,
        model: resolved.modelId,
        languageModel: resolved.model,
        conversationMode: request.mode,
        permissionMode: request.permissionMode,
        instructions,
        request: assembled,
        bind: (writer) => {
          scope = bindRun(writer, {
            runId: binding.runId,
            sessionId: binding.sessionId,
            mode: request.mode,
            permissionMode: request.permissionMode,
            workspace,
            workspaceRoot: env.workspaceRoot,
            audit,
          });
          approvalsByRun.set(binding.runId, scope.approvals);
          return { descriptors: scope.descriptors };
        },
        // A real meter, not the null one: this is the answer stream, which is the one
        // thing Token_Rate is allowed to describe (R13.8).
        rate: createTokenRateMeter(),
        // R15.6. Supplied here rather than left undefined, which is what made the
        // `onFinish` hook a no-op: the Run streamed, the user read the answer, and
        // nothing wrote it down. An aborted Run persists too, flagged.
        persistence: transcripts,
        // Bound to this Run's provider, so R13.7's card can name it.
        classifyError: createRunErrorClassifier({
          provider: resolved.spec.label,
          model: resolved.modelId,
        }),
        signal: binding.signal,
        now,
      };

      // Released on settlement rather than on the last chunk: an approval can still be
      // decided while the cancel grace runs, and dropping the registry early would turn a
      // late approval into a 404 on a Run that is still open.
      void manager.driver(binding.runId)?.settled.then(() => {
        approvalsByRun.get(binding.runId)?.releaseRun(binding.runId);
        approvalsByRun.delete(binding.runId);
      });

      return streamRun(context);
    };
  }
}

/** The route table `main.ts` uses when it is not given one. */
export function defaultRoute(env: RuntimeEnv): ReturnType<typeof buildRuntimeRoutes> {
  return buildRuntimeRoutes({ env });
}
