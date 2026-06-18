import { useEffect, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  FolderOpen,
  FolderSearch,
  KeyRound,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  desktopConfigGet,
  desktopConfigSet,
  isTauri,
  legacyDetect,
  legacyImport,
  pickDirectory,
  setWorkspaceRoot,
  type DesktopConfig,
  type LegacyDetection,
} from "@/lib/tauri-bridge";
import { invalidateConsent, track } from "@/lib/telemetry";

type Step = "welcome" | "workspace" | "migration" | "telemetry" | "done";

interface Props {
  onComplete?: () => void;
}

export function OnboardingWizard({ onComplete }: Props) {
  const [step, setStep] = useState<Step>("welcome");
  const [workspace, setWorkspace] = useState("");
  const [telemetry, setTelemetry] = useState(false);
  const [legacy, setLegacy] = useState<LegacyDetection | null>(null);
  const [importedCount, setImportedCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const cfg = await desktopConfigGet();
      if (cfg.workspace_root) setWorkspace(cfg.workspace_root);
      setTelemetry(cfg.telemetry_opt_in);
      const det = await legacyDetect();
      setLegacy(det);
    })();
  }, []);

  const next = (s: Step) => () => setStep(s);

  const persistAndFinish = async () => {
    setBusy(true);
    try {
      const cfg: DesktopConfig = {
        workspace_root: workspace || null,
        first_run_done: true,
        telemetry_opt_in: telemetry,
        legacy_imported: importedCount !== null,
      };
      await desktopConfigSet(cfg);
      // Push the chosen workspace into the Rust-side scope guard so FS /
      // patch commands begin enforcing it immediately.
      if (cfg.workspace_root) await setWorkspaceRoot(cfg.workspace_root);
      invalidateConsent();
      await track("onboarding.completed", { workspace, telemetry });
      onComplete?.();
    } finally {
      setBusy(false);
    }
  };

  const browseWorkspace = async () => {
    const picked = await pickDirectory(workspace.trim() || null);
    if (picked) setWorkspace(picked);
  };

  const runImport = async () => {
    setBusy(true);
    try {
      const result = await legacyImport();
      setImportedCount(result.imported_sessions);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 backdrop-blur">
      <div className="w-full max-w-lg rounded-lg border border-border bg-card p-6 shadow-2xl">
        <Stepper step={step} />
        {step === "welcome" && (
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold">Welcome to Zoc AI</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              A local-first agentic coding workspace. We&apos;ll get you set up in four short steps.
            </p>
            {!isTauri() && (
              <p className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-200">
                Running in the browser preview — keychain, filesystem, and migration are read-only here.
              </p>
            )}
            <div className="flex justify-end">
              <Button onClick={next("workspace")}>
                Get started <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Button>
            </div>
          </section>
        )}

        {step === "workspace" && (
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <FolderOpen className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold">Pick your workspace</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Zoc AI will index this folder and run agents inside it. You can change this later in Settings.
            </p>
            <div className="space-y-1">
              <Label htmlFor="ws">Workspace path</Label>
              <div className="flex gap-2">
                <Input
                  id="ws"
                  value={workspace}
                  onChange={(e) => setWorkspace(e.target.value)}
                  placeholder="/home/me/projects/my-app"
                  className="flex-1 font-mono"
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={browseWorkspace}
                  className="shrink-0"
                >
                  <FolderSearch className="mr-1.5 h-3.5 w-3.5" />
                  Browse
                </Button>
              </div>
              {!isTauri() && (
                <p className="text-[11px] text-muted-foreground">
                  The folder picker opens in the desktop app. In the browser preview, type the path
                  manually.
                </p>
              )}
            </div>
            <div className="flex justify-between">
              <Button variant="ghost" onClick={next("welcome")}>
                Back
              </Button>
              <Button onClick={next("migration")} disabled={!workspace.trim()}>
                Continue <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Button>
            </div>
          </section>
        )}

        {step === "migration" && (
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold">Import from legacy</h2>
            </div>
            {legacy?.present ? (
              <p className="text-sm text-muted-foreground">
                Found a previous Zoc AI install at{" "}
                <code className="font-mono">{legacy.path}</code> with {legacy.session_count} session(s).
                Import them now?
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                No legacy Zoc AI install detected. You can skip this step.
              </p>
            )}
            {importedCount !== null && (
              <p className="rounded border border-emerald-500/40 bg-emerald-500/10 p-2 text-[12px] text-emerald-200">
                Imported {importedCount} session(s).
              </p>
            )}
            <div className="flex justify-between">
              <Button variant="ghost" onClick={next("workspace")}>
                Back
              </Button>
              <div className="flex gap-2">
                {legacy?.present && (
                  <Button variant="secondary" onClick={runImport} disabled={busy}>
                    Import
                  </Button>
                )}
                <Button onClick={next("telemetry")}>
                  Continue <ArrowRight className="ml-1 h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </section>
        )}

        {step === "telemetry" && (
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold">Local telemetry</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Opt in to local-only event logs (written to{" "}
              <code className="font-mono">~/.zoc-studio/logs/telemetry.log</code>).
              Nothing leaves your machine. You can change this anytime in Settings.
            </p>
            <label className="flex items-center justify-between rounded border border-border bg-card/60 p-3 text-sm">
              <span>Enable local telemetry</span>
              <Switch checked={telemetry} onCheckedChange={setTelemetry} />
            </label>
            <div className="flex justify-between">
              <Button variant="ghost" onClick={next("migration")}>
                Back
              </Button>
              <Button
                onClick={async () => {
                  await persistAndFinish();
                  setStep("done");
                }}
                disabled={busy}
              >
                Finish <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Button>
            </div>
          </section>
        )}

        {step === "done" && (
          <section className="space-y-3 text-center">
            <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-400" />
            <h2 className="text-lg font-semibold">You&apos;re set</h2>
            <p className="text-sm text-muted-foreground">Happy hacking.</p>
            <Button onClick={() => onComplete?.()}>Open Zoc AI</Button>
          </section>
        )}
      </div>
    </div>
  );
}

function Stepper({ step }: { step: Step }) {
  const order: Step[] = ["welcome", "workspace", "migration", "telemetry", "done"];
  const idx = order.indexOf(step);
  return (
    <div className="mb-4 flex items-center gap-1.5">
      {order.slice(0, 4).map((s, i) => (
        <span
          key={s}
          className={
            "h-1 flex-1 rounded-full " +
            (i <= Math.min(idx, 3) ? "bg-primary" : "bg-muted")
          }
        />
      ))}
    </div>
  );
}
