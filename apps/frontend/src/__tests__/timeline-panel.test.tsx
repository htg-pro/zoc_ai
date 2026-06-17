import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { TimelinePanel } from "@/features/timeline/TimelinePanel";
import { useApp } from "@/lib/store";
import type { GitCommit } from "@/lib/tauri-bridge";

const initial = useApp.getState();

describe("TimelinePanel", () => {
  beforeEach(() => {
    useApp.setState({ ...initial, checkpoints: [] });
  });

  it("renders merged commits and checkpoints", async () => {
    const commits: GitCommit[] = [
      { hash: "h1", short: "h1", author: "Ada", email: "a@x", timestamp: 3000, subject: "initial commit" },
    ];
    useApp.setState({
      loadGitLog: vi.fn(async () => commits),
      loadCheckpoints: vi.fn(async () => {}),
      restoreCheckpoint: vi.fn(async () => true),
      checkpoints: [
        { run_id: "r1", label: "Agent edit", created_at: new Date(2_000_000).toISOString(), files: ["a.ts"] },
      ],
    });

    render(<TimelinePanel />);

    await waitFor(() => expect(screen.getByText("initial commit")).toBeInTheDocument());
    expect(screen.getByText("Agent edit")).toBeInTheDocument();
    // The checkpoint exposes a restore affordance.
    expect(screen.getByLabelText("Restore Agent edit")).toBeInTheDocument();
  });

  it("shows an empty state with no history", async () => {
    useApp.setState({
      loadGitLog: vi.fn(async () => []),
      loadCheckpoints: vi.fn(async () => {}),
      checkpoints: [],
      liveMode: true,
    });
    render(<TimelinePanel />);
    await waitFor(() => expect(screen.getByText(/No history yet/i)).toBeInTheDocument());
  });
});
