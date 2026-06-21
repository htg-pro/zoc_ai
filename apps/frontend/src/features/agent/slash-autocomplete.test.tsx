import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlashAutocomplete } from "./SlashAutocomplete";

afterEach(cleanup);

describe("SlashAutocomplete", () => {
  it("shows the five requested commands with their modes", () => {
    render(<SlashAutocomplete prefix="/" onPick={vi.fn()} />);

    for (const name of ["explain", "test", "fix", "document", "refactor"]) {
      expect(screen.getByText(`/${name}`)).toBeInTheDocument();
    }
    expect(screen.getAllByText("Ask")).toHaveLength(1);
    expect(screen.getAllByText("Agent")).toHaveLength(4);
  });

  it("filters and selects a command with the mouse", () => {
    const onPick = vi.fn();
    render(<SlashAutocomplete prefix="/doc" onPick={onPick} />);

    fireEvent.mouseDown(screen.getByRole("option"));

    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ name: "document", mode: "agent" }),
    );
  });

  it("supports arrow and Enter selection", () => {
    const onPick = vi.fn();
    render(<SlashAutocomplete prefix="/" onPick={onPick} />);

    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "Enter" });

    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ name: "test" }));
  });
});
