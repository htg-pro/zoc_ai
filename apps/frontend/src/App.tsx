import { useEffect, useState } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Shell } from "@/components/layout/Shell";
import { OnboardingWizard } from "@/features/onboarding/OnboardingWizard";
import { getAgentClient } from "@/lib/agent-client";
import { useApp } from "@/lib/store";
import { desktopConfigGet, isTauri, setWorkspaceRoot } from "@/lib/tauri-bridge";
import { track } from "@/lib/telemetry";

export function App() {
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const loadSessions = useApp((s) => s.loadSessions);
  const initLlamaCppStatus = useApp((s) => s.initLlamaCppStatus);

  useEffect(() => {
    void (async () => {
      // Warm the client + load real sessions if reachable.
      try {
        const c = await getAgentClient();
        await c.health().catch(() => null);
      } catch {
        /* ignore */
      }
      await loadSessions();
      await track("app.boot", { tauri: isTauri() });

      if (isTauri()) {
        const cfg = await desktopConfigGet();
        // Seed the Rust-side workspace scope from persisted config so
        // FS commands work on the very first frame, before the user
        // touches Settings again.
        if (cfg.workspace_root) await setWorkspaceRoot(cfg.workspace_root);
        if (!cfg.first_run_done) setNeedsOnboarding(true);
      }
      // Subscribe to llama-server supervisor status so the ModelPicker can
      // show a "loading / loaded / error" badge without polling.
      void initLlamaCppStatus();
    })();
  }, [loadSessions, initLlamaCppStatus]);

  return (
    <TooltipProvider delayDuration={150}>
      <Shell />
      {needsOnboarding && <OnboardingWizard onComplete={() => setNeedsOnboarding(false)} />}
    </TooltipProvider>
  );
}
