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
    expect(screen.getByText("Diff card")).toBeInTheDocument();
    expect(screen.getByText("Agent workflow timeline")).toBeInTheDocument();
    expect(screen.getByText("States: loading / empty / error")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Primary" })).toBeInTheDocument();
  });
});
