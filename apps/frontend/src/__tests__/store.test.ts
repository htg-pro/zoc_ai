import { describe, it, expect, beforeEach, vi } from "vitest";
import { useApp } from "@/lib/store";
import { setSetting } from "@/lib/settings";
import { setTrust, setRunMode } from "@/lib/trust";
import * as agentClient from "@/lib/agent-client";
import * as bridge from "@/lib/tauri-bridge";
import type {
  AgentClient,
  CodeReviewRequest,
  TestGenRequest,
} from "@/lib/agent-client";
import type {
  CodeReviewReport,
  Session,
  SlashCommandName,
  TestGenerationResult,
  ToolGrant,
} from "@zoc-studio/shared-types";

const initial = useApp.getState();

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
    // Phase 13: most store tests assume a trusted workspace that runs commands.
    setTrust("trusted");
    setRunMode("all");
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

  it("queues messages only while a run is active and clears them on stop (R4.11/R4.14)", () => {
    // Idle: queuing is a no-op so the message would never be released.
    expect(useApp.getState().messageQueue).toEqual([]);
    useApp.getState().queueUserMessage("do this next");
    expect(useApp.getState().messageQueue).toEqual([]);

    // Active run: messages are held, in order.
    useApp.setState({ streaming: true, isRunning: true });
    useApp.getState().queueUserMessage("  first  ");
    useApp.getState().queueUserMessage("second");
    expect(useApp.getState().messageQueue.map((m) => m.content)).toEqual(["first", "second"]);

    // Stopping the run discards the pending queue.
    useApp.getState().cancelStream();
    expect(useApp.getState().messageQueue).toEqual([]);
  });

  it("reorders and removes queued messages (Phase 11 queue controls)", () => {
    useApp.setState({ streaming: true, isRunning: true, messageQueue: [] });
    useApp.getState().queueUserMessage("a");
    useApp.getState().queueUserMessage("b");
    useApp.getState().queueUserMessage("c");
    expect(useApp.getState().messageQueue.map((m) => m.content)).toEqual(["a", "b", "c"]);

    // Move "c" (index 2) to the front (index 0).
    useApp.getState().reorderQueue(2, 0);
    expect(useApp.getState().messageQueue.map((m) => m.content)).toEqual(["c", "a", "b"]);

    // Out-of-range reorder is a no-op.
    useApp.getState().reorderQueue(5, 0);
    expect(useApp.getState().messageQueue.map((m) => m.content)).toEqual(["c", "a", "b"]);

    // Remove the middle one by id.
    const midId = useApp.getState().messageQueue[1].id;
    useApp.getState().dequeueMessage(midId);
    expect(useApp.getState().messageQueue.map((m) => m.content)).toEqual(["c", "b"]);

    useApp.getState().clearQueue();
    expect(useApp.getState().messageQueue).toEqual([]);
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

  it("marks a buffer dirty on edit and clears it on save (browser preview)", async () => {
    await useApp.getState().openFile("/services/agent.py");
    useApp.getState().updateFile("/services/agent.py", "print('changed')\n");
    expect(
      useApp.getState().openFiles.find((f) => f.path === "/services/agent.py")?.dirty,
    ).toBe(true);

    // In the (non-Tauri) test environment saveFile just clears the dirty flag.
    const ok = await useApp.getState().saveActiveFile();
    expect(ok).toBe(true);
    const saved = useApp.getState().openFiles.find((f) => f.path === "/services/agent.py");
    expect(saved?.dirty).toBe(false);
    expect(saved?.content).toBe("print('changed')\n");

    // Saving a clean buffer is a no-op that still reports success.
    expect(await useApp.getState().saveFile("/services/agent.py")).toBe(true);
  });

  it("saveActiveFile returns false when no file is open", async () => {
    useApp.setState({ openFiles: [], activeFile: null });
    expect(await useApp.getState().saveActiveFile()).toBe(false);
  });

  it("searches the workspace file tree for @ mention candidates", async () => {
    vi.spyOn(bridge, "isTauri").mockReturnValue(true);
    vi.spyOn(bridge, "fsListDir").mockResolvedValue([
      {
        name: "src",
        path: "/ws/src",
        kind: "dir",
        children: [
          { name: "Composer.tsx", path: "/ws/src/Composer.tsx", kind: "file", children: null },
        ],
      },
      {
        name: "node_modules",
        path: "/ws/node_modules",
        kind: "dir",
        children: [
          { name: "Composer.tsx", path: "/ws/node_modules/Composer.tsx", kind: "file", children: null },
        ],
      },
    ]);
    useApp.setState({ workspaceRoot: "/ws", activeSessionId: "", liveMode: false, openFiles: [] });

    const out = await useApp.getState().searchContextCandidates("composer");

    expect(bridge.fsListDir).toHaveBeenCalledWith("/ws", 8);
    expect(out).toEqual([
      {
        kind: "file",
        label: "Composer.tsx",
        path: "/ws/src/Composer.tsx",
        detail: "src/Composer.tsx",
        line: null,
      },
    ]);
    vi.restoreAllMocks();
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

  it("deletes the active session and starts fresh without auto-resuming another", async () => {
    const [first, second] = useApp.getState().sessions;
    useApp.setState({ liveMode: false, activeSessionId: first.id });

    const ok = await useApp.getState().deleteSession(first.id);

    expect(ok).toBe(true);
    expect(useApp.getState().sessions.some((session) => session.id === first.id)).toBe(false);
    // R2.5: deleting the active session yields a `fresh` intent — it must NOT
    // auto-jump into the next remaining session.
    expect(useApp.getState().activeSessionId).toBe("");
    expect(useApp.getState().activeSessionId).not.toBe(second.id);
    expect(useApp.getState().chat).toEqual([]);
  });

  it("opening a new chat never auto-resumes a prior session (R2.1)", async () => {
    // In-memory localStorage stub: jsdom's default localStorage is not
    // functional in this harness, and the store reads/writes the last-active
    // pointer through it. The store itself guards every access with try/catch,
    // but the test needs a working store to seed/inspect the pointer.
    const mem = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
      key: () => null,
      length: 0,
    });

    // Arrange: several existing sessions, one of them active with stale
    // chat/agent/plan state, and a persisted last-active pointer that names an
    // existing prior session. None of this prior state may leak into the new
    // chat — `new-chat` always resolves to a `fresh` intent (R2.1).
    const existing = useApp.getState().sessions;
    expect(existing.length).toBeGreaterThan(1);
    const prior = existing[0];
    localStorage.setItem("zoc-studio.last-active-session.v1", prior.id);
    useApp.setState({
      liveMode: true,
      activeSessionId: prior.id,
      chat: [
        {
          id: "stale-msg-1",
          kind: "message",
          message: {
            id: "m-old",
            role: "user",
            content: "old prompt",
            created_at: new Date().toISOString(),
          },
        },
      ] as never,
      agentItems: [
        { id: "stale-item-1", type: "agent_message", text: "old answer", streaming: false },
      ] as never,
      plan: prior.plan ?? null,
    });

    // The "new chat" action creates a brand-new, clean session via the client.
    const fresh: Session = {
      id: "sess-brand-new",
      title: "New",
      status: "active",
      workspace_root: "/tmp",
      provider: null,
      model: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      messages: [],
      plan: null,
      tool_calls: [],
    };
    const createSession = vi
      .fn<(req: unknown) => Promise<Session>>()
      .mockResolvedValue(fresh);
    const fake = { createSession } as unknown as AgentClient;
    vi.spyOn(agentClient, "getAgentClient").mockResolvedValue(fake);

    // Act
    const created = await useApp.getState().createSession("New", "/tmp");

    // Assert: the brand-new session becomes active — never a prior session.
    expect(created?.id).toBe(fresh.id);
    const st = useApp.getState();
    expect(st.activeSessionId).toBe(fresh.id);
    for (const s of existing) {
      expect(st.activeSessionId).not.toBe(s.id);
    }
    // Clean state reflects only the new (empty) session, not the prior one.
    expect(st.chat).toEqual([]);
    expect(st.agentItems).toEqual([]);
    expect(st.plan).toBeNull();
    // The new session is prepended to the list; prior sessions are retained
    // in the sidebar but none of them is selected.
    expect(st.sessions[0].id).toBe(fresh.id);
    // The persisted pointer now tracks the new session (R2.1 follow-on).
    expect(localStorage.getItem("zoc-studio.last-active-session.v1")).toBe(fresh.id);

    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("app-open with a fresh intent does not silently resume sessions[0] (R2.1/R2.2)", async () => {
    // Complementary guard: when there is no last-active pointer, opening the
    // app keeps the session list but starts clean rather than auto-resuming
    // the most-recent prior session (the old `sessions[0]` behavior).
    const mem = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
      key: () => null,
      length: 0,
    });

    const sessions = useApp.getState().sessions;
    expect(sessions.length).toBeGreaterThan(1);
    const listSessions = vi
      .fn<() => Promise<Session[]>>()
      .mockResolvedValue(sessions);
    const fake = { listSessions } as unknown as AgentClient;
    vi.spyOn(agentClient, "getAgentClient").mockResolvedValue(fake);

    await useApp.getState().loadSessions();

    const st = useApp.getState();
    expect(st.sessions.length).toBe(sessions.length);
    expect(st.activeSessionId).toBe("");
    expect(st.activeSessionId).not.toBe(sessions[0].id);
    expect(st.chat).toEqual([]);
    expect(st.agentItems).toEqual([]);
    expect(st.plan).toBeNull();

    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

  it("retryApproval is a no-op in mock mode", async () => {
    useApp.setState({ liveMode: false });
    const before = useApp.getState().chat.length;
    const ok = await useApp.getState().retryApproval("c1");
    expect(ok).toBe(true);
    expect(useApp.getState().chat.length).toBe(before);
  });

  it("renameEntry updates open tabs and active file (desktop path)", async () => {
    vi.spyOn(bridge, "isTauri").mockReturnValue(true);
    vi.spyOn(bridge, "fsRename").mockResolvedValue("/ws/new.ts");
    useApp.setState({
      openFiles: [
        { path: "/ws/old.ts", name: "old.ts", language: "typescript", content: "x", dirty: false },
      ],
      activeFile: "/ws/old.ts",
    });

    const result = await useApp.getState().renameEntry("/ws/old.ts", "new.ts");

    expect(result).toBe("/ws/new.ts");
    expect(useApp.getState().openFiles[0]).toMatchObject({ path: "/ws/new.ts", name: "new.ts" });
    expect(useApp.getState().activeFile).toBe("/ws/new.ts");
    vi.restoreAllMocks();
  });

  it("deleteEntry closes affected tabs and moves the selection", async () => {
    vi.spyOn(bridge, "isTauri").mockReturnValue(true);
    vi.spyOn(bridge, "fsDelete").mockResolvedValue(undefined);
    useApp.setState({
      openFiles: [
        { path: "/ws/dir/a.ts", name: "a.ts", language: "typescript", content: "", dirty: false },
        { path: "/ws/keep.ts", name: "keep.ts", language: "typescript", content: "", dirty: false },
      ],
      activeFile: "/ws/dir/a.ts",
    });

    const ok = await useApp.getState().deleteEntry("/ws/dir");

    expect(ok).toBe(true);
    expect(useApp.getState().openFiles.map((f) => f.path)).toEqual(["/ws/keep.ts"]);
    expect(useApp.getState().activeFile).toBe("/ws/keep.ts");
    vi.restoreAllMocks();
  });

  it("file ops are a graceful no-op outside the desktop runtime", async () => {
    vi.spyOn(bridge, "isTauri").mockReturnValue(false);
    expect(await useApp.getState().createFile("/ws", "x.ts")).toBeNull();
    expect(await useApp.getState().deleteEntry("/ws/x.ts")).toBe(false);
    vi.restoreAllMocks();
  });

  it("creates and opens workspace instructions when they are missing", async () => {
    vi.spyOn(bridge, "isTauri").mockReturnValue(true);
    vi.spyOn(bridge, "fsStat").mockResolvedValue({
      exists: false,
      is_dir: false,
      is_file: false,
      size: 0,
      modified_ms: null,
    });
    vi.spyOn(bridge, "fsCreateFile").mockResolvedValue(
      "/ws/.zoc/instructions.md",
    );
    vi.spyOn(bridge, "fsReadText").mockResolvedValue("");
    useApp.setState({ workspaceRoot: "/ws", openFiles: [], activeFile: null });

    const result = await useApp.getState().openProjectInstructions();

    expect(result).toBe("/ws/.zoc/instructions.md");
    expect(bridge.fsCreateFile).toHaveBeenCalledWith(
      "/ws/.zoc/instructions.md",
    );
    expect(useApp.getState().activeFile).toBe("/ws/.zoc/instructions.md");
    expect(useApp.getState().mainView).toBe("editor");
    vi.restoreAllMocks();
  });

  it("applyReplace stashes undo and refreshes open buffers", async () => {
    vi.spyOn(bridge, "isTauri").mockReturnValue(true);
    vi.spyOn(bridge, "fsReplaceApply").mockResolvedValue({
      files: [{ file: "/ws/a.ts", replacements: 2, original: "old\n" }],
      total_replacements: 2,
    });
    vi.spyOn(bridge, "fsReadText").mockResolvedValue("new\n");
    useApp.setState({
      openFiles: [
        { path: "/ws/a.ts", name: "a.ts", language: "typescript", content: "old\n", dirty: true },
      ],
      lastReplaceUndo: null,
    });

    const summary = await useApp.getState().applyReplace({
      query: "old",
      is_regex: false,
      case_sensitive: false,
      whole_word: false,
      includes: [],
      excludes: [],
      use_gitignore: true,
      replacement: "new",
    });

    expect(summary?.total_replacements).toBe(2);
    expect(useApp.getState().lastReplaceUndo).toHaveLength(1);
    const buf = useApp.getState().openFiles.find((f) => f.path === "/ws/a.ts");
    expect(buf).toMatchObject({ content: "new\n", dirty: false });
    vi.restoreAllMocks();
  });

  it("undoLastReplace restores originals and clears the undo stash", async () => {
    vi.spyOn(bridge, "isTauri").mockReturnValue(true);
    const writeSpy = vi.spyOn(bridge, "fsWriteText").mockResolvedValue(true);
    useApp.setState({
      openFiles: [
        { path: "/ws/a.ts", name: "a.ts", language: "typescript", content: "new\n", dirty: false },
      ],
      lastReplaceUndo: [{ file: "/ws/a.ts", replacements: 2, original: "old\n" }],
    });

    const restored = await useApp.getState().undoLastReplace();

    expect(restored).toBe(1);
    expect(writeSpy).toHaveBeenCalledWith("/ws/a.ts", "old\n");
    expect(useApp.getState().lastReplaceUndo).toBeNull();
    expect(useApp.getState().openFiles[0].content).toBe("old\n");
    vi.restoreAllMocks();
  });

  it("searchWorkspace returns empty outside the desktop runtime", async () => {
    vi.spyOn(bridge, "isTauri").mockReturnValue(false);
    const res = await useApp.getState().searchWorkspace({
      query: "x",
      is_regex: false,
      case_sensitive: false,
      whole_word: false,
      includes: [],
      excludes: [],
      use_gitignore: true,
    });
    expect(res).toEqual({ files: [], total: 0, truncated: false });
    vi.restoreAllMocks();
  });

  const sampleGitStatus = () => ({
    is_repo: true,
    branch: "main",
    upstream: "origin/main",
    ahead: 1,
    behind: 0,
    staged: [{ path: "/ws/a.ts", x: "M", y: " ", label: "Modified" }],
    unstaged: [{ path: "/ws/b.ts", x: " ", y: "M", label: "Modified" }],
    untracked: [],
    conflicts: [],
  });

  it("refreshGit loads status from the bridge", async () => {
    vi.spyOn(bridge, "isTauri").mockReturnValue(true);
    vi.spyOn(bridge, "gitStatus").mockResolvedValue(sampleGitStatus());
    await useApp.getState().refreshGit();
    expect(useApp.getState().git?.branch).toBe("main");
    expect(useApp.getState().git?.staged).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it("stageFiles stages and refreshes status", async () => {
    vi.spyOn(bridge, "isTauri").mockReturnValue(true);
    const stage = vi.spyOn(bridge, "gitStage").mockResolvedValue(undefined);
    vi.spyOn(bridge, "gitStatus").mockResolvedValue(sampleGitStatus());
    await useApp.getState().stageFiles(["/ws/b.ts"]);
    expect(stage).toHaveBeenCalledWith(["/ws/b.ts"]);
    expect(useApp.getState().git?.branch).toBe("main");
    vi.restoreAllMocks();
  });

  it("commitChanges returns the hash and refreshes; rejects an empty message", async () => {
    vi.spyOn(bridge, "isTauri").mockReturnValue(true);
    const commit = vi.spyOn(bridge, "gitCommit").mockResolvedValue("abcdef1234");
    vi.spyOn(bridge, "gitStatus").mockResolvedValue(sampleGitStatus());

    expect(await useApp.getState().commitChanges("   ")).toBeNull();
    expect(commit).not.toHaveBeenCalled();

    const hash = await useApp.getState().commitChanges("feat: thing");
    expect(hash).toBe("abcdef1234");
    expect(commit).toHaveBeenCalledWith("feat: thing");
    vi.restoreAllMocks();
  });

  it("restoreAgentRunCheckpoint confirms and checks out the checkpoint commit", async () => {
    vi.spyOn(bridge, "isTauri").mockReturnValue(true);
    const checkout = vi.spyOn(bridge, "gitCheckout").mockResolvedValue(undefined);
    vi.spyOn(bridge, "gitStatus").mockResolvedValue(sampleGitStatus());
    vi.spyOn(window, "confirm").mockReturnValue(true);
    useApp.setState({ agentRunCheckpoints: { "run-1": "abcdef1234567890" } });

    await expect(useApp.getState().restoreAgentRunCheckpoint("run-1")).resolves.toBe(true);

    expect(window.confirm).toHaveBeenCalled();
    expect(checkout).toHaveBeenCalledWith("abcdef1234567890");
    vi.restoreAllMocks();
  });

  it("git actions are a no-op outside the desktop runtime", async () => {
    vi.spyOn(bridge, "isTauri").mockReturnValue(false);
    await useApp.getState().refreshGit();
    expect(useApp.getState().git).toBeNull();
    expect(await useApp.getState().commitChanges("x")).toBeNull();
    vi.restoreAllMocks();
  });

  it("diagnostics: set, clear-by-source, and clear-all", () => {
    useApp.getState().setDiagnostics("typescript", [
      { source: "typescript", file: "a.ts", line: 1, column: 1, severity: "error", message: "x" },
    ]);
    useApp.getState().setDiagnostics("ruff", [
      { source: "ruff", file: "a.py", line: 2, column: 1, severity: "warning", message: "y" },
    ]);
    expect(Object.keys(useApp.getState().diagnostics)).toHaveLength(2);
    useApp.getState().clearDiagnostics("ruff");
    expect(useApp.getState().diagnostics.ruff).toBeUndefined();
    expect(useApp.getState().diagnostics.typescript).toHaveLength(1);
    useApp.getState().clearDiagnostics();
    expect(Object.keys(useApp.getState().diagnostics)).toHaveLength(0);
  });

  it("runDiagnostics parses checker output into diagnostics + Tasks output", async () => {
    vi.spyOn(bridge, "isTauri").mockReturnValue(true);
    vi.spyOn(bridge, "runCheck").mockResolvedValue({
      kind: "tsc",
      stdout: "src/app.ts(12,5): error TS2322: bad type",
      stderr: "",
      code: 1,
    });
    useApp.setState({ diagnostics: {}, outputChannels: { Agent: [], Git: [], Tasks: [], MCP: [], Terminal: [], "Extension Host": [] } });

    await useApp.getState().runDiagnostics("tsc");

    expect(useApp.getState().diagnostics.typescript).toHaveLength(1);
    expect(useApp.getState().diagnostics.typescript[0]).toMatchObject({ line: 12, column: 5 });
    expect(useApp.getState().outputChannels.Tasks.join("\n")).toContain("tsc");
    vi.restoreAllMocks();
  });

  it("appendOutput, appendLog and their clears work", () => {
    useApp.setState({ logs: [], outputChannels: { Agent: [], Git: [], Tasks: [], MCP: [], Terminal: [], "Extension Host": [] } });
    useApp.getState().appendOutput("Git", "fetched");
    useApp.getState().appendLog("warning", "heads up");
    expect(useApp.getState().outputChannels.Git).toEqual(["fetched"]);
    expect(useApp.getState().logs[0]).toMatchObject({ level: "warning", message: "heads up" });
    useApp.getState().clearOutput("Git");
    useApp.getState().clearLogs();
    expect(useApp.getState().outputChannels.Git).toHaveLength(0);
    expect(useApp.getState().logs).toHaveLength(0);
  });

  it("discoverTasks reads manifests and merges tasks", async () => {
    vi.spyOn(bridge, "isTauri").mockReturnValue(true);
    vi.spyOn(bridge, "fsReadText").mockImplementation(async (path: string) => {
      if (path.endsWith("package.json")) return JSON.stringify({ scripts: { build: "vite build", test: "vitest" } });
      if (path.endsWith("Cargo.toml")) return "[package]\nname='x'";
      return null;
    });
    useApp.setState({ workspaceRoot: "/ws", tasks: [] });

    await useApp.getState().discoverTasks();

    const ids = useApp.getState().tasks.map((t) => t.id);
    expect(ids).toContain("npm:build");
    expect(ids).toContain("cargo:test");
    vi.restoreAllMocks();
  });

  it("runTask runs the command, records status, and parses a problem matcher", async () => {
    vi.spyOn(bridge, "isTauri").mockReturnValue(true);
    const runTaskCommand = vi.spyOn(bridge, "runTaskCommand").mockResolvedValue({
      stdout: "src/main.rs:10:5: error[E0382]: boom",
      stderr: "",
      code: 1,
    });
    useApp.setState({
      tasks: [
        { id: "cargo:check", label: "cargo: check", source: "cargo", command: "cargo", args: ["check"], group: "none", problemMatcher: "cargo" },
      ],
      taskRuns: {},
      diagnostics: {},
      outputChannels: { Agent: [], Git: [], Tasks: [], MCP: [], Terminal: [], "Extension Host": [] },
    });

    await useApp.getState().runTask("cargo:check");

    expect(runTaskCommand).toHaveBeenCalledWith("cargo", ["check"], undefined);
    expect(useApp.getState().taskRuns["cargo:check"]).toBe("failed"); // exit 1
    expect(useApp.getState().diagnostics.cargo).toHaveLength(1);
    expect(useApp.getState().outputChannels.Tasks.join("\n")).toContain("cargo check");
    vi.restoreAllMocks();
  });

  it("runBuildTask picks the default build task", async () => {
    vi.spyOn(bridge, "isTauri").mockReturnValue(true);
    const runTaskCommand = vi.spyOn(bridge, "runTaskCommand").mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    useApp.setState({
      tasks: [
        { id: "npm:build", label: "npm: build", source: "npm", command: "npm", args: ["run", "build"], group: "build", problemMatcher: null },
      ],
      taskRuns: {},
      outputChannels: { Agent: [], Git: [], Tasks: [], MCP: [], Terminal: [], "Extension Host": [] },
    });

    await useApp.getState().runBuildTask();

    expect(runTaskCommand).toHaveBeenCalledWith("npm", ["run", "build"], undefined);
    expect(useApp.getState().taskRuns["npm:build"]).toBe("passed");
    vi.restoreAllMocks();
  });

  it("toggleBreakpoint adds/removes sorted lines and clears empties the file", () => {
    useApp.setState({ breakpoints: {} });
    useApp.getState().toggleBreakpoint("/ws/a.ts", 10);
    useApp.getState().toggleBreakpoint("/ws/a.ts", 3);
    expect(useApp.getState().breakpoints["/ws/a.ts"]).toEqual([3, 10]);
    useApp.getState().toggleBreakpoint("/ws/a.ts", 3);
    expect(useApp.getState().breakpoints["/ws/a.ts"]).toEqual([10]);
    useApp.getState().toggleBreakpoint("/ws/a.ts", 10);
    expect(useApp.getState().breakpoints["/ws/a.ts"]).toBeUndefined();
  });

  it("clearBreakpoints removes one file or all", () => {
    useApp.setState({ breakpoints: { "/a.ts": [1], "/b.ts": [2] } });
    useApp.getState().clearBreakpoints("/a.ts");
    expect(useApp.getState().breakpoints).toEqual({ "/b.ts": [2] });
    useApp.getState().clearBreakpoints();
    expect(useApp.getState().breakpoints).toEqual({});
  });

  it("loadLaunchConfigs reads launch.json and selects the first", async () => {
    vi.spyOn(bridge, "isTauri").mockReturnValue(true);
    vi.spyOn(bridge, "fsReadText").mockImplementation(async (p: string) =>
      p.endsWith(".vscode/launch.json")
        ? '{"configurations":[{"name":"Run","type":"python","request":"launch"}]}'
        : null,
    );
    useApp.setState({ workspaceRoot: "/ws", launchConfigs: [], selectedDebugConfig: null });
    await useApp.getState().loadLaunchConfigs();
    expect(useApp.getState().launchConfigs).toHaveLength(1);
    expect(useApp.getState().selectedDebugConfig).toBe("Run");
    vi.restoreAllMocks();
  });

  it("terminals: create with numbered titles, set active, close reassigns active", () => {
    useApp.setState({ terminals: [], activeTerminalId: null });
    const a = useApp.getState().newTerminal("bash");
    const b = useApp.getState().newTerminal("bash");
    expect(useApp.getState().terminals.map((t) => t.title)).toEqual(["bash", "bash (2)"]);
    expect(useApp.getState().activeTerminalId).toBe(b);
    useApp.getState().setActiveTerminal(a);
    expect(useApp.getState().activeTerminalId).toBe(a);
    useApp.getState().closeTerminal(a);
    // Active falls back to the remaining terminal.
    expect(useApp.getState().activeTerminalId).toBe(b);
    expect(useApp.getState().terminals).toHaveLength(1);
  });

  it("terminals: rename, exit status, and split toggle", () => {
    useApp.setState({ terminals: [], activeTerminalId: null, terminalSplit: false });
    const id = useApp.getState().newTerminal();
    useApp.getState().renameTerminal(id, "build watch");
    expect(useApp.getState().terminals[0].title).toBe("build watch");
    useApp.getState().setTerminalExited(id, 1);
    expect(useApp.getState().terminals[0]).toMatchObject({ status: "exited", exitCode: 1 });
    useApp.getState().toggleTerminalSplit();
    expect(useApp.getState().terminalSplit).toBe(true);
  });

  // ── Phase 9: editor workbench ───────────────────────────────────────────
  it("toggleEditorSetting flips minimap/stickyScroll/breadcrumbs", () => {
    useApp.setState({ editorSettings: { minimap: false, stickyScroll: false, breadcrumbs: true } });
    useApp.getState().toggleEditorSetting("minimap");
    expect(useApp.getState().editorSettings.minimap).toBe(true);
    useApp.getState().toggleEditorSetting("stickyScroll");
    expect(useApp.getState().editorSettings.stickyScroll).toBe(true);
    useApp.getState().toggleEditorSetting("breadcrumbs");
    expect(useApp.getState().editorSettings.breadcrumbs).toBe(false);
  });

  it("splitEditor mirrors the active file into the right group; closeRightGroup clears it", () => {
    useApp.setState({ activeFile: "/ws/a.ts", splitView: false, rightActiveFile: null });
    useApp.getState().splitEditor();
    expect(useApp.getState().splitView).toBe(true);
    expect(useApp.getState().rightActiveFile).toBe("/ws/a.ts");
    useApp.getState().closeRightGroup();
    expect(useApp.getState().splitView).toBe(false);
    expect(useApp.getState().rightActiveFile).toBeNull();
  });

  it("splitEditor is a no-op when nothing is active", () => {
    useApp.setState({ activeFile: null, splitView: false, rightActiveFile: null });
    useApp.getState().splitEditor();
    expect(useApp.getState().splitView).toBe(false);
    expect(useApp.getState().rightActiveFile).toBeNull();
  });

  it("setRightActiveFile changes only the right group", () => {
    useApp.setState({ activeFile: "/ws/a.ts", splitView: true, rightActiveFile: "/ws/a.ts" });
    useApp.getState().setRightActiveFile("/ws/b.ts");
    expect(useApp.getState().rightActiveFile).toBe("/ws/b.ts");
    expect(useApp.getState().activeFile).toBe("/ws/a.ts");
  });

  it("closeOtherFiles keeps only the given tab", () => {
    useApp.setState({
      openFiles: [
        { path: "/ws/a.ts", name: "a.ts", language: "typescript", content: "", dirty: false },
        { path: "/ws/b.ts", name: "b.ts", language: "typescript", content: "", dirty: false },
        { path: "/ws/c.ts", name: "c.ts", language: "typescript", content: "", dirty: false },
      ],
      activeFile: "/ws/b.ts",
      splitView: false,
      rightActiveFile: null,
    });
    useApp.getState().closeOtherFiles("/ws/b.ts");
    expect(useApp.getState().openFiles.map((f) => f.path)).toEqual(["/ws/b.ts"]);
    expect(useApp.getState().activeFile).toBe("/ws/b.ts");
  });

  it("closeSavedFiles keeps only dirty buffers", () => {
    useApp.setState({
      openFiles: [
        { path: "/ws/a.ts", name: "a.ts", language: "typescript", content: "", dirty: false },
        { path: "/ws/b.ts", name: "b.ts", language: "typescript", content: "", dirty: true },
        { path: "/ws/c.ts", name: "c.ts", language: "typescript", content: "", dirty: false },
      ],
      activeFile: "/ws/a.ts",
      splitView: false,
      rightActiveFile: null,
    });
    useApp.getState().closeSavedFiles();
    expect(useApp.getState().openFiles.map((f) => f.path)).toEqual(["/ws/b.ts"]);
    expect(useApp.getState().activeFile).toBe("/ws/b.ts");
  });

  it("closeAllFiles clears every group", () => {
    useApp.setState({
      openFiles: [
        { path: "/ws/a.ts", name: "a.ts", language: "typescript", content: "", dirty: true },
      ],
      activeFile: "/ws/a.ts",
      splitView: true,
      rightActiveFile: "/ws/a.ts",
    });
    useApp.getState().closeAllFiles();
    expect(useApp.getState().openFiles).toEqual([]);
    expect(useApp.getState().activeFile).toBeNull();
    expect(useApp.getState().splitView).toBe(false);
    expect(useApp.getState().rightActiveFile).toBeNull();
  });

  // ── Phase 10: settings ─────────────────────────────────────────────────
  it("applyEffectiveSettings pushes persisted settings into runtime state", () => {
    const realLocalStorage = globalThis.localStorage;
    const map = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: (i: number) => Array.from(map.keys())[i] ?? null,
      get length() {
        return map.size;
      },
    } as Storage);
    try {
      setSetting("user", "editor.minimap", true);
      setSetting("user", "agent.autonomy", "Low");
      setSetting("workspace", "agent.defaultMode", "ask");
      useApp.getState().applyEffectiveSettings({ includeMode: true });
      expect(useApp.getState().editorSettings.minimap).toBe(true);
      expect(useApp.getState().autonomy).toBe("Low");
      expect(useApp.getState().agentMode).toBe("ask");
    } finally {
      vi.stubGlobal("localStorage", realLocalStorage);
      useApp.setState({ agentMode: "agent", autonomy: "High" });
    }
  });

  // ── Phase 13: workspace trust ───────────────────────────────────────────
  it("runTask is blocked in a restricted workspace and records the decision", async () => {
    vi.spyOn(bridge, "isTauri").mockReturnValue(true);
    const runTaskCommand = vi.spyOn(bridge, "runTaskCommand").mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
    });
    useApp.setState({
      workspaceRoot: "/ws",
      tasks: [
        { id: "npm:build", label: "npm: build", source: "npm", command: "npm", args: ["run", "build"], group: "build", problemMatcher: null },
      ],
      taskRuns: {},
    });
    setTrust("restricted");
    try {
      await useApp.getState().runTask("npm:build");
      // The command never ran and the task wasn't marked running/passed.
      expect(runTaskCommand).not.toHaveBeenCalled();
      expect(useApp.getState().taskRuns["npm:build"]).toBeUndefined();
    } finally {
      setTrust("trusted");
      vi.restoreAllMocks();
    }
  });
});
