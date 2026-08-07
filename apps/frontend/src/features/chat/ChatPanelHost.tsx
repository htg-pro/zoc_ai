/**
 * The Chat_Surface's host — zoc-agent-chat-rebuild R1.3, task 25.6.
 *
 * Feature: zoc-agent-chat-rebuild, task 25.6 (R1.3).
 *
 * `ChatPanel` takes every input as a prop and imports no app store, deliberately (22.8's docstring
 * says why: 25.5 rewrote `lib/store.ts`, and a panel that read it directly would have been written
 * twice). Something still has to read `useApp` and hand it those props. 25.6's text names only the
 * repoint, so this adapter is the addition that makes the repoint possible — one of it, held by both
 * `App.tsx` (the read-only viewer branch) and `Shell.tsx` (the right panel), so the two call sites
 * cannot drift into supplying different props.
 *
 * ## The viewer context is read here, not passed in
 *
 * Both call sites would otherwise answer "is this a viewer?" separately. `App.tsx` already branches on
 * it, and a `readOnly` prop would let its branch and the panel's banner disagree.
 *
 * ## What is deliberately not wired
 *
 * `onCompact`, `onForkSession`, `onDuplicateSession`, `onArchiveSession`, `onUnarchiveSession`,
 * `candidates`, `review`, and `toolKindOf` are **omitted rather than stubbed**: no store action stands
 * behind any of them (25.7 records the same gap for fork/duplicate/archive), and the panel's contract
 * is that an absent handler means an absent control. A no-op stub would render a control that lies.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import {
  DEFAULT_CONTEXT_WINDOW,
  getLocalModelsSnapshot,
  subscribeLocalModels,
  type LocalModel,
} from "@/lib/local-models";
import {
  getProvidersSnapshot,
  providerKeyStates,
  subscribeProviderKeys,
  subscribeProviders,
  type ProviderConfig,
} from "@/lib/providers";
import { useApp } from "@/lib/store";
import { getSetting, subscribeSettings } from "@/lib/settings";
import { runtimeRestart } from "@/lib/tauri-bridge";
import { currentViewerContext } from "@/lib/viewer-context";
import { getWorkspaceServicesClient } from "@/lib/workspace-services-client";
import { ChatPanel } from "./ChatPanel";
import type { PermissionMode } from "./composer/mode-consequence";
import { createBrowserTranscriptionBackend } from "./composer/voice-input";
import { modelChoice, type ModelChoice } from "./header/model-catalogue";
import { loadTranscript } from "./transcript-persistence";
import type { ZocUIMessage } from "./wire/ui-message";

const LOCAL_PROVIDER = "llamacpp";
const LOCAL_PROVIDER_LABEL = "Local (llama.cpp)";

/**
 * The catalogue the header picks from: local models first, then each cloud provider's.
 *
 * Pure and exported, because the one mistake this code can make is pairing a key state with the wrong
 * provider — `modelChoice`'s own docstring names it — and that is arithmetic over three lists rather
 * than anything a mounted picker would show.
 *
 * `fit` and `meanTokensPerSecond` are left absent on every row. Both are optional and the picker reads
 * an absent value as unknown; supplying them means the hardware probe and the benchmark store, which
 * R13.11/R13.13 own and no task in this wave wires.
 */
export function catalogueOf(
  providers: readonly ProviderConfig[],
  keyed: ReadonlyMap<string, boolean>,
  localModels: readonly LocalModel[],
): ModelChoice[] {
  const local = localModels.map((model) =>
    modelChoice({
      provider: LOCAL_PROVIDER,
      providerLabel: LOCAL_PROVIDER_LABEL,
      model: { id: model.id, name: model.name },
      // A local model authenticates with nothing, so it is submittable as soon as it is registered
      // (R13.2). `hasKey` is true rather than false for the same reason: the gate reads the pair.
      requiresKey: false,
      hasKey: true,
      local: true,
      contextLimit: model.n_ctx ?? DEFAULT_CONTEXT_WINDOW,
    }),
  );
  const cloud = providers.flatMap((provider) =>
    provider.models.map((model) =>
      modelChoice({
        provider: provider.id,
        providerLabel: provider.name,
        model,
        requiresKey: provider.requiresKey,
        // Absent from the map means "not asked yet", which is the same refusal as "no key": a Run
        // started against an unverified key fails at the provider instead of at the composer.
        hasKey: keyed.get(provider.id) ?? false,
        local: false,
        contextLimit: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      }),
    ),
  );
  return [...local, ...cloud];
}

export function ChatPanelHost({ className }: { className?: string }) {
  const viewer = currentViewerContext();

  const sessions = useApp((state) => state.sessions);
  const sessionId = useApp((state) => state.activeSessionId);
  const workspaceRoot = useApp((state) => state.workspaceRoot);
  const selected = useApp((state) => state.selectedModel);
  const setSelectedModel = useApp((state) => state.setSelectedModel);
  const selectSession = useApp((state) => state.selectSession);
  const createSession = useApp((state) => state.createSession);
  const renameSession = useApp((state) => state.renameSession);
  const deleteSession = useApp((state) => state.deleteSession);
  const openSettings = useApp((state) => state.openSettings);

  // ── The model catalogue ─────────────────────────────────────────────
  //
  // Both lists live outside the store, in their own `localStorage`-backed modules, so they are read
  // through `useSyncExternalStore` rather than copied into `useApp` — the same way the legacy picker
  // and Settings → Providers read them, which is what keeps a key saved in Settings visible here
  // without a reload (R13.3).
  const providers = useSyncExternalStore(
    subscribeProviders,
    getProvidersSnapshot,
    getProvidersSnapshot,
  );
  const localModels = useSyncExternalStore(
    subscribeLocalModels,
    getLocalModelsSnapshot,
    getLocalModelsSnapshot,
  );

  const [keyed, setKeyed] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  useEffect(() => {
    let live = true;
    const read = () => {
      void providerKeyStates(providers).then((next) => {
        if (live) setKeyed(next);
      });
    };
    read();
    // Re-read on a key change only, not on every secret: `subscribeProviderKeys` is the filtered view
    // that exists for exactly this badge.
    const unsubscribe = subscribeProviderKeys(read);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [providers]);

  const models = useMemo(
    () => catalogueOf(providers, keyed, localModels),
    [providers, keyed, localModels],
  );

  const selectedModel = useMemo(
    () =>
      models.find(
        (model) => model.provider === selected.provider && model.modelId === selected.model,
      ) ?? null,
    [models, selected.provider, selected.model],
  );

  const onSelectModel = useCallback(
    (model: ModelChoice) => {
      setSelectedModel({ provider: model.provider, model: model.modelId });
    },
    [setSelectedModel],
  );

  // ── The restored transcript (R15.6) ─────────────────────────────────
  //
  // 22.5 wrote `loadTranscript` and nothing called it, so opening a Session showed no history. The read
  // is per Session and its outcome carries the Session it belongs to, because a fast switch resolves
  // two loads and the later one must not paint the earlier Session's rows.
  const [restored, setRestored] = useState<{
    sessionId: string;
    messages: readonly ZocUIMessage[];
  } | null>(null);

  useEffect(() => {
    if (sessionId === "") return undefined;
    let live = true;
    void (async () => {
      try {
        const client = await getWorkspaceServicesClient();
        const outcome = await loadTranscript(client, sessionId);
        if (live) setRestored({ sessionId, messages: outcome.messages });
      } catch {
        // No runtime to ask (browser preview, cold start). An empty transcript is the honest answer
        // and the panel stays usable — `loadTranscript` makes the same choice for a read failure.
        if (live) setRestored({ sessionId, messages: [] });
      }
    })();
    return () => {
      live = false;
    };
  }, [sessionId]);

  const restoredMessages =
    restored !== null && restored.sessionId === sessionId && restored.messages.length > 0
      ? restored.messages
      : null;

  // ── Session actions ─────────────────────────────────────────────────

  const onSelectSession = useCallback(
    (id: string) => {
      void selectSession(id);
    },
    [selectSession],
  );

  const onNewSession = useCallback(() => {
    // No `/` fallback and no invented root: a Session needs a real folder. Same rule and same title
    // format as the two sessions surfaces, so a Session created here is indistinguishable from one
    // created there.
    const root = (
      workspaceRoot ??
      sessions.find((session) => session.id === sessionId)?.workspace_root ??
      ""
    ).trim();
    if (root === "" || root === "/") return;
    void createSession(`Session ${new Date().toLocaleTimeString()}`, root);
  }, [createSession, sessionId, sessions, workspaceRoot]);

  const onRenameSession = useCallback(
    (id: string, title: string) => {
      void renameSession(id, title);
    },
    [renameSession],
  );

  const onDeleteSession = useCallback(
    (id: string) => {
      void deleteSession(id);
    },
    [deleteSession],
  );

  const onAddKey = useCallback(() => {
    openSettings("providers");
  }, [openSettings]);

  // Permission_Mode has no home outside this window yet. `agent.autonomy` in the settings registry is a
  // Low/Medium/High vocabulary rather than ask/auto/deny, and mapping one onto the other would invent a
  // policy neither surface states.
  // ponytail: per-window state, add a `agent.permissionMode` setting when it needs to survive a reload.
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("ask");
  const [voiceBackendSetting, setVoiceBackendSetting] = useState(() =>
    String(getSetting("agent.transcriptionBackend") ?? "none"),
  );
  useEffect(
    () =>
      subscribeSettings(() => {
        setVoiceBackendSetting(String(getSetting("agent.transcriptionBackend") ?? "none"));
      }),
    [],
  );
  const transcriptionBackend = useMemo(
    () => (voiceBackendSetting === "browser" ? createBrowserTranscriptionBackend() : null),
    [voiceBackendSetting],
  );

  return (
    <ChatPanel
      // Remounted when a restored transcript arrives, because `useChat` reads `messages` as an initial
      // value and the load resolves after the first paint. Rendering nothing until it lands would leave
      // the panel blank for as long as the endpoint takes to resolve, which on a cold start is the
      // readiness poll.
      // ponytail: one remount per Session that has history, upgrade to `setMessages` if it flashes.
      key={restoredMessages === null ? sessionId : `${sessionId}:restored`}
      sessionId={sessionId}
      sessionTitle={sessions.find((session) => session.id === sessionId)?.title ?? ""}
      sessions={sessions}
      workspaceRoot={workspaceRoot}
      models={models}
      selectedModel={selectedModel}
      onSelectModel={onSelectModel}
      permissionMode={permissionMode}
      onPermissionModeChange={setPermissionMode}
      onSelectSession={onSelectSession}
      readOnly={viewer.readOnly}
      viewerHost={viewer.host}
      className={className ?? "h-full"}
      transcriptionBackend={transcriptionBackend}
      {...(restoredMessages === null ? {} : { initialMessages: restoredMessages })}
      {...(viewer.readOnly
        ? // R1.4: a viewer gets no mutating handler at all, not a disabled control. The panel omits the
          // controls itself; withholding the handlers as well means a future control cannot forget to
          // check.
          {}
        : {
            onAddKey,
            onNewSession,
            onRenameSession,
            onDeleteSession,
            onRestartRuntime: runtimeRestart,
          })}
    />
  );
}
