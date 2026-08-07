import { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Cloud,
  Cpu,
  ExternalLink,
  FolderOpen,
  FolderSearch,
  HardDrive,
  Loader2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useApp } from "@/lib/store";
import { useChatSurface } from "@/features/chat/store";
import { getAgentClient } from "@/lib/agent-client";
import { resolveWorkspaceServicesEndpoint } from "@/lib/workspace-services-endpoint";
import { loadLocalModels, readinessDeadlineSecs, saveLocalModels } from "@/lib/local-models";
import { secureStore } from "@/lib/secure-store";
import {
  agentRestart,
  desktopConfigGet,
  desktopConfigSet,
  isTauri,
  legacyDetect,
  legacyImport,
  onAgentStatus,
  pickDirectory,
  pickGgufFile,
  type DesktopConfig,
  type LegacyDetection,
} from "@/lib/tauri-bridge";
import { invalidateConsent, track } from "@/lib/telemetry";
import { cn } from "@/lib/utils";
import {
  FIRST_TASK_PROMPT,
  INITIAL_WIZARD_STATE,
  MODEL_DOWNLOADS,
  WIZARD_STEPS,
  canAdvance,
  commitModelStep,
  commitWorkspaceStep,
  describeHardware,
  describeRecommendation,
  nextStep,
  previousStep,
  reduceSidecarWait,
  stepIndex,
  type HardwareInfo,
  type SidecarWait,
  type WizardState,
} from "./wizard-steps";

interface Props {
  onComplete?: () => void;
}

/**
 * Re-fetch `GET /v1/agent/runtime` after the sidecar reports ready (R2.5), so
 * the bound workspace and model reflect the restart the workspace commit
 * triggered. Best-effort: a failure here must never block onboarding.
 */
async function fetchAgentRuntime(): Promise<void> {
  try {
    const { baseUrl } = await resolveWorkspaceServicesEndpoint();
    await fetch(`${baseUrl}/v1/agent/runtime`, {
      headers: { accept: "application/json" },
    });
  } catch {
    // The runtime endpoint is a confirmation, not a gate; ignore failures.
  }
}

/**
 * First-run wizard (§13.1).
 *
 * Six steps: welcome → workspace → model → hardware check → telemetry consent →
 * ready. Completion is persisted in the Tauri app config (`first_run_done`), so
 * the wizard is shown exactly once.
 */
export function OnboardingWizard({ onComplete }: Props) {
  const [state, setState] = useState<WizardState>(INITIAL_WIZARD_STATE);
  const [legacy, setLegacy] = useState<LegacyDetection | null>(null);
  const [importedCount, setImportedCount] = useState<number | null>(null);
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [hardwareLoading, setHardwareLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [keyStatus, setKeyStatus] = useState<"idle" | "testing" | "ok" | "bad">("idle");
  // Sidecar readiness (R2.4–R2.7): a committed workspace restarts the Gateway
  // sidecar; the wizard gates every subsequent step until it reports ready.
  const [sidecar, setSidecar] = useState<SidecarWait>({ kind: "idle" });
  // Local-model load wait (R3.x): persisting a local model selects it, loads it
  // into llama-server (forwarding its readiness deadline), and waits for it to
  // report ready before advancing — with retry/error feedback.
  const [modelWait, setModelWait] = useState<
    | { kind: "idle" }
    | { kind: "loading"; modelId: string; sinceMs: number; deadlineMs: number }
    | { kind: "failed"; reason: string }
  >({ kind: "idle" });
  const setDraft = useChatSurface((s) => s.setDraft);
  const setSelectedModel = useApp((s) => s.setSelectedModel);
  const llamaCppStatus = useApp((s) => s.llamaCppStatus);
  // The store action is the single writer for the workspace root: it updates
  // `workspaceRoot` in the app state *and* forwards to the Tauri supervisor.
  // Calling the raw bridge here left the store's copy null, so every later run
  // and session was created without a workspace.
  const applyWorkspaceRoot = useApp((s) => s.setWorkspaceRoot);

  const patch = useCallback((next: Partial<WizardState>) => {
    setState((current) => ({ ...current, ...next }));
  }, []);

  useEffect(() => {
    void (async () => {
      const cfg = await desktopConfigGet();
      patch({
        workspace: cfg.workspace_root ?? "",
        telemetry: cfg.telemetry_opt_in,
      });
      setLegacy(await legacyDetect());
    })();
  }, [patch]);

  // Probe hardware when the user reaches the hardware step, not at mount: the
  // probe shells out to nvidia-smi and there is no reason to pay for it if the
  // user never gets that far.
  useEffect(() => {
    if (state.step !== "hardware" || hardware || hardwareLoading) return;
    setHardwareLoading(true);
    void (async () => {
      try {
        const client = await getAgentClient();
        const info = await client.hardware();
        setHardware(info);
      } catch {
        setHardware(null);
      } finally {
        setHardwareLoading(false);
      }
    })();
  }, [state.step, hardware, hardwareLoading]);

  // Drive the sidecar-readiness reducer from supervisor status transitions.
  // Only meaningful after a workspace is committed (`sidecar.kind !== "idle"`):
  // a pre-commit status must not gate the very first step.
  useEffect(() => {
    if (!isTauri()) return;
    let unsub: (() => void) | undefined;
    let cancelled = false;
    void onAgentStatus((status) => {
      setSidecar((prev) => {
        if (prev.kind === "idle") return prev;
        return reduceSidecarWait(prev, {
          kind: "phase",
          phase: status.running ? "ready" : status.last_error ? "error" : "restarting",
          detail: status.last_error ?? undefined,
          nowMs: Date.now(),
        });
      });
    }).then((fn) => {
      if (cancelled) fn();
      else unsub = fn;
    });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);

  // Deadline tick: only a waiting sidecar can time out (R2.6).
  useEffect(() => {
    if (sidecar.kind !== "waiting") return;
    const timer = setInterval(() => {
      setSidecar((prev) => reduceSidecarWait(prev, { kind: "tick", nowMs: Date.now() }));
    }, 1000);
    return () => clearInterval(timer);
  }, [sidecar.kind]);

  // On the sidecar reporting ready, re-fetch the runtime so the bound
  // workspace/model reflect the restart before the user continues (R2.5).
  useEffect(() => {
    if (sidecar.kind !== "ready") return;
    void fetchAgentRuntime();
  }, [sidecar.kind]);

  // Local-model load watch (R3.x): once the selected model reports ready, clear
  // the wait and advance; a load error surfaces for retry.
  useEffect(() => {
    if (modelWait.kind !== "loading") return;
    const st = llamaCppStatus;
    if (!st) return;
    if (st.loaded_model_id === modelWait.modelId && st.running) {
      setModelWait({ kind: "idle" });
      patch({ step: nextStep("model") });
    } else if (st.last_error) {
      setModelWait({ kind: "failed", reason: st.last_error });
    }
  }, [modelWait, llamaCppStatus, patch]);

  // Model-load deadline (R3.x): fail the wait if the model never becomes ready
  // within its readiness_deadline_secs window, so the Retry control appears.
  useEffect(() => {
    if (modelWait.kind !== "loading") return;
    const timer = setInterval(() => {
      setModelWait((prev) => {
        if (prev.kind !== "loading") return prev;
        if (Date.now() - prev.sinceMs >= prev.deadlineMs) {
          return { kind: "failed", reason: "The model did not become ready in time." };
        }
        return prev;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [modelWait.kind]);

  const finish = async () => {
    setBusy(true);
    try {
      // The workspace was persisted + mirrored at the workspace step
      // (`commitWorkspace`), so finish no longer carries it — it records only
      // first-run completion and the telemetry choice, preserving whatever root
      // the workspace step bound (or none, if the user skipped).
      const current = await desktopConfigGet();
      const cfg: DesktopConfig = {
        workspace_root: current.workspace_root ?? null,
        first_run_done: true,
        telemetry_opt_in: state.telemetry,
        legacy_imported: importedCount !== null,
      };
      await desktopConfigSet(cfg);
      invalidateConsent();
      await track("onboarding.completed", {
        workspace: cfg.workspace_root ?? "",
        telemetry: state.telemetry,
        modelChoice: state.modelChoice,
      });
      patch({ step: "ready" });
    } finally {
      setBusy(false);
    }
  };

  const startExploring = () => {
    // §13.1: hand the user a concrete first task instead of an empty composer. Written to the
    // Chat_Surface's draft rather than the app store's `input`, which no mounted composer reads since
    // 25.6 — the prompt used to land nowhere.
    setDraft(FIRST_TASK_PROMPT);
    onComplete?.();
  };

  const advance = () => patch({ step: nextStep(state.step) });
  const back = () => patch({ step: previousStep(state.step) });

  /**
   * Commit the workspace step (R2.1–R2.3) then advance. `commitWorkspaceStep`
   * returns the effects in required order — persist to `desktop.json`, mirror the
   * identical canonical path to the store + supervisor (which reloads the
   * explorer, since `FileTree` watches `workspaceRoot`), then advance. A chosen
   * root restarts the sidecar, so the wizard enters the readiness wait; skipping
   * (empty path) advances with no workspace bound and no wait.
   */
  const commitWorkspace = async (): Promise<void> => {
    for (const effect of commitWorkspaceStep(state)) {
      switch (effect.kind) {
        case "persist-workspace": {
          const current = await desktopConfigGet();
          await desktopConfigSet({ ...current, workspace_root: effect.root });
          break;
        }
        case "mirror-workspace":
          // Updates the store's `workspaceRoot` (which the explorer + git watch)
          // and forwards the identical canonical path to the supervisor.
          await applyWorkspaceRoot(effect.root);
          break;
        case "reload-explorer":
          // The File_Explorer re-reads whenever `workspaceRoot` changes, so the
          // mirror above already reloaded it; nothing imperative to do here.
          break;
        case "advance":
          patch({ step: effect.to });
          break;
        default:
          break;
      }
    }
    // A committed workspace restarts the sidecar; gate the next steps on it
    // reporting ready. We call `agentRestart` explicitly rather than assuming
    // persistence auto-restarts, then wait (R2.4). Skipping (empty path) leaves
    // the sidecar untouched (stays idle).
    if (isTauri() && state.workspace.trim().length > 0) {
      setSidecar((prev) =>
        reduceSidecarWait(prev, { kind: "phase", phase: "restarting", nowMs: Date.now() }),
      );
      try {
        await agentRestart();
      } catch {
        // The status listener surfaces a genuine failure; a rejected restart
        // request alone should not strand the wait — the deadline tick will
        // fail it if the sidecar never comes back.
      }
    }
  };

  /**
   * Retry a failed/stalled sidecar wait (R2.6): reset the deadline and restart
   * the agent again. Reachable from the wait banner's Retry control.
   */
  const retrySidecar = async (): Promise<void> => {
    if (!isTauri()) return;
    setSidecar({
      kind: "waiting",
      reason: "Restarting the agent for the new workspace…",
      sinceMs: Date.now(),
    });
    try {
      await agentRestart();
    } catch {
      // Deadline tick will fail the wait if the sidecar never reports ready.
    }
  };

  /**
   * Commit the model step (R3.1, R4.1) then advance. A local choice registers
   * the chosen `.gguf` in the Local_Model_Registry and selects it; a cloud
   * choice stores the provider key in the OS secure store. Without this the
   * wizard advanced with the model choice held only in local state and never
   * committed — leaving the app with no usable model after onboarding (design
   * defect #2). Advance is applied synchronously (last), so the model is
   * registered before the step changes.
   */
  const commitModel = (): void => {
    for (const effect of commitModelStep(state)) {
      switch (effect.kind) {
        case "register-local-model": {
          const existing = loadLocalModels();
          const model = existing.find((m) => m.id === effect.model.id) ?? effect.model;
          if (!existing.some((m) => m.id === effect.model.id)) {
            saveLocalModels([...existing, effect.model]);
          }
          // R3.x — persisting a local model immediately SELECTS it, which loads
          // it into llama-server (forwarding readiness_deadline_secs via the
          // store's setSelectedModel), then we WAIT for it to report ready
          // before advancing. In the browser preview there is no runtime, so we
          // register-only and let the (last) `advance` effect proceed.
          if (isTauri()) {
            setSelectedModel({ provider: "llamacpp", model: model.id });
            setModelWait({
              kind: "loading",
              modelId: model.id,
              sinceMs: Date.now(),
              deadlineMs: readinessDeadlineSecs(model) * 1000,
            });
          }
          break;
        }
        case "store-provider-key":
          void secureStore.set(`provider.${effect.provider}.api_key`, state.cloudKey.trim());
          break;
        case "fetch-runtime":
          break;
        case "advance":
          // A local choice in the desktop app defers the advance to the model-
          // ready effect below; every other case advances synchronously here.
          if (isTauri() && state.modelChoice === "local" && state.modelPath.trim().length > 0) {
            break;
          }
          patch({ step: effect.to });
          break;
        default:
          break;
      }
    }
  };

  /**
   * Retry a failed local-model load (R3.x): re-select the model (re-issuing the
   * load) and reset the wait deadline.
   */
  const retryModel = (): void => {
    const model = loadLocalModels().find((m) => m.path === state.modelPath.trim());
    if (!model) return;
    setSelectedModel({ provider: "llamacpp", model: model.id });
    setModelWait({
      kind: "loading",
      modelId: model.id,
      sinceMs: Date.now(),
      deadlineMs: readinessDeadlineSecs(model) * 1000,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 backdrop-blur">
      <div className="w-full max-w-lg rounded-lg border border-border bg-card p-6 shadow-2xl">
        <Stepper step={state.step} />

        {/* Sidecar readiness wait (R2.4/R2.6): labelled spinner + progress bar
            while restarting, and a Retry that re-restarts + resets the deadline
            on failure. Visible across the steps the wait gates. */}
        {sidecar.kind === "waiting" && <WaitBanner label={sidecar.reason} spinning error={false} />}
        {sidecar.kind === "failed" && (
          <WaitBanner
            label={sidecar.reason}
            spinning={false}
            error
            onRetry={() => void retrySidecar()}
          />
        )}

        {state.step === "welcome" && (
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold">Welcome to Zoc AI</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              A local-first agentic coding workspace. Plans, edits and verifies changes in your
              project — on your machine.
            </p>
            {!isTauri() && (
              <p className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-200">
                Running in the browser preview — keychain, filesystem and model loading are
                unavailable here.
              </p>
            )}
            <Footer onNext={advance} nextLabel="Get started" />
          </section>
        )}

        {state.step === "workspace" && (
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <FolderOpen className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold">Open workspace</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Choose a project folder to work in. Zoc indexes it and runs agents inside it. You can
              change this later in Settings.
            </p>
            <div className="space-y-1">
              <Label htmlFor="ws">Workspace path</Label>
              <div className="flex gap-2">
                <Input
                  id="ws"
                  value={state.workspace}
                  onChange={(e) => patch({ workspace: e.target.value })}
                  placeholder="/home/me/projects/my-app"
                  className="flex-1 font-mono"
                />
                <Button
                  type="button"
                  variant="secondary"
                  className="shrink-0"
                  onClick={async () => {
                    const picked = await pickDirectory(state.workspace || null);
                    if (picked) patch({ workspace: picked });
                  }}
                >
                  <FolderSearch className="mr-1.5 h-3.5 w-3.5" />
                  Browse
                </Button>
              </div>
            </div>

            {legacy?.present && (
              <div className="rounded border border-border bg-card/60 p-2 text-[12px]">
                <p className="text-muted-foreground">
                  Found a previous install at <code className="font-mono">{legacy.path}</code> with{" "}
                  {legacy.session_count} session(s).
                </p>
                {importedCount === null ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="mt-1.5"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        setImportedCount((await legacyImport()).imported_sessions);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Import sessions
                  </Button>
                ) : (
                  <p className="mt-1 text-emerald-300">Imported {importedCount} session(s).</p>
                )}
              </div>
            )}

            <Footer
              onBack={back}
              onNext={() => void commitWorkspace()}
              // Skipping advances with NO workspace bound — there is no
              // home-dir fallback. The ready step notes the agent stays
              // unavailable until a folder is opened.
              secondary={
                state.workspace.trim()
                  ? undefined
                  : { label: "Skip", onClick: () => void commitWorkspace() }
              }
            />
          </section>
        )}

        {state.step === "model" && (
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <Cpu className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold">Choose a model</h2>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <ChoiceCard
                icon={HardDrive}
                title="Local model"
                subtitle="Private, free"
                selected={state.modelChoice === "local"}
                onSelect={() => patch({ modelChoice: "local" })}
              />
              <ChoiceCard
                icon={Cloud}
                title="Cloud model"
                subtitle="Fast, easy"
                selected={state.modelChoice === "cloud"}
                onSelect={() => patch({ modelChoice: "cloud" })}
              />
            </div>

            {state.modelChoice === "local" && (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <Input
                    value={state.modelPath}
                    onChange={(e) => patch({ modelPath: e.target.value })}
                    placeholder="/models/qwen2.5-coder-7b-instruct-q4_k_m.gguf"
                    className="flex-1 font-mono text-[11px]"
                    aria-label="Path to a .gguf model"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    className="shrink-0"
                    onClick={async () => {
                      const picked = await pickGgufFile(state.modelPath || null);
                      if (picked) patch({ modelPath: picked });
                    }}
                  >
                    Browse for .gguf
                  </Button>
                </div>
                <div className="rounded border border-border bg-card/60 p-2">
                  <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                    Don&apos;t have one yet? Popular downloads:
                  </div>
                  <ul className="space-y-1">
                    {MODEL_DOWNLOADS.map((entry) => (
                      <li key={entry.name}>
                        <a
                          href={entry.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="flex items-center gap-1 text-[11.5px] text-primary hover:underline"
                        >
                          {entry.name}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                        <span className="text-[10.5px] text-muted-foreground">{entry.detail}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            {state.modelChoice === "cloud" && (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <select
                    value={state.cloudProvider}
                    onChange={(e) =>
                      patch({ cloudProvider: e.target.value as "openai" | "anthropic" })
                    }
                    aria-label="Cloud provider"
                    className="h-9 rounded-md border border-border bg-background px-2 text-xs"
                  >
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                  </select>
                  <Input
                    type="password"
                    value={state.cloudKey}
                    onChange={(e) => {
                      patch({ cloudKey: e.target.value });
                      setKeyStatus("idle");
                    }}
                    placeholder="API key"
                    className="flex-1 font-mono text-[11px]"
                    aria-label="API key"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={!state.cloudKey.trim() || keyStatus === "testing"}
                    onClick={async () => {
                      setKeyStatus("testing");
                      try {
                        const client = await getAgentClient();
                        const models = await client.discoverModels(
                          state.cloudProvider,
                          state.cloudKey,
                        );
                        setKeyStatus(models.length > 0 ? "ok" : "bad");
                      } catch {
                        setKeyStatus("bad");
                      }
                    }}
                  >
                    {keyStatus === "testing" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      "Test"
                    )}
                  </Button>
                </div>
                {keyStatus === "ok" && (
                  <p className="text-[11.5px] text-emerald-300">Key works — models discovered.</p>
                )}
                {keyStatus === "bad" && (
                  <p className="text-[11.5px] text-destructive">
                    That key was rejected, or no models are available for it.
                  </p>
                )}
                <p className="text-[10.5px] text-muted-foreground">
                  Keys are stored in your OS keychain, never in the project.
                </p>
              </div>
            )}

            {/* Local-model load wait (R3.x): while the selected model loads into
                llama-server, show a labelled spinner; on failure/timeout offer
                Retry. Advance is deferred until the model reports ready. */}
            {modelWait.kind === "loading" && (
              <WaitBanner label="Loading the model into llama-server…" spinning error={false} />
            )}
            {modelWait.kind === "failed" && (
              <WaitBanner label={modelWait.reason} spinning={false} error onRetry={retryModel} />
            )}

            <Footer
              onBack={back}
              onNext={commitModel}
              nextDisabled={!canAdvance(state, sidecar) || modelWait.kind === "loading"}
              nextHint={
                modelWait.kind === "loading"
                  ? "Waiting for the model to become ready…"
                  : modelWait.kind === "failed"
                    ? modelWait.reason
                    : sidecar.kind === "waiting" || sidecar.kind === "failed"
                      ? sidecar.reason
                      : canAdvance(state, sidecar)
                        ? undefined
                        : "Pick a model and provide a path or key to continue"
              }
            />
          </section>
        )}

        {state.step === "hardware" && (
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <HardDrive className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold">Hardware check</h2>
            </div>
            {hardwareLoading ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Probing your machine…
              </p>
            ) : (
              <>
                <p className="text-sm" data-testid="hardware-summary">
                  {describeHardware(hardware)}
                </p>
                {hardware && (
                  <div className="rounded border border-primary/30 bg-primary/10 p-2.5">
                    <div className="text-[12px] font-medium">
                      Recommended: {describeRecommendation(hardware)}
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {hardware.recommendation.reason} ≈{hardware.recommendation.approx_size_gb} GB
                      download.
                    </p>
                    {state.modelChoice === "local" && !state.modelPath && (
                      <Button
                        size="sm"
                        variant="secondary"
                        className="mt-2"
                        onClick={() =>
                          patch({
                            modelPath: `${hardware.recommendation.model}.${hardware.recommendation.quantization}.gguf`,
                          })
                        }
                      >
                        Use this recommendation
                      </Button>
                    )}
                  </div>
                )}
                {!hardware && (
                  <p className="text-[11.5px] text-muted-foreground">
                    That&apos;s fine — you can pick a model manually and change it later in Settings
                    → Models.
                  </p>
                )}
              </>
            )}
            <Footer
              onBack={back}
              onNext={advance}
              nextDisabled={!canAdvance(state, sidecar)}
              nextHint={
                sidecar.kind === "waiting" || sidecar.kind === "failed" ? sidecar.reason : undefined
              }
            />
          </section>
        )}

        {state.step === "telemetry" && (
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold">Help improve Zoc?</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Help improve Zoc by sharing anonymous usage stats? (No code, no file names, no
              personal data.)
            </p>
            <p className="text-[11px] text-muted-foreground">
              Only counters — which mode you used, how long a run took, whether it succeeded. Change
              it anytime in Settings → Privacy.
            </p>
            <label className="flex items-center justify-between rounded border border-border bg-card/60 p-3 text-sm">
              <span>Share anonymous usage stats</span>
              <Switch checked={state.telemetry} onCheckedChange={(v) => patch({ telemetry: v })} />
            </label>
            <Footer
              onBack={back}
              onNext={() => void finish()}
              nextLabel="Finish"
              nextDisabled={busy || !canAdvance(state, sidecar)}
              nextHint={
                sidecar.kind === "waiting" || sidecar.kind === "failed" ? sidecar.reason : undefined
              }
            />
          </section>
        )}

        {state.step === "ready" && (
          <section className="space-y-3 text-center">
            <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-400" />
            <h2 className="text-lg font-semibold">Zoc is ready</h2>
            <p className="text-sm text-muted-foreground">Here&apos;s your first task:</p>
            <p className="rounded border border-border bg-card/60 p-2 font-mono text-[12px]">
              {FIRST_TASK_PROMPT}
            </p>
            <Button onClick={startExploring}>
              Start exploring <ArrowRight className="ml-1 h-3.5 w-3.5" />
            </Button>
          </section>
        )}
      </div>
    </div>
  );
}

/**
 * A labelled readiness indicator (R2.4/R2.6, R3.x): a spinner + indeterminate
 * progress bar while waiting, or an error line with a Retry control on failure.
 */
function WaitBanner({
  label,
  spinning,
  error,
  onRetry,
}: {
  label: string;
  spinning: boolean;
  error: boolean;
  onRetry?: () => void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="wait-banner"
      className={cn(
        "mb-3 rounded border p-2.5 text-[12px]",
        error
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-primary/30 bg-primary/10 text-foreground",
      )}
    >
      <div className="flex items-center gap-2">
        {spinning && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
        <span>{label}</span>
        {error && onRetry && (
          <Button
            size="sm"
            variant="secondary"
            className="ml-auto"
            data-testid="wait-retry"
            onClick={onRetry}
          >
            Retry
          </Button>
        )}
      </div>
      {spinning && (
        <div className="mt-2 h-1 w-full overflow-hidden rounded bg-muted" aria-hidden="true">
          <div className="h-full w-1/3 animate-pulse rounded bg-primary" />
        </div>
      )}
    </div>
  );
}

function Footer({
  onBack,
  onNext,
  nextLabel = "Continue",
  nextDisabled = false,
  nextHint,
  secondary,
}: {
  onBack?: () => void;
  onNext: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  nextHint?: string;
  secondary?: { label: string; onClick: () => void };
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        {onBack ? (
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          {secondary && (
            <Button variant="ghost" onClick={secondary.onClick}>
              {secondary.label}
            </Button>
          )}
          <Button onClick={onNext} disabled={nextDisabled}>
            {nextLabel} <ArrowRight className="ml-1 h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {nextHint && <p className="text-right text-[10.5px] text-muted-foreground">{nextHint}</p>}
    </div>
  );
}

function ChoiceCard({
  icon: Icon,
  title,
  subtitle,
  selected,
  onSelect,
}: {
  icon: typeof Cpu;
  title: string;
  subtitle: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors",
        selected
          ? "border-primary bg-primary/10"
          : "border-border hover:border-primary/40 hover:bg-accent/40",
      )}
    >
      <Icon className={cn("h-4 w-4", selected ? "text-primary" : "text-muted-foreground")} />
      <span className="text-[13px] font-medium">{title}</span>
      <span className="text-[11px] text-muted-foreground">{subtitle}</span>
    </button>
  );
}

function Stepper({ step }: { step: (typeof WIZARD_STEPS)[number] }) {
  const index = stepIndex(step);
  return (
    <div className="mb-4 flex items-center gap-1.5">
      {WIZARD_STEPS.slice(0, WIZARD_STEPS.length - 1).map((s, i) => (
        <span
          key={s}
          className={cn(
            "h-1 flex-1 rounded-full",
            i <= Math.min(index, WIZARD_STEPS.length - 2) ? "bg-primary" : "bg-muted",
          )}
        />
      ))}
    </div>
  );
}
