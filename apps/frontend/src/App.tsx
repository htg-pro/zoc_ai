import { useEffect, useState } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Shell } from "@/components/layout/Shell";
import { OnboardingWizard } from "@/features/onboarding/OnboardingWizard";
import { AgentStreamProvider } from "@/features/agent/AgentStreamContext";
import { AgentPanel } from "@/features/agent/AgentPanel";
import { currentViewerContext } from "@/features/agent/share-session";
import { getAgentClient } from "@/lib/agent-client";
import { useApp } from "@/lib/store";
import { getPlugins } from "@/lib/plugins";
import { createDefaultPluginSandbox, initPluginRuntime } from "@/lib/plugin-runtime";
import { migrateSecretShadow } from "@/lib/secure-store";
import { desktopConfigGet, isTauri, setWorkspaceRoot } from "@/lib/tauri-bridge";
import { startTelemetry, track } from "@/lib/telemetry";
import { setTrustWorkspace } from "@/lib/trust";

export function App() {
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const loadSessions = useApp((s) => s.loadSessions);
  const initLlamaCppStatus = useApp((s) => s.initLlamaCppStatus);
  const applyEffectiveSettings = useApp((s) => s.applyEffectiveSettings);
  const workspaceRoot = useApp((s) => s.workspaceRoot);
  const viewer = currentViewerContext();

  useEffect(() => {
    if (!viewer.readOnly) setTrustWorkspace(workspaceRoot);
  }, [viewer.readOnly, workspaceRoot]);

  useEffect(() => {
    if (viewer.readOnly) return undefined;
    // Seed runtime state from persisted user/workspace settings (Phase 10),
    // including the default conversation mode, before anything renders.
    applyEffectiveSettings({ includeMode: true });
    // Hydrate installed plugins so enabled ones contribute commands/views
    // into the palette from the first frame (Phase 12).
    getPlugins();
    // Part 5.1: run each enabled plugin in an isolated worker sandbox and route
    // contributed-command invocation into it (disposed on unmount).
    return initPluginRuntime(createDefaultPluginSandbox());
  }, [applyEffectiveSettings, viewer.readOnly]);

  useEffect(() => {
    if (viewer.readOnly) return;
    void (async () => {
      // R14.3: empty the `localStorage` secret shadow into the three-tier vault
      // before anything reads a provider key. First, so a Run that starts
      // immediately after boot resolves its key from the vault rather than from
      // a store that is about to be swept out from under it.
      await migrateSecretShadow().catch(() => undefined);
      // Warm the client + load real sessions if reachable.
      try {
        const c = await getAgentClient();
        await c.health().catch(() => null);
      } catch {
        /* ignore */
      }
      await loadSessions();
      await track("app.boot", { tauri: isTauri() });
      // Anonymous usage counter + opportunistic batch upload. No-op unless the
      // user opted in (§11.2). Never awaited on the render path.
      void startTelemetry(
        useApp.getState().selectedModel.provider === "llamacpp" ? "local" : "cloud",
      );

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
  }, [loadSessions, initLlamaCppStatus, viewer.readOnly]);

  return (
    <TooltipProvider delayDuration={150}>
      <AgentStreamProvider>
        {viewer.readOnly ? (
          <main className="h-screen min-h-0 w-screen overflow-hidden bg-[#0C0C10]">
            <AgentPanel />
          </main>
        ) : (
          <Shell />
        )}
      </AgentStreamProvider>
      {!viewer.readOnly && needsOnboarding && (
        <OnboardingWizard onComplete={() => setNeedsOnboarding(false)} />
      )}
    </TooltipProvider>
  );
}
