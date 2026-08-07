import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ShowcaseView } from "@/features/showcase/ShowcaseView";

describe("ShowcaseView", () => {
  it("renders all story sections and at least one variant per primitive", () => {
    render(
      <TooltipProvider>
        <ShowcaseView />
      </TooltipProvider>,
    );
    expect(screen.getByText("Component showcase")).toBeInTheDocument();
    expect(screen.getByText("Buttons")).toBeInTheDocument();
    expect(screen.getByText("Inputs")).toBeInTheDocument();
    expect(screen.getByText("Messages")).toBeInTheDocument();
    expect(screen.getByText("Tool calls (all states)")).toBeInTheDocument();
    // The Chat_Surface stories 25.6 put in place of the legacy cards. There is no run-card story: the
    // transcript *is* the run timeline, so "Messages" above covers what "Agent workflow timeline" did.
    expect(screen.getByText("Diff review")).toBeInTheDocument();
    expect(screen.getByText("States: loading / empty / error")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Primary" })).toBeInTheDocument();
  });
});
