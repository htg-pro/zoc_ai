import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import * as bridge from "@/lib/tauri-bridge";
import { SearchPanel } from "@/features/search/SearchPanel";
import { useApp } from "@/lib/store";

const initial = useApp.getState();

describe("SearchPanel text mode", () => {
  beforeEach(() => {
    useApp.setState({ ...initial });
    vi.restoreAllMocks();
  });

  it("defaults to text mode on the desktop and renders grouped results", async () => {
    vi.spyOn(bridge, "isTauri").mockReturnValue(true);
    const searchWorkspace = vi.fn().mockResolvedValue({
      files: [
        {
          file: "/ws/src/a.ts",
          matches: [{ line: 1, column: 5, start: 4, end: 7, text: "let foo = 1;" }],
        },
      ],
      total: 1,
      truncated: false,
    });
    useApp.setState({ searchWorkspace, previewReplace: vi.fn().mockResolvedValue([]) });

    render(<SearchPanel />);
    fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: "foo" } });

    expect(await screen.findByText("a.ts")).toBeInTheDocument();
    // The matched token is highlighted in its own <mark>.
    expect(screen.getByText("foo")).toBeInTheDocument();
    expect(searchWorkspace).toHaveBeenCalled();
  });

  it("Replace All invokes applyReplace with the replacement", async () => {
    vi.spyOn(bridge, "isTauri").mockReturnValue(true);
    const searchWorkspace = vi.fn().mockResolvedValue({
      files: [{ file: "/ws/a.ts", matches: [{ line: 1, column: 1, start: 0, end: 3, text: "foo" }] }],
      total: 1,
      truncated: false,
    });
    const applyReplace = vi.fn().mockResolvedValue({ files: [], total_replacements: 1 });
    useApp.setState({
      searchWorkspace,
      previewReplace: vi.fn().mockResolvedValue([]),
      applyReplace,
    });

    render(<SearchPanel />);
    fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: "foo" } });
    await screen.findByText("a.ts");

    // Reveal the replace row and type a replacement.
    fireEvent.click(screen.getByLabelText("Toggle replace"));
    fireEvent.change(screen.getByPlaceholderText("Replace"), { target: { value: "bar" } });
    fireEvent.click(screen.getByLabelText("Replace All"));

    expect(applyReplace).toHaveBeenCalledWith(
      expect.objectContaining({ query: "foo", replacement: "bar" }),
    );
  });
});
