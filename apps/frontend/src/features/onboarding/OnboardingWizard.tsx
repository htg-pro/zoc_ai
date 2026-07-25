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
import { getAgentClient } from "@/lib/agent-client";
import {
  desktopConfigGet,
  desktopConfigSet,
  isTauri,
  legacyDetect,
  legacyImport,
  pickDirectory,
  pickGgufFile,
  setWorkspaceRoot,
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
  describeHardware,
  describeRecommendation,
  nextStep,
  previousStep,
  stepIndex,
  type HardwareInfo,
  type WizardState,
} from "./wizard-steps";

interface Props {
  onComplete?: () => void;
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
  const setInput = useApp((s) => s.setInput);

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

  const finish = async () => {
    setBusy(true);
    try {
      const cfg: DesktopConfig = {
        workspace_root: state.workspace || null,
        first_run_done: true,
        telemetry_opt_in: state.telemetry,
        legacy_imported: importedCount !== null,
      };
      await desktopConfigSet(cfg);
      if (cfg.workspace_root) await setWorkspaceRoot(cfg.workspace_root);
      invalidateConsent();
      await track("onboarding.completed", {
        workspace: state.workspace,
        telemetry: state.telemetry,
        modelChoice: state.modelChoice,
      });
      patch({ step: "ready" });
    } finally {
      setBusy(false);
    }
  };

  const startExploring = () => {
    // §13.1: hand the user a concrete first task instead of an empty composer.
    setInput(FIRST_TASK_PROMPT);
    onComplete?.();
  };

  const advance = () => patch({ step: nextStep(state.step) });
  const back = () => patch({ step: previousStep(state.step) });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 backdrop-blur">
      <div className="w-full max-w-lg rounded-lg border border-border bg-card p-6 shadow-2xl">
        <Stepper step={state.step} />

        {state.step === "welcome" && (
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold">Welcome to Zoc AI</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              A local-first agentic coding workspace. Plans, edits and verifies
              changes in your project — on your machine.
            </p>
            {!isTauri() && (
              <p className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-200">
                Running in the browser preview — keychain, filesystem and model
                loading are unavailable here.
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
              Choose a project folder to work in. Zoc indexes it and runs agents
              inside it. You can change this later in Settings.
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
                  Found a previous install at{" "}
                  <code className="font-mono">{legacy.path}</code> with{" "}
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
                  <p className="mt-1 text-emerald-300">
                    Imported {importedCount} session(s).
                  </p>
                )}
              </div>
            )}

            <Footer
              onBack={back}
              onNext={advance}
              // Skipping is allowed: an empty path means "use the home dir".
              secondary={
                state.workspace.trim() ? undefined : { label: "Skip", onClick: advance }
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
                        <span className="text-[10.5px] text-muted-foreground">
                          {entry.detail}
                        </span>
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
                  <p className="text-[11.5px] text-emerald-300">
                    Key works — models discovered.
                  </p>
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

            <Footer
              onBack={back}
              onNext={advance}
              nextDisabled={!canAdvance(state)}
              nextHint={
                canAdvance(state)
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
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Probing your
                machine…
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
                      {hardware.recommendation.reason} ≈
                      {hardware.recommendation.approx_size_gb} GB download.
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
                    That&apos;s fine — you can pick a model manually and change it
                    later in Settings → Models.
                  </p>
                )}
              </>
            )}
            <Footer onBack={back} onNext={advance} />
          </section>
        )}

        {state.step === "telemetry" && (
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold">Help improve Zoc?</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Help improve Zoc by sharing anonymous usage stats? (No code, no file
              names, no personal data.)
            </p>
            <p className="text-[11px] text-muted-foreground">
              Only counters — which mode you used, how long a run took, whether it
              succeeded. Change it anytime in Settings → Privacy.
            </p>
            <label className="flex items-center justify-between rounded border border-border bg-card/60 p-3 text-sm">
              <span>Share anonymous usage stats</span>
              <Switch
                checked={state.telemetry}
                onCheckedChange={(v) => patch({ telemetry: v })}
              />
            </label>
            <Footer
              onBack={back}
              onNext={() => void finish()}
              nextLabel="Finish"
              nextDisabled={busy}
            />
          </section>
        )}

        {state.step === "ready" && (
          <section className="space-y-3 text-center">
            <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-400" />
            <h2 className="text-lg font-semibold">Zoc is ready</h2>
            <p className="text-sm text-muted-foreground">
              Here&apos;s your first task:
            </p>
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
      {nextHint && (
        <p className="text-right text-[10.5px] text-muted-foreground">{nextHint}</p>
      )}
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
