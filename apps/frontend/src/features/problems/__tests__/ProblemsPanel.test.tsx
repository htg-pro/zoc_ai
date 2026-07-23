import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ProblemsPanel } from "../ProblemsPanel";
import { useApp } from "@/lib/store";
import { revealPosition, requestReveal } from "@/lib/editor-actions";

vi.mock("@/lib/editor-actions", () => ({
  revealPosition: vi.fn(),
  requestReveal: vi.fn(),
}));

const initial = useApp.getState();

beforeEach(() => {
  useApp.setState({ ...initial, diagnostics: {}, activeFile: null });
  vi.clearAllMocks();
});

describe("ProblemsPanel coexistence (R2.6)", () => {
  it("renders LSP and command-checker diagnostics for one file under a single group", () => {
    useApp.setState({
      workspaceRoot: "/ws",
      openFile: vi.fn(async () => {}),
      diagnostics: {
        "lsp:file:///ws/src/app.ts": [
          { source: "pyright", file: "/ws/src/app.ts", line: 3, column: 1, severity: "warning", message: "lsp warning here" },
        ],
        typescript: [
          { source: "typescript", file: "/ws/src/app.ts", line: 12, column: 5, severity: "error", message: "checker error here", code: "TS2322" },
        ],
      },
    });
    render(<ProblemsPanel />);

    // One file group (single "app.ts" header) with both entries under it.
    expect(screen.getAllByText("app.ts")).toHaveLength(1);
    expect(screen.getByText("lsp warning here")).toBeInTheDocument();
    expect(screen.getByText("checker error here")).toBeInTheDocument();
    // Each entry shows its own source.
    expect(screen.getByText(/pyright/)).toBeInTheDocument();
    expect(screen.getByText(/typescript/)).toBeInTheDocument();
  });
});

describe("ProblemsPanel navigation (R3.1–R3.4)", () => {
  it("opens the file and buffers a reveal target when the file is not active", () => {
    const openFile = vi.fn(async () => {});
    useApp.setState({
      workspaceRoot: "/ws",
      openFile,
      activeFile: null,
      diagnostics: {
        typescript: [
          { source: "typescript", file: "/ws/src/app.ts", line: 12, column: 5, severity: "error", message: "boom" },
        ],
      },
    });
    render(<ProblemsPanel />);

    fireEvent.click(screen.getByText("boom"));
    expect(openFile).toHaveBeenCalledWith("/ws/src/app.ts");
    expect(requestReveal).toHaveBeenCalledWith("/ws/src/app.ts", 12, 5);
    expect(revealPosition).not.toHaveBeenCalled();
  });

  it("reveals immediately without a pending buffer when the file is already active", () => {
    const openFile = vi.fn(async () => {});
    useApp.setState({
      workspaceRoot: "/ws",
      openFile,
      activeFile: "/ws/src/app.ts",
      diagnostics: {
        typescript: [
          { source: "typescript", file: "/ws/src/app.ts", line: 8, column: 2, severity: "error", message: "boom" },
        ],
      },
    });
    render(<ProblemsPanel />);

    fireEvent.click(screen.getByText("boom"));
    // R3.4: re-activates the already-open file (openFile is idempotent) and
    // reveals directly, not via the pending buffer.
    expect(openFile).toHaveBeenCalledWith("/ws/src/app.ts");
    expect(revealPosition).toHaveBeenCalledWith(8, 2);
    expect(requestReveal).not.toHaveBeenCalled();
  });
});

describe("ProblemsPanel fix action (R6.4–R6.6)", () => {
  it("prefills the Composer in Agent mode and dispatches no run", () => {
    const setInput = vi.fn();
    const setAgentMode = vi.fn();
    useApp.setState({
      workspaceRoot: "/ws",
      openFile: vi.fn(async () => {}),
      setInput,
      setAgentMode,
      diagnostics: {
        typescript: [
          { source: "typescript", file: "/ws/src/app.ts", line: 12, column: 5, severity: "error", message: "type error" },
          { source: "typescript", file: "/ws/src/app.ts", line: 20, column: 1, severity: "warning", message: "a warning" },
        ],
      },
    });
    render(<ProblemsPanel />);

    fireEvent.click(screen.getByRole("button", { name: /Run agent to fix 1 error/i }));
    expect(setAgentMode).toHaveBeenCalledWith("agent");
    expect(setInput).toHaveBeenCalledTimes(1);
    const prompt = setInput.mock.calls[0][0] as string;
    expect(prompt).toContain("/ws/src/app.ts");
    expect(prompt).toContain("type error");
    // R6.3: warnings are omitted from the prompt.
    expect(prompt).not.toContain("a warning");
  });

  it("offers no fix action for a file with only warnings", () => {
    useApp.setState({
      workspaceRoot: "/ws",
      openFile: vi.fn(async () => {}),
      diagnostics: {
        eslint: [
          { source: "eslint", file: "/ws/a.ts", line: 1, column: 1, severity: "warning", message: "w" },
        ],
      },
    });
    render(<ProblemsPanel />);
    expect(screen.queryByRole("button", { name: /Run agent to fix/i })).toBeNull();
  });
});

describe("ProblemsPanel no-server behavior (R7.3, R7.4)", () => {
  it("renders command-checker diagnostics with no LSP server connected", () => {
    useApp.setState({
      workspaceRoot: "/ws",
      openFile: vi.fn(async () => {}),
      diagnostics: {
        ruff: [{ source: "ruff", file: "/ws/a.py", line: 1, column: 1, severity: "error", message: "F401 unused" }],
      },
    });
    render(<ProblemsPanel />);
    expect(screen.getByText("F401 unused")).toBeInTheDocument();
  });

  it("shows the empty state when the store has no diagnostics", () => {
    useApp.setState({ diagnostics: {} });
    render(<ProblemsPanel />);
    expect(screen.getByText(/No problems detected/i)).toBeInTheDocument();
  });
});
