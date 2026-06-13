import { describe, it, expect, beforeEach, vi } from "vitest";
import { useApp } from "@/lib/store";
import * as agentClient from "@/lib/agent-client";
import type {
  AgentClient,
  CodeReviewRequest,
  TestGenRequest,
} from "@/lib/agent-client";
import type {
  AgentEvent,
  CodeReviewReport,
  ReplitPlan,
  ReplitTask,
  SlashCommandName,
  TestGenerationResult,
  ToolGrant,
} from "@llama-studio/shared-types";

const initial = useApp.getState();
const now = "2026-06-11T00:00:00.000Z";

function replitTask(overrides: Partial<ReplitTask> = {}): ReplitTask {
  return {
    id: "task-1",
    session_id: "s-test",
    plan_id: "plan-1",
    title: "Build the actual user-facing screens",
    summary: "Create a polished portfolio website.",
    status: "draft",
    priority: "high",
    depends_on: [],
    files_likely_changed: ["src/App.tsx", "src/styles.css"],
    done_looks_like: ["Portfolio opens on the first screen"],
    test_plan: ["Frontend build passes"],
    validation_attempts: 0,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function replitPlan(overrides: Partial<ReplitPlan> = {}, tasks?: ReplitTask[]): ReplitPlan {
  const planTasks = tasks ?? [replitTask()];
  return {
    id: "plan-1",
    session_id: "s-test",
    title: "Build a portfolio website",
    summary: "Create a real portfolio website with content and validation.",
    status: "draft",
    tasks: planTasks,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe("app store", () => {
  beforeEach(() => {
    useApp.setState({
      ...initial,
      paletteOpen: false,
      attachments: [...initial.attachments],
      pendingPatches: [...initial.pendingPatches],
      acceptedHunks: {},
      chat: [...initial.chat],
      agentItems: [...initial.agentItems],
    });
  });

  it("toggles the command palette", () => {
    expect(useApp.getState().paletteOpen).toBe(false);
    useApp.getState().togglePalette();
    expect(useApp.getState().paletteOpen).toBe(true);
    useApp.getState().togglePalette(false);
    expect(useApp.getState().paletteOpen).toBe(false);
  });

  it("pauses and resumes an active run and clears pause on stop", () => {
    // Guard: pausing while idle is a no-op.
    expect(useApp.getState().agentPaused).toBe(false);
    useApp.getState().pauseAgent();
    expect(useApp.getState().agentPaused).toBe(false);

    // While a run is active, pause/resume toggle the gate flag.
    useApp.setState({ streaming: true, isRunning: true });
    useApp.getState().pauseAgent();
    expect(useApp.getState().agentPaused).toBe(true);
    useApp.getState().resumeAgent();
    expect(useApp.getState().agentPaused).toBe(false);

    // Stopping always clears the pause flag.
    useApp.getState().pauseAgent();
    expect(useApp.getState().agentPaused).toBe(true);
    useApp.getState().cancelStream();
    expect(useApp.getState().agentPaused).toBe(false);
    expect(useApp.getState().streaming).toBe(false);
  });

  it("sets the autonomy level", () => {
    useApp.getState().setAutonomy("Low");
    expect(useApp.getState().autonomy).toBe("Low");
    useApp.getState().setAutonomy("Medium");
    expect(useApp.getState().autonomy).toBe("Medium");
  });

  it("opens files from the mock tree and tracks active file", () => {
    useApp.getState().openFile("/services/agent.py");
    expect(useApp.getState().activeFile).toBe("/services/agent.py");
    expect(useApp.getState().openFiles.some((f) => f.path === "/services/agent.py")).toBe(true);
    expect(useApp.getState().mainView).toBe("editor");
  });

  it("ignores unknown file paths", () => {
    const before = useApp.getState().openFiles.length;
    useApp.getState().openFile("/does/not/exist.txt");
    expect(useApp.getState().openFiles.length).toBe(before);
  });

  it("accepts and rejects a diff", async () => {
    useApp.setState({
      pendingPatches: [
        {
          id: "patch-test-1",
          file_path: "src/example.ts",
          unified_diff:
            "--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n",
          summary: "tweak example",
        },
      ],
      acceptedHunks: {},
    });
    const id = useApp.getState().pendingPatches[0].id;
    useApp.getState().toggleHunk(id, 0);
    expect(useApp.getState().acceptedHunks[id]?.has(0)).toBe(true);
    await useApp.getState().applyPatch(id);
    expect(useApp.getState().pendingPatches.find((p) => p.id === id)).toBeUndefined();
  });

  it("appends a user message and a simulated assistant reply", async () => {
    const start = useApp.getState().chat.length;
    useApp.getState().sendUserMessage("hello agent");
    expect(useApp.getState().chat.length).toBe(start + 1);
    await new Promise((r) => setTimeout(r, 700));
    expect(useApp.getState().chat.length).toBe(start + 2);
    expect(useApp.getState().streaming).toBe(false);
  });

  it("routes /test to the structured testgen endpoint exactly once (no streaming dup)", async () => {
    const codeReview = vi.fn();
    const testGen = vi
      .fn<(id: string, req: TestGenRequest) => Promise<TestGenerationResult>>()
      .mockResolvedValue({
        framework: "vitest",
        target: "src/foo.ts",
        test_file: "tests/foo.test.ts",
        test_source: "import { it } from 'vitest'; it('x', () => {});\n",
        passed: true,
        attempts: 1,
        last_output: null,
      });
    const runSlashCommand = vi.fn();
    const fake = {
      codeReview: (_id: string, req: CodeReviewRequest) => codeReview(_id, req),
      testGen: (id: string, req: TestGenRequest) => testGen(id, req),
      runSlashCommand,
    } as unknown as AgentClient;
    vi.spyOn(agentClient, "getAgentClient").mockResolvedValue(fake);
    useApp.setState({ liveMode: true });

    await useApp.getState().runSlashCommand("test", { target: "src/foo.ts" });

    expect(testGen).toHaveBeenCalledTimes(1);
    expect(runSlashCommand).not.toHaveBeenCalled();
    expect(useApp.getState().lastTestGen?.test_file).toBe("tests/foo.test.ts");
    expect(useApp.getState().agentItems.some((item) => item.type === "test")).toBe(true);
    expect(useApp.getState().streaming).toBe(false);
    vi.restoreAllMocks();
  });

  it("routes /review to the structured review endpoint exactly once", async () => {
    const review: CodeReviewReport = {
      summary: "looks fine",
      findings: [
        { file: "src/a.ts", line: 1, severity: "low", message: "nit" },
      ],
    };
    const codeReview = vi
      .fn<(id: string, req: CodeReviewRequest) => Promise<CodeReviewReport>>()
      .mockResolvedValue(review);
    const runSlashCommand = vi.fn();
    const fake = {
      codeReview: (id: string, req: CodeReviewRequest) => codeReview(id, req),
      runSlashCommand,
    } as unknown as AgentClient;
    vi.spyOn(agentClient, "getAgentClient").mockResolvedValue(fake);
    useApp.setState({ liveMode: true });

    await useApp.getState().runSlashCommand("review", {});

    expect(codeReview).toHaveBeenCalledTimes(1);
    expect(runSlashCommand).not.toHaveBeenCalled();
    expect(useApp.getState().lastReview?.findings.length).toBe(1);
    expect(useApp.getState().agentItems.some((item) => item.type === "review")).toBe(true);
    vi.restoreAllMocks();
  });

  it("routes a slash command typed in the composer to runSlashCommand", async () => {
    const original = useApp.getState().runSlashCommand;
    const spy = vi.fn(async (_name: SlashCommandName, _args?: Record<string, unknown>) => {
      /* no-op */
    });
    useApp.setState({ runSlashCommand: spy });
    try {
      await useApp.getState().sendUserMessage("/explain src/foo.ts");
      expect(spy).toHaveBeenCalledTimes(1);
      const [name, args] = spy.mock.calls[0];
      expect(name).toBe("explain");
      expect(args).toEqual({ target: "src/foo.ts" });
      // The user message itself is still appended to the chat.
      const last = useApp.getState().chat[useApp.getState().chat.length - 1];
      expect(last.message?.content).toBe("/explain src/foo.ts");
    } finally {
      useApp.setState({ runSlashCommand: original });
    }
  });

  it("replaces a tool_call card by id as its status changes", async () => {
    async function* stream(): AsyncIterable<AgentEvent> {
      yield {
        type: "tool_call",
        session_id: "s",
        seq: 1,
        at: "t",
        tool_call: { id: "tc-stream-1", name: "read_file", arguments: {}, status: "pending" },
      };
      yield {
        type: "tool_call",
        session_id: "s",
        seq: 2,
        at: "t",
        tool_call: {
          id: "tc-stream-1",
          name: "read_file",
          arguments: {},
          status: "needs_approval",
        },
      };
      yield {
        type: "tool_call",
        session_id: "s",
        seq: 3,
        at: "t",
        tool_call: {
          id: "tc-stream-1",
          name: "read_file",
          arguments: {},
          status: "succeeded",
          result: "ok",
        },
      };
      yield { type: "done", session_id: "s", seq: 4, at: "t", ok: true };
    }
    const fake = {
      postMessage: vi.fn().mockResolvedValue({}),
      runAgent: () => stream(),
    } as unknown as AgentClient;
    vi.spyOn(agentClient, "getAgentClient").mockResolvedValue(fake);
    useApp.setState({ liveMode: true });

    await useApp.getState().sendUserMessage("do a thing");

    const entries = useApp.getState().chat.filter((e) => e.id === "tc-stream-1");
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("tool_call");
    expect(entries[0].toolCall?.status).toBe("succeeded");
    expect(useApp.getState().streaming).toBe(false);
    vi.restoreAllMocks();
  });

  it("does not duplicate the user message when the stream echoes it back", async () => {
    async function* stream(): AsyncIterable<AgentEvent> {
      yield {
        type: "message",
        session_id: "s",
        seq: 1,
        at: "t",
        message: {
          id: "persisted-user-1",
          role: "user",
          content: "please help",
          created_at: new Date().toISOString(),
        },
      };
      yield {
        type: "message",
        session_id: "s",
        seq: 2,
        at: "t",
        message: {
          id: "assistant-1",
          role: "assistant",
          content: "Sure.",
          created_at: new Date().toISOString(),
        },
      };
      yield { type: "done", session_id: "s", seq: 3, at: "t", ok: true };
    }
    const fake = {
      postMessage: vi.fn(),
      runAgent: () => stream(),
    } as unknown as AgentClient;
    vi.spyOn(agentClient, "getAgentClient").mockResolvedValue(fake);
    useApp.setState({ liveMode: true });

    await useApp.getState().sendUserMessage("please help");

    const userMessages = useApp
      .getState()
      .chat.filter((entry) => entry.message?.role === "user" && entry.message.content === "please help");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].id).toBe("persisted-user-1");
    expect(fake.postMessage).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("keeps normal chat clean when the sidecar emits a placeholder plan and duplicate summary", async () => {
    async function* stream(): AsyncIterable<AgentEvent> {
      yield {
        type: "plan",
        session_id: "s",
        seq: 1,
        at: "t",
        plan: {
          id: "placeholder-plan",
          goal: "hi",
          created_at: new Date().toISOString(),
          steps: [
            {
              id: "placeholder-step",
              title: "Complete the goal",
              detail: "",
              status: "pending",
              attempt: 0,
              done: false,
            },
          ],
        },
      };
      yield {
        type: "token",
        session_id: "s",
        seq: 2,
        at: "t",
        delta: "Hello! How can I assist you today?",
      };
      yield {
        type: "done",
        session_id: "s",
        seq: 3,
        at: "t",
        ok: true,
        summary: "Hello! How can I assist you today?",
      };
    }
    const fake = {
      runAgent: () => stream(),
    } as unknown as AgentClient;
    vi.spyOn(agentClient, "getAgentClient").mockResolvedValue(fake);
    useApp.setState({ liveMode: true });

    await useApp.getState().sendUserMessage("hi");

    const items = useApp.getState().agentItems;
    expect(items.some((item) => item.type === "plan")).toBe(false);
    expect(items.some((item) => item.type === "final_summary")).toBe(false);
    expect(
      items.some(
        (item) =>
          item.type === "agent_message" &&
          item.text === "Hello! How can I assist you today?" &&
          item.streaming === false,
      ),
    ).toBe(true);
    vi.restoreAllMocks();
  });

  it("deletes a session locally and moves active selection", async () => {
    const [first, second] = useApp.getState().sessions;
    useApp.setState({ liveMode: false, activeSessionId: first.id });

    const ok = await useApp.getState().deleteSession(first.id);

    expect(ok).toBe(true);
    expect(useApp.getState().sessions.some((session) => session.id === first.id)).toBe(false);
    expect(useApp.getState().activeSessionId).toBe(second.id);
  });

  it("grants and revokes a per-tool override in mock mode (no client call)", async () => {
    useApp.setState({ liveMode: false, toolGrants: [] });

    const granted = await useApp.getState().grantTool("run_command", true);
    expect(granted).toBe(true);
    const after = useApp.getState().toolGrants;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ tool: "run_command", granted: true, once: true });

    const revoked = await useApp.getState().revokeTool("run_command");
    expect(revoked).toBe(true);
    expect(useApp.getState().toolGrants).toHaveLength(0);
  });

  it("grants and revokes a per-tool override in live mode via the client", async () => {
    const setToolGrants = vi
      .fn<(id: string, grants: ToolGrant[]) => Promise<ToolGrant[]>>()
      .mockResolvedValueOnce([{ tool: "run_command", granted: true, once: false }])
      .mockResolvedValueOnce([]);
    const fake = {
      setToolGrants: (id: string, grants: ToolGrant[]) => setToolGrants(id, grants),
    } as unknown as AgentClient;
    vi.spyOn(agentClient, "getAgentClient").mockResolvedValue(fake);
    useApp.setState({ liveMode: true, toolGrants: [] });

    const granted = await useApp.getState().grantTool("run_command", false);
    expect(granted).toBe(true);
    expect(setToolGrants).toHaveBeenNthCalledWith(1, expect.any(String), [
      { tool: "run_command", granted: true, once: false },
    ]);
    expect(useApp.getState().toolGrants).toEqual([
      { tool: "run_command", granted: true, once: false },
    ]);

    const revoked = await useApp.getState().revokeTool("run_command");
    expect(revoked).toBe(true);
    expect(setToolGrants).toHaveBeenNthCalledWith(2, expect.any(String), [
      { tool: "run_command", granted: false, once: false },
    ]);
    expect(useApp.getState().toolGrants).toEqual([]);
    vi.restoreAllMocks();
  });

  it("loads tool grants from the client in live mode", async () => {
    const listToolGrants = vi
      .fn<(id: string) => Promise<ToolGrant[]>>()
      .mockResolvedValue([{ tool: "search", granted: true, once: false }]);
    const fake = {
      listToolGrants: (id: string) => listToolGrants(id),
    } as unknown as AgentClient;
    vi.spyOn(agentClient, "getAgentClient").mockResolvedValue(fake);
    useApp.setState({ liveMode: true, toolGrants: [] });

    await useApp.getState().loadToolGrants();

    expect(listToolGrants).toHaveBeenCalledTimes(1);
    expect(useApp.getState().toolGrants).toEqual([
      { tool: "search", granted: true, once: false },
    ]);
    vi.restoreAllMocks();
  });

  it("aborts an in-flight stream when cancelStream is invoked", async () => {
    let aborted = false;
    async function* stream(signal: AbortSignal): AsyncIterable<AgentEvent> {
      yield { type: "token", session_id: "s", seq: 1, at: "t", delta: "hello" };
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) {
          aborted = true;
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    }
    const fake = {
      postMessage: vi.fn().mockResolvedValue({}),
      runAgent: (_id: string, _req: unknown, signal?: AbortSignal) =>
        stream(signal ?? new AbortController().signal),
    } as unknown as AgentClient;
    vi.spyOn(agentClient, "getAgentClient").mockResolvedValue(fake);
    useApp.setState({ liveMode: true });

    const done = useApp.getState().sendUserMessage("hello");
    // Yield to the event loop so postMessage resolves and the stream begins.
    await new Promise((r) => setTimeout(r, 20));
    expect(useApp.getState().streaming).toBe(true);
    useApp.getState().cancelStream();
    await done;

    expect(aborted).toBe(true);
    expect(useApp.getState().streaming).toBe(false);
    // The abort is recorded as a "(cancelled)" system message in the chat.
    const last = useApp.getState().chat[useApp.getState().chat.length - 1];
    expect(last.message?.content).toBe("(cancelled)");
    vi.restoreAllMocks();
  });

  it("retryApproval re-runs via the client and streams the resulting events", async () => {
    async function* stream(): AsyncIterable<AgentEvent> {
      yield {
        type: "tool_call",
        session_id: "s",
        seq: 7,
        at: "t",
        tool_call: {
          id: "tc-retry-1",
          name: "write_file",
          arguments: {},
          status: "succeeded",
          result: "ok",
        },
      };
      yield { type: "done", session_id: "s", seq: 8, at: "t", ok: true };
    }
    const retryApproval = vi.fn(() => stream());
    const fake = { retryApproval } as unknown as AgentClient;
    vi.spyOn(agentClient, "getAgentClient").mockResolvedValue(fake);
    useApp.setState({ liveMode: true });

    const ok = await useApp.getState().retryApproval("cancelled-call");
    expect(ok).toBe(true);
    expect(retryApproval).toHaveBeenCalledWith(
      expect.any(String),
      "cancelled-call",
      expect.any(Object),
    );
    const entries = useApp.getState().chat.filter((e) => e.id === "tc-retry-1");
    expect(entries).toHaveLength(1);
    expect(entries[0].toolCall?.status).toBe("succeeded");
    expect(useApp.getState().streaming).toBe(false);
    vi.restoreAllMocks();
  });

  it("does not mark a mock Replit task ready without real validation", async () => {
    vi.useFakeTimers();
    try {
      useApp.setState({ liveMode: false, replitTasks: [], replitTaskLogs: {} });
      const task = await useApp.getState().createReplitTask({
        title: "T",
        summary: "S",
        priority: "medium",
        files_likely_changed: [],
        done_looks_like: [],
        test_plan: [],
      });
      expect(task).not.toBeNull();
      await useApp.getState().startReplitTask(task!.id);
      vi.advanceTimersByTime(1000);
      const current = useApp.getState().replitTasks.find((item) => item.id === task!.id);
      expect(current?.status).toBe("active");
      expect(current?.test_output).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates a plan for build requests without auto-approving (user controls Run)", async () => {
    const draftTask = replitTask();
    const plan = replitPlan({}, [draftTask]);
    const createReplitPlan = vi.fn().mockResolvedValue(plan);
    const approveReplitPlan = vi.fn();
    const startReplitTask = vi.fn();
    const runAgent = vi.fn();
    const fake = {
      createReplitPlan,
      approveReplitPlan,
      startReplitTask,
      runAgent,
    } as unknown as AgentClient;
    vi.spyOn(agentClient, "getAgentClient").mockResolvedValue(fake);
    useApp.setState({
      liveMode: true,
      activeSessionId: "s-test",
      replitPlans: [],
      replitTasks: [],
    });

    await useApp.getState().sendUserMessage("build a portfolio website");

    // A plan is created from the build request...
    expect(createReplitPlan).toHaveBeenCalledWith("s-test", "build a portfolio website");
    // ...but it is NOT auto-approved or auto-started. The user must click Run.
    expect(approveReplitPlan).not.toHaveBeenCalled();
    expect(startReplitTask).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
    expect(useApp.getState().mainView).toBe("editor");
    expect(useApp.getState().replitPlans[0].id).toBe("plan-1");
    vi.restoreAllMocks();
  });

  it("approves a pending Replit plan and starts the first runnable task from chat", async () => {
    const draftTask = replitTask();
    const approvedTask = replitTask({ status: "queued", updated_at: "2026-06-11T00:00:01.000Z" });
    const activeTask = replitTask({ status: "active", updated_at: "2026-06-11T00:00:02.000Z" });
    const draftPlan = replitPlan({}, [draftTask]);
    const approvedPlan = replitPlan(
      { status: "approved", updated_at: "2026-06-11T00:00:01.000Z" },
      [approvedTask],
    );
    const approveReplitPlan = vi.fn().mockResolvedValue(approvedPlan);
    const startReplitTask = vi.fn().mockResolvedValue(activeTask);
    const createReplitPlan = vi.fn();
    const runAgent = vi.fn();
    const fake = {
      approveReplitPlan,
      startReplitTask,
      createReplitPlan,
      runAgent,
    } as unknown as AgentClient;
    vi.spyOn(agentClient, "getAgentClient").mockResolvedValue(fake);
    useApp.setState({
      liveMode: true,
      activeSessionId: "s-test",
      replitPlans: [draftPlan],
      replitTasks: [draftTask],
      selectedReplitTaskId: null,
      replitTaskLogs: {},
    });

    await useApp.getState().sendUserMessage("ok implement this");

    expect(approveReplitPlan).toHaveBeenCalledWith("s-test", "plan-1");
    expect(startReplitTask).toHaveBeenCalledWith("s-test", "task-1");
    expect(createReplitPlan).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
    expect(useApp.getState().mainView).toBe("editor");
    expect(useApp.getState().activity).toBe("files");
    expect(useApp.getState().selectedReplitTaskId).toBe("task-1");
    expect(useApp.getState().replitTasks.find((task) => task.id === "task-1")?.status).toBe("active");
    vi.restoreAllMocks();
  });

  it("retryApproval is a no-op in mock mode", async () => {
    useApp.setState({ liveMode: false });
    const before = useApp.getState().chat.length;
    const ok = await useApp.getState().retryApproval("c1");
    expect(ok).toBe(true);
    expect(useApp.getState().chat.length).toBe(before);
  });

  it("clearReplitWorkflowError resets the error state", () => {
    useApp.setState({ replitWorkflowError: "HTTP 409 invalid task transition" });
    expect(useApp.getState().replitWorkflowError).not.toBeNull();
    useApp.getState().clearReplitWorkflowError();
    expect(useApp.getState().replitWorkflowError).toBeNull();
  });
});
