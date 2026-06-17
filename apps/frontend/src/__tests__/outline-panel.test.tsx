import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { OutlinePanel } from "@/features/outline/OutlinePanel";
import { useApp } from "@/lib/store";

const initial = useApp.getState();

const SRC = ["export function alpha() {}", "class Beta {}", "const gamma = () => 1;"].join("\n");

describe("OutlinePanel", () => {
  beforeEach(() => {
    useApp.setState({ ...initial, openFiles: [], activeFile: null });
  });

  it("shows an empty state with no active file", () => {
    render(<OutlinePanel />);
    expect(screen.getByText(/No active file to outline/i)).toBeInTheDocument();
  });

  it("lists symbols of the active file and filters them", () => {
    useApp.setState({
      openFiles: [{ path: "/ws/a.ts", name: "a.ts", language: "typescript", content: SRC, dirty: false }],
      activeFile: "/ws/a.ts",
    });
    render(<OutlinePanel />);
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByText("gamma")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Filter symbols"), { target: { value: "bet" } });
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.queryByText("alpha")).not.toBeInTheDocument();
  });
});
