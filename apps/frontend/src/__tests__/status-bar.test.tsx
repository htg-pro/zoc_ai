import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { StatusBar } from "@/components/layout/StatusBar";
import { useApp } from "@/lib/store";
import { setCursorPosition } from "@/lib/editor-actions";

const initial = useApp.getState();

describe("StatusBar", () => {
  beforeEach(() => {
    useApp.setState({ ...initial, diagnostics: {}, openFiles: [], activeFile: null });
    setCursorPosition(null);
    vi.restoreAllMocks();
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
    expect(screen.getByText("Rust")).toBeInTheDocument();
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
});
