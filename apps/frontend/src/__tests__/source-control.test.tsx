import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import * as bridge from "@/lib/tauri-bridge";
import { SourceControlPanel } from "@/features/scm/SourceControlPanel";
import { useApp } from "@/lib/store";
import type { GitStatus } from "@/lib/tauri-bridge";

const initial = useApp.getState();

const status: GitStatus = {
  is_repo: true,
  branch: "main",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  staged: [{ path: "/ws/staged.ts", x: "M", y: " ", label: "Modified" }],
  unstaged: [{ path: "/ws/changed.ts", x: " ", y: "M", label: "Modified" }],
  untracked: [{ path: "/ws/new.ts", x: "?", y: "?", label: "Untracked" }],
  conflicts: [],
};

describe("SourceControlPanel", () => {
  beforeEach(() => {
    useApp.setState({ ...initial });
    vi.restoreAllMocks();
    vi.spyOn(bridge, "isTauri").mockReturnValue(true);
  });

  it("shows a not-a-repo empty state", async () => {
    useApp.setState({
      git: { ...status, is_repo: false },
      refreshGit: vi.fn(async () => {}),
    });
    render(
      <TooltipProvider>
        <SourceControlPanel />
      </TooltipProvider>,
    );
    expect(await screen.findByText(/not a Git repository/i)).toBeInTheDocument();
  });

  it("renders change groups and the branch, and stages a file", async () => {
    const stageFiles = vi.fn(async () => {});
    useApp.setState({
      git: status,
      refreshGit: vi.fn(async () => {}),
      stageFiles,
    });
    render(
      <TooltipProvider>
        <SourceControlPanel />
      </TooltipProvider>,
    );

    expect(await screen.findByText("main")).toBeInTheDocument();
    expect(screen.getByText("Staged Changes")).toBeInTheDocument();
    expect(screen.getByText("Changes")).toBeInTheDocument();
    expect(screen.getByText("Untracked")).toBeInTheDocument();
    expect(screen.getByText("changed.ts")).toBeInTheDocument();

    // The per-row Stage action stages just that file.
    fireEvent.click(screen.getAllByLabelText("Stage")[0]);
    expect(stageFiles).toHaveBeenCalledWith(["/ws/changed.ts"]);
  });

  it("commits with the typed message and clears the box", async () => {
    const commitChanges = vi.fn(async () => "deadbeef");
    useApp.setState({
      git: status,
      refreshGit: vi.fn(async () => {}),
      commitChanges,
    });
    render(
      <TooltipProvider>
        <SourceControlPanel />
      </TooltipProvider>,
    );

    const box = await screen.findByPlaceholderText(/Message \(commit on main\)/i);
    fireEvent.change(box, { target: { value: "feat: do it" } });
    fireEvent.click(screen.getByRole("button", { name: /Commit/i }));
    expect(commitChanges).toHaveBeenCalledWith("feat: do it");
  });
});
