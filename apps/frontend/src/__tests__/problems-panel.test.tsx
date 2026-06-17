import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ProblemsPanel } from "@/features/problems/ProblemsPanel";
import { useApp } from "@/lib/store";

const initial = useApp.getState();

describe("ProblemsPanel", () => {
  beforeEach(() => {
    useApp.setState({ ...initial, diagnostics: {} });
    vi.restoreAllMocks();
  });

  it("shows the empty state when there are no diagnostics", () => {
    render(<ProblemsPanel />);
    expect(screen.getByText(/No problems detected/i)).toBeInTheDocument();
  });

  it("renders real diagnostics grouped by file and opens the file on click", () => {
    const openFile = vi.fn(async () => {});
    useApp.setState({
      workspaceRoot: "/ws",
      openFile,
      diagnostics: {
        typescript: [
          { source: "typescript", file: "src/app.ts", line: 12, column: 5, severity: "error", message: "bad type", code: "TS2322" },
        ],
      },
    });
    render(<ProblemsPanel />);

    expect(screen.getByText("bad type")).toBeInTheDocument();
    expect(screen.getByText(/TS2322/)).toBeInTheDocument();
    // The file header is clickable and resolves the relative path against the root.
    fireEvent.click(screen.getByText("app.ts"));
    expect(openFile).toHaveBeenCalledWith("/ws/src/app.ts");
  });

  it("runs a checker via the store when a run button is clicked", () => {
    const runDiagnostics = vi.fn(async () => {});
    useApp.setState({ runDiagnostics, diagnostics: {} });
    render(<ProblemsPanel />);
    fireEvent.click(screen.getByTitle("Run tsc"));
    expect(runDiagnostics).toHaveBeenCalledWith("tsc", "apps/frontend");
  });
});
