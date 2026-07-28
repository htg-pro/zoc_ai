// Feature: zoc-ai-agent-chat-overhaul, Task 14: production-path store wiring
import { describe, it, expect, beforeEach } from "vitest";
import { useApp } from "@/lib/store";
import type { TrackedRun } from "@/features/agent/agent-runs";

const initial = useApp.getState();

describe("store production-path wiring", () => {
  beforeEach(() => {
    useApp.setState({
      ...initial,
      sessions: [],
      chat: [],
      agentItems: [],
      trackedRuns: [],
      invalidProviders: {},
      composerSubmitSignal: 0,
      input: "",
      workspaceRoot: null,
    });
  });

  describe("createSession refuses a session without a real workspace (R2.x, no '/' fallback)", () => {
    it("returns null and creates nothing for an empty root", async () => {
      const result = await useApp.getState().createSession("New", "");
      expect(result).toBeNull();
      expect(useApp.getState().sessions).toHaveLength(0);
    });

    it("returns null and creates nothing for a '/' root", async () => {
      const result = await useApp.getState().createSession("New", "/");
      expect(result).toBeNull();
      expect(useApp.getState().sessions).toHaveLength(0);
    });
  });

  describe("requestComposerSubmit routes a prompt through the Composer path (R21.3)", () => {
    it("inserts the prompt into the input and bumps the submit signal", () => {
      const before = useApp.getState().composerSubmitSignal;
      useApp.getState().requestComposerSubmit("  do the thing  ");
      expect(useApp.getState().input).toBe("do the thing");
      expect(useApp.getState().composerSubmitSignal).toBe(before + 1);
    });

    it("ignores an empty prompt", () => {
      const before = useApp.getState().composerSubmitSignal;
      useApp.getState().requestComposerSubmit("   ");
      expect(useApp.getState().composerSubmitSignal).toBe(before);
    });
  });

  describe("provider-invalid state (R4.5)", () => {
    it("marks and clears only the named provider", () => {
      useApp.getState().markProviderInvalid("openai");
      expect(useApp.getState().invalidProviders.openai).toBe(true);
      expect(useApp.getState().invalidProviders.anthropic).toBeUndefined();
      useApp.getState().clearProviderInvalid("openai");
      expect(useApp.getState().invalidProviders.openai).toBeUndefined();
    });

    it("re-selecting a provider's model clears its invalid flag", () => {
      useApp.getState().markProviderInvalid("groq");
      expect(useApp.getState().invalidProviders.groq).toBe(true);
      useApp.getState().setSelectedModel({ provider: "groq", model: "llama-3.1-70b" });
      expect(useApp.getState().invalidProviders.groq).toBeUndefined();
    });
  });

  describe("setRunPhase (R8.x) never reopens a terminal run", () => {
    it("leaves a terminal run's phase unchanged", () => {
      const run: TrackedRun = {
        runId: "r1",
        mode: "agent",
        phase: "done",
        title: "t",
        startedAt: 0,
        endedAt: 10,
      };
      useApp.setState({ trackedRuns: [run] });
      useApp.getState().setRunPhase("running", "r1");
      expect(useApp.getState().trackedRuns[0].phase).toBe("done");
    });

    it("updates a live run's transient phase", () => {
      const run: TrackedRun = {
        runId: "r2",
        mode: "agent",
        phase: "running",
        title: "t",
        startedAt: 0,
      };
      useApp.setState({ trackedRuns: [run] });
      useApp.getState().setRunPhase("stalled", "r2");
      expect(useApp.getState().trackedRuns[0].phase).toBe("stalled");
    });
  });
});
