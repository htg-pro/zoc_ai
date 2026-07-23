import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { WorkspaceIndexProgress } from "@zoc-studio/shared-types";

const progressMocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/index-progress", () => ({
  subscribeWorkspaceIndexProgress: progressMocks.subscribe,
}));

vi.mock("@/components/ui/toast", () => ({
  toast: { success: progressMocks.toastSuccess },
}));

import { StatusBar } from "@/components/layout/StatusBar";
import { useApp } from "@/lib/store";
import { setCursorPosition } from "@/lib/editor-actions";

const initial = useApp.getState();

describe("StatusBar", () => {
  beforeEach(() => {
    useApp.setState({ ...initial, diagnostics: {}, openFiles: [], activeFile: null });
    setCursorPosition(null);
    vi.restoreAllMocks();
    progressMocks.subscribe.mockReset();
    progressMocks.subscribe.mockResolvedValue(() => undefined);
    progressMocks.toastSuccess.mockReset();
  });

  it("shows the real Git branch", () => {
    useApp.setState({
      git: {
        is_repo: true,
        branch: "feature/x",
        staged: [],
        unstaged: [],
        untracked: [],
        conflicts: [],
        ahead: 0,
        behind: 0,
      } as never,
    });
    render(<StatusBar />);
    expect(screen.getByText("feature/x")).toBeInTheDocument();
  });

  it("updates language + cursor when the active file changes", () => {
    useApp.setState({
      openFiles: [{ path: "/ws/a.rs", name: "a.rs", language: "rust", content: "", dirty: false }],
      activeFile: "/ws/a.rs",
    });
    setCursorPosition({ line: 4, column: 9 });
    render(<StatusBar />);
    // Scope to the language-mode indicator: a Rust file also renders an LSP
    // status indicator labelled "Rust", so a bare getByText would be ambiguous.
    expect(screen.getByTitle("Language mode")).toHaveTextContent("Rust");
    expect(screen.getByText("Ln 4, Col 9")).toBeInTheDocument();
    expect(screen.getByText("UTF-8")).toBeInTheDocument();
  });

  it("diagnostics indicator opens the Problems panel", () => {
    const setBottomTab = vi.fn();
    const toggleBottom = vi.fn();
    useApp.setState({
      setBottomTab,
      toggleBottom,
      layout: { ...initial.layout, bottomDockOpen: false },
      diagnostics: {
        typescript: [
          { source: "typescript", file: "a.ts", line: 1, column: 1, severity: "error", message: "boom" },
        ],
      },
    });
    render(<StatusBar />);
    fireEvent.click(screen.getByTitle("Open Problems"));
    expect(setBottomTab).toHaveBeenCalledWith("problems");
    expect(toggleBottom).toHaveBeenCalled();
  });

  it("agent state indicator opens the Agent panel", () => {
    const toggleRight = vi.fn();
    useApp.setState({
      toggleRight,
      layout: { ...initial.layout, rightPanelOpen: false },
      agentMode: "agent",
    });
    render(<StatusBar />);
    fireEvent.click(screen.getByTitle("Open Agent panel"));
    expect(toggleRight).toHaveBeenCalled();
  });

  it("shows workspace index progress and toasts the completed totals", async () => {
    let emit: ((event: WorkspaceIndexProgress) => void) | null = null;
    const loadIndexStatus = vi.fn(async () => undefined);
    progressMocks.subscribe.mockImplementation(
      async (onProgress: (event: WorkspaceIndexProgress) => void) => {
        emit = onProgress;
        return () => undefined;
      },
    );
    useApp.setState({
      liveMode: true,
      activeSessionId: "session-1",
      loadIndexStatus,
      indexStatus: null,
    });
    render(<StatusBar />);

    await waitFor(() => expect(progressMocks.subscribe).toHaveBeenCalledTimes(1));
    act(() => {
      emit?.({
        type: "index.progress",
        sessionId: "session-1",
        processedFiles: 12,
        totalFiles: 30,
        indexedFiles: 12,
        tokenCount: 1_200,
        currentFile: "src/app.ts",
        message: null,
      });
    });
    expect(screen.getByText("Indexing workspace... 12/30 files")).toBeInTheDocument();

    act(() => {
      emit?.({
        type: "index.completed",
        sessionId: "session-1",
        processedFiles: 30,
        totalFiles: 30,
        indexedFiles: 29,
        tokenCount: 4_500,
        currentFile: null,
        message: null,
      });
    });
    expect(progressMocks.toastSuccess).toHaveBeenCalledWith(
      "Workspace indexed — 29 files, 4,500 tokens",
    );
    expect(loadIndexStatus).toHaveBeenCalledTimes(2);
  });
});
