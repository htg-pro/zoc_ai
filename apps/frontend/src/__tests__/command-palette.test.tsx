import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CommandPalette } from "@/features/palette/CommandPalette";
import { useApp } from "@/lib/store";

const initial = useApp.getState();

function open(seed = "") {
  useApp.setState({ ...initial, paletteOpen: true, paletteSeed: seed });
}

describe("CommandPalette", () => {
  beforeEach(() => {
    useApp.setState({ ...initial, paletteOpen: false, paletteSeed: "" });
  });

  it("opens in command mode and lists registry commands with shortcuts", async () => {
    open(">");
    render(<CommandPalette />);
    expect(await screen.findByText("Show All Commands")).toBeInTheDocument();
    expect(screen.getByText("Go to File…")).toBeInTheDocument();
    expect(screen.getByText("View: Show Explorer")).toBeInTheDocument();
  });

  it("shows a disabled reason for unavailable views", async () => {
    open(">");
    render(<CommandPalette />);
    const dbg = await screen.findByText("Debug: Start Debugging");
    expect(dbg).toBeInTheDocument();
    expect(screen.getByText(/debug adapter/i)).toBeInTheDocument();
  });

  it("filters commands as the user types", async () => {
    open(">");
    render(<CommandPalette />);
    const input = screen.getByPlaceholderText(/Search files by name/i);
    fireEvent.change(input, { target: { value: ">explorer" } });
    await waitFor(() => expect(screen.getByText("View: Show Explorer")).toBeInTheDocument());
    expect(screen.queryByText("Go to File…")).not.toBeInTheDocument();
  });

  it("does file search via the open-file fallback (no mock data) in file mode", async () => {
    useApp.setState({
      ...initial,
      paletteOpen: true,
      paletteSeed: "",
      liveMode: false,
      openFiles: [
        { path: "/src/Widget.tsx", name: "Widget.tsx", language: "typescript", content: "", dirty: false },
      ],
    });
    render(<CommandPalette />);
    const input = screen.getByPlaceholderText(/Search files by name/i);
    fireEvent.change(input, { target: { value: "Widget" } });
    await waitFor(() => expect(screen.getByText("Widget.tsx")).toBeInTheDocument());
  });
});
