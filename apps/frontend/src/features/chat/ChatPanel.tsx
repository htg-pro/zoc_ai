/**
 * The chat panel — zoc-agent-chat-rebuild R1.4, R3.8, R8.7, R13.9, R14.8, R16.1, R16.5, R16.6, task 22.8.
 *
 * The composition, and the only place the Chat_Surface becomes one thing. Above it: `App.tsx`, which
 * supplies app-wide state. Below it: the header, the transcript, the dock, and the composer, each of
 * which is already assertable on its own. What lives here is what none of them can own.
 *
 * ## Why every input is a prop rather than a `useApp` read
 *
 * This module imports no app store. Task 25.5 rewrites `lib/store.ts` three waves from now, and a panel
 * that read it directly would be rewritten twice — once against the store as it is and once against the
 * store as it becomes. Props also make the read-only path testable without a router, a share token, or a
 * window: Property 58 mounts this component with `readOnly` set and asserts absence.
 *
 * ## The one `useChat` instance
 *
 * Keyed by `sessionId`, so switching Session gives a new chat rather than a mutated one, and configured
 * **without** `resume: true` — resumption is `ZocChatTransport`'s job (11.1), and the transport's own
 * comment explains why the two cannot both own it.
 *
 * The transport is constructed once and reads the next submission through a ref. All five of its
 * submission facts change between turns, so a transport that captured them at construction would send
 * the first turn's mode and model forever.
 *
 * ## Why the composer queues instead of blocking
 *
 * R8.7 keeps the composer usable during a Run. A second submission while one is in flight is held here
 * and sent when the Run settles, and the count goes back to the composer's send control. The composer
 * cannot do this itself: knowing a Run ended means watching the transcript, and a composer that watched
 * the transcript would be this component.
 *
 * ## Read-only omits rather than disables
 *
 * R1.4. Under a read-only viewer the composer, the dock, the cancel control, the restart control, and
 * every session mutation are absent from the tree — not passed and disabled. The banner is what explains
 * the absence.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import type { ChatTransport } from "ai";
import type { Session, ToolKind } from "@zoc-studio/shared-types";

import { ChatMotionProvider } from "@/lib/reduced-motion-provider";
import { RuntimeUnavailableError, resolveRuntimeEndpoint } from "@/lib/runtime-endpoint";
import { secureStore, subscribeSecrets, type SecretStatus } from "@/lib/secure-store";
import { cn } from "@/lib/utils";
import { ZocMark } from "./brand/ZocMark";
import { Composer, type ComposerSubmission } from "./composer/Composer";
import type { MentionCandidate } from "./composer/mention-index";
import type { PermissionMode } from "./composer/mode-consequence";
import { DegradedSecretsStrip } from "./DegradedSecretsStrip";
import { EmptyState } from "./EmptyState";
import { ErrorRow } from "./ErrorRow";
import { ChatHeader } from "./header/ChatHeader";
import type { ModelChoice } from "./header/model-catalogue";
import { censusOf, markStateOf, runSnapshotOf, type ChatRunStatus } from "./panel-state";
import { PermissionDock } from "./permission/PermissionDock";
import { ReadOnlyBanner } from "./ReadOnlyBanner";
import type { ReviewSurface } from "./review/review-surface";
import { RuntimeUnavailableBanner } from "./RuntimeUnavailableBanner";
import { useChatSurface } from "./store";
import { Transcript } from "./Transcript";
import type { ActiveRun, SubmissionContext } from "./wire/zoc-transport";
import { ZocChatTransport } from "./wire/zoc-transport";
import type { ZocUIMessage } from "./wire/ui-message";

export interface ChatPanelProps {
  /** The Session on screen. `useChat` is keyed by it, so a change is a new chat. */
  sessionId: string;
  sessionTitle: string;
  /** The Session rows behind the single Session_Store (22.5, R35.1). Metadata only. */
  sessions: readonly Session[];
  workspaceRoot: string | null;
  /** The transcript restored for this Session (22.5's `loadTranscript`), or none. */
  initialMessages?: readonly ZocUIMessage[];

  models: readonly ModelChoice[];
  selectedModel: ModelChoice | null;
  onSelectModel: (model: ModelChoice) => void;
  onAddKey?: (provider: string) => void;

  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;

  /** The mention snapshot the composer indexes (R12.2). */
  candidates?: readonly MentionCandidate[];

  onSelectSession: (sessionId: string) => void;
  onNewSession?: () => void;
  onRenameSession?: (sessionId: string, title: string) => void;
  onForkSession?: (sessionId: string) => void;
  onDuplicateSession?: (sessionId: string) => void;
  onArchiveSession?: (sessionId: string) => void;
  onUnarchiveSession?: (sessionId: string) => void;
  onDeleteSession?: (sessionId: string) => void;

  /** `POST /v1/sessions/:id/compact` (R34.4). */
  onCompact?: () => void;
  /** Re-runs the supervisor handshake (R3.8). Absent for a read-only viewer. */
  onRestartRuntime?: () => void | Promise<void>;
  /**
   * A runtime failure the host already knows about, from `agent_runtime_status` or the supervisor's
   * status event.
   *
   * The panel detects one itself the first time it resolves the endpoint, but that is the *second*
   * moment it is knowable: Desktop_Core learns the runtime crashed as soon as the child exits, and the
   * panel would keep reading "idle" until the next submission. Supplied here, the banner appears when
   * the shell learns rather than when the panel next asks.
   */
  runtimeUnavailable?: string | null;

  /** The plan-review surface: digests, receipts, and the four handlers (18.2). */
  review?: ReviewSurface;
  /** The authoritative tool kind, from 22.1's `/v1/tools` catalogue. */
  toolKindOf?: (toolName: string) => ToolKind | undefined;

  /** R1.4: a viewer watching someone else's Session gets no mutating control. */
  readOnly?: boolean;
  /** The host being watched, for the banner. */
  viewerHost?: string | null;

  /** Injected in tests, so the panel can be mounted without a runtime. */
  transport?: ChatTransport<ZocUIMessage>;
  /** Injected in tests; production asks Desktop_Core. */
  secretStatus?: SecretStatus | null;
  className?: string;
}

const NO_CANDIDATES: readonly MentionCandidate[] = [];

export function ChatPanel(props: ChatPanelProps) {
  const {
    sessionId,
    sessionTitle,
    sessions,
    workspaceRoot,
    initialMessages,
    models,
    selectedModel,
    onSelectModel,
    onAddKey,
    permissionMode,
    onPermissionModeChange,
    candidates = NO_CANDIDATES,
    onSelectSession,
    onCompact,
    onRestartRuntime,
    runtimeUnavailable,
    review,
    toolKindOf,
    readOnly = false,
    viewerHost,
    transport: providedTransport,
    secretStatus: providedSecretStatus,
    className,
  } = props;

  const setDraft = useChatSurface((state) => state.setDraft);
  const recordRenderedSeq = useChatSurface((state) => state.recordRenderedSeq);
  const forgetRun = useChatSurface((state) => state.forgetRun);
  const resetForSession = useChatSurface((state) => state.resetForSession);
  const pendingApprovalId = useChatSurface((state) => state.pendingApprovalId);

  const [runtimeFailure, setRuntimeFailure] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  // The host's report wins, because it is the earlier of the two: Desktop_Core knows the child exited
  // before the panel next asks for an endpoint.
  const runtimeReason =
    runtimeUnavailable !== undefined && runtimeUnavailable !== null && runtimeUnavailable.length > 0
      ? runtimeUnavailable
      : runtimeFailure;

  // ── The runtime endpoint, and the banner's trigger ──────────────────
  //
  // Resolved per call rather than once, so a restart's new port is picked up (3.3). The failure is
  // recorded here rather than in the transport because the banner is a panel-level surface and the
  // transport's contract is to keep failing honestly, not to render.
  const endpoint = useCallback(async (signal?: AbortSignal) => {
    try {
      const resolved = await resolveRuntimeEndpoint(signal);
      setRuntimeFailure(null);
      return { baseUrl: resolved.baseUrl, token: resolved.token };
    } catch (cause) {
      if (cause instanceof RuntimeUnavailableError) setRuntimeFailure(cause.message);
      throw cause;
    }
  }, []);

  // ── The transport ───────────────────────────────────────────────────
  //
  // One instance for the panel's lifetime. `submission` is read through a ref because the mode, the
  // model, and the mentions all change between turns; `activeRun` is a per-Session record of the
  // newest Run and how far it was rendered, which is what `reconnectToStream` resumes from (R16.3).
  const submissionRef = useRef<SubmissionContext | null>(null);
  const activeRunsRef = useRef(new Map<string, ActiveRun>());

  const transport = useMemo<ChatTransport<ZocUIMessage>>(() => {
    if (providedTransport !== undefined) return providedTransport;
    return new ZocChatTransport({
      endpoint,
      submission: () => {
        const current = submissionRef.current;
        // Unreachable through the composer, which cannot submit without a model (R13.2). Thrown
        // rather than defaulted: a default here would send a Run against a model nobody chose.
        if (current === null) throw new Error("No submission context: pick a model first.");
        return current;
      },
      activeRun: (id) => activeRunsRef.current.get(id) ?? null,
      onRunProgress: (run) => {
        activeRunsRef.current.set(run.sessionId, {
          runId: run.runId,
          streamUrl: run.streamUrl,
          lastRenderedSeq: run.lastRenderedSeq,
        });
        recordRenderedSeq(run.runId, run.lastRenderedSeq);
      },
    });
  }, [providedTransport, endpoint, recordRenderedSeq]);

  const { messages, status, error, sendMessage, clearError } = useChat<ZocUIMessage>({
    id: sessionId,
    transport,
    ...(initialMessages === undefined ? {} : { messages: [...initialMessages] }),
  });

  // Everything scoped to one Session — the draft, the mentions, the hunk decisions, the focused
  // approval — is dropped on a switch. The store owns the list; this is the one caller that knows a
  // switch happened.
  useEffect(() => {
    resetForSession();
  }, [sessionId, resetForSession]);

  // ── Derived state ───────────────────────────────────────────────────

  const run = useMemo(
    () =>
      runSnapshotOf({
        messages,
        status: status as ChatRunStatus,
        awaitingApproval: pendingApprovalId !== null,
      }),
    [messages, status, pendingApprovalId],
  );

  const census = useMemo(() => censusOf(messages), [messages]);

  // The pill's clock. Ticked here because the pill is a presentational component and a `setInterval`
  // inside it would run for every mounted pill in a story or a test.
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (!run.active) return;
    const timer = globalThis.setInterval(() => {
      setTick(Date.now());
    }, 1_000);
    return () => {
      globalThis.clearInterval(timer);
    };
  }, [run.active]);
  const elapsedMs = run.startedAt === null ? 0 : Math.max(0, tick - run.startedAt);

  // ── The degraded-secrets strip (R14.8) ──────────────────────────────
  //
  // Asked once and then re-asked on every secrets change, because entering a key is what most often
  // reveals the backend is degraded — the probe runs at boot, but the strip is read at the moment it
  // matters.
  const [secretStatus, setSecretStatus] = useState<SecretStatus | null>(
    providedSecretStatus ?? null,
  );
  useEffect(() => {
    if (providedSecretStatus !== undefined) return;
    let live = true;
    const read = () => {
      void secureStore.status().then((next) => {
        if (live) setSecretStatus(next);
      });
    };
    read();
    const unsubscribe = subscribeSecrets(read);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [providedSecretStatus]);

  // ── Submission, and the queue behind an in-flight Run (R8.7) ─────────

  const dispatch = useCallback(
    (submission: ComposerSubmission, model: ModelChoice) => {
      // Set from the submission rather than read from the store at send time: the mode a Run was
      // submitted in is immutable (R7.11), and the store's value can change while the request is in
      // flight if the user moves the control.
      submissionRef.current = {
        mode: submission.mode,
        permissionMode,
        modelRef: { provider: model.provider, modelId: model.modelId },
        mentions: submission.mentions.map((mention) => ({
          kind: mention.kind,
          ref: mention.ref,
          ...(mention.label === undefined ? {} : { label: mention.label }),
        })),
      };
      clearError();
      void sendMessage({ text: submission.text });
    },
    [permissionMode, clearError, sendMessage],
  );

  const [queue, setQueue] = useState<readonly ComposerSubmission[]>([]);

  const handleSubmit = useCallback(
    (submission: ComposerSubmission) => {
      if (selectedModel === null) return;
      if (run.active) {
        setQueue((current) => [...current, submission]);
        return;
      }
      dispatch(submission, selectedModel);
    },
    [selectedModel, run.active, dispatch],
  );

  useEffect(() => {
    if (run.active || queue.length === 0 || selectedModel === null) return;
    const [next, ...rest] = queue;
    if (next === undefined) return;
    setQueue(rest);
    dispatch(next, selectedModel);
  }, [run.active, queue, selectedModel, dispatch]);

  // ── Out-of-band Run controls ────────────────────────────────────────
  //
  // Duck-typed rather than narrowed to `ZocChatTransport`, so a fake injected by a test can implement
  // only what it exercises. Both calls are the transport's (11.1): cancel is a POST and never `stop()`,
  // and a decision is a POST whose failure the dock renders.
  const runControls = transport as {
    cancel?: (runId: string) => Promise<void>;
    decideApproval?: (
      runId: string,
      request: { requestId: string; decision: "approve" | "reject"; scope?: "call" | "run" | "workspace" },
    ) => Promise<void>;
  };

  const handleCancel = useCallback(() => {
    if (run.runId === null) return;
    void runControls.cancel?.(run.runId);
  }, [run.runId, runControls]);

  const handleDecide = useCallback(
    async (decision: { requestId: string; decision: "approve" | "reject"; scope: "call" | "run" | "workspace" }) => {
      if (run.runId === null) return;
      await runControls.decideApproval?.(run.runId, decision);
    },
    [run.runId, runControls],
  );

  /**
   * R16.5's affordance: keep the partial transcript and carry on from it.
   *
   * Two things, and neither is a retry. The Run is forgotten, so the transport's `activeRun` no longer
   * names a stream to re-attach to — without that, the next reconnect would burn its five attempts on a
   * stream that is already gone. And the hook's error is cleared, so the composer is the next thing the
   * user interacts with rather than a failure they have to dismiss first. The rows stay exactly as they
   * arrived, which is what "what we have" means.
   */
  const handleContinue = useCallback(() => {
    if (run.runId !== null) {
      activeRunsRef.current.delete(sessionId);
      forgetRun(run.runId);
    }
    clearError();
  }, [run.runId, sessionId, forgetRun, clearError]);

  const handleRestart = useCallback(() => {
    if (onRestartRuntime === undefined) return;
    setRestarting(true);
    void Promise.resolve(onRestartRuntime()).finally(() => {
      setRestarting(false);
      setRuntimeFailure(null);
    });
  }, [onRestartRuntime]);

  // ── The Session list, which is one list rendered from three places (R35.2) ──
  //
  // A read-only viewer can switch what it is looking at and can mutate nothing, so the mutation
  // handlers are omitted rather than passed and ignored — `SessionRow` renders a control per handler
  // it receives, which is what makes omission the whole of R1.4 here.
  const sessionList = useMemo(
    () => ({
      sessions,
      activeSessionId: sessionId,
      workspaceRoot,
      onSelect: onSelectSession,
      ...(readOnly
        ? {}
        : {
            ...(props.onRenameSession === undefined ? {} : { onRename: props.onRenameSession }),
            ...(props.onForkSession === undefined ? {} : { onFork: props.onForkSession }),
            ...(props.onDuplicateSession === undefined
              ? {}
              : { onDuplicate: props.onDuplicateSession }),
            ...(props.onArchiveSession === undefined ? {} : { onArchive: props.onArchiveSession }),
            ...(props.onUnarchiveSession === undefined
              ? {}
              : { onUnarchive: props.onUnarchiveSession }),
            ...(props.onDeleteSession === undefined ? {} : { onDelete: props.onDeleteSession }),
          }),
    }),
    [
      sessions,
      sessionId,
      workspaceRoot,
      onSelectSession,
      readOnly,
      props.onRenameSession,
      props.onForkSession,
      props.onDuplicateSession,
      props.onArchiveSession,
      props.onUnarchiveSession,
      props.onDeleteSession,
    ],
  );

  const model = selectedModel;
  const modelReference = useMemo(
    () =>
      model === null
        ? { provider: "", modelId: "", contextLimit: 0 }
        : { provider: model.provider, modelId: model.modelId, contextLimit: model.contextLimit },
    [model],
  );

  return (
    <ChatMotionProvider>
      <div
        data-zoc-chat-panel=""
        data-zoc-read-only={String(readOnly)}
        className={cn("flex min-h-0 flex-1 flex-col", className)}
        style={{ backgroundColor: "var(--zoc-bg)" }}
      >
        <ChatHeader
          brand={<ZocMark size={24} state={markStateOf(run.state)} />}
          sessionTitle={sessionTitle}
          sessionList={sessionList}
          models={models}
          selectedModel={model}
          onSelectModel={onSelectModel}
          permissionMode={permissionMode}
          onPermissionModeChange={onPermissionModeChange}
          runState={run.state}
          runElapsedMs={elapsedMs}
          tokensPerSecond={run.tokensPerSecond}
          {...(readOnly
            ? {}
            : {
                ...(props.onNewSession === undefined ? {} : { onNewSession: props.onNewSession }),
                ...(onAddKey === undefined ? {} : { onAddKey }),
                ...(onCompact === undefined ? {} : { onCompact }),
                ...(onRestartRuntime === undefined ? {} : { onRestartRuntime: handleRestart }),
                ...(run.active ? { onCancelRun: handleCancel } : {}),
              })}
        />

        {/*
          Banners, outermost first: who you are, then how keys are stored, then whether the runtime is
          up. All three sit above a transcript that keeps rendering — none of them is a reason to hide
          content that is already on disk (R3.8).
        */}
        {readOnly ? <ReadOnlyBanner {...(viewerHost === undefined ? {} : { host: viewerHost })} /> : null}
        <DegradedSecretsStrip status={secretStatus} />
        {runtimeReason === null ? null : (
          <RuntimeUnavailableBanner
            reason={runtimeReason}
            restarting={restarting}
            {...(readOnly || onRestartRuntime === undefined ? {} : { onRestart: handleRestart })}
          />
        )}

        {messages.length === 0 ? (
          <EmptyState
            workspaceRoot={workspaceRoot}
            model={model}
            onPick={setDraft}
            {...(readOnly || onAddKey === undefined ? {} : { onAddKey })}
          />
        ) : (
          <Transcript
            messages={messages}
            streaming={status === "submitted" || status === "streaming"}
            {...(toolKindOf === undefined ? {} : { toolKindOf })}
            {...(review === undefined ? {} : { review })}
            {...(readOnly ? {} : { onErrorContinue: handleContinue })}
          />
        )}

        {/*
          A transport rejection, which is the one failure that is not a part: `sendMessages` throws for a
          Run that was never opened, so there is no transcript to append to and R7.5's card renders off
          the hook's error instead. Outside the scroll container for the same reason the dock is — the
          answer to "did my send land" must not scroll away.
        */}
        {error === undefined ? null : (
          <div className="shrink-0 px-4 pb-2">
            <ErrorRow error={error} fallbackCode="runtime_unavailable" />
          </div>
        )}

        {readOnly ? null : <PermissionDock messages={messages} onDecide={handleDecide} />}

        {readOnly ? null : (
          <Composer
            streaming={run.active}
            candidates={candidates}
            model={modelReference}
            census={census}
            permissionMode={permissionMode}
            workspaceRoot={workspaceRoot}
            onSubmit={handleSubmit}
            queued={queue.length}
            disabled={model === null}
            {...(onCompact === undefined ? {} : { onCompact })}
          />
        )}
      </div>
    </ChatMotionProvider>
  );
}
