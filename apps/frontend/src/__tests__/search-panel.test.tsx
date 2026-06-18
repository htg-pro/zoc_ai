import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { EmbedderInfo, IndexQueryResult, IndexStatus } from "@zoc-studio/shared-types";

const indexQuery = vi.fn();
const indexStatus = vi.fn();

vi.mock("@/lib/agent-client", () => ({
  getAgentClient: vi.fn(async () => ({ indexQuery, indexStatus })),
}));

import { SearchPanel } from "@/features/search/SearchPanel";
import { useApp } from "@/lib/store";

const initial = useApp.getState();

function makeResult(over: Partial<IndexQueryResult["chunk"]> = {}): IndexQueryResult {
  return {
    chunk: {
      id: "c1",
      file: "src/app.ts",
      start_line: 42,
      end_line: 50,
      symbol: "doThing",
      text: "\n  export function doThing() {\n    return 1;\n  }\n",
      ...over,
    },
    score: 0.9,
  };
}

function status(embedder: EmbedderInfo | null): IndexStatus {
  return {
    workspace_root: "/ws",
    file_count: 1,
    chunk_count: 1,
    watching: true,
    embedder,
  };
}

function typeQuery(value: string) {
  const input = screen.getByPlaceholderText(/search workspace/i);
  fireEvent.change(input, { target: { value } });
}

describe("SearchPanel", () => {
  beforeEach(() => {
    useApp.setState({ ...initial });
    indexQuery.mockReset();
    indexStatus.mockReset();
    indexStatus.mockResolvedValue(status(null));
  });

  it("renders mapped results after the debounce", async () => {
    indexQuery.mockResolvedValue([makeResult()]);
    render(<SearchPanel />);

    typeQuery("doThing");

    expect(await screen.findByText("src/app.ts")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("doThing")).toBeInTheDocument();
    expect(screen.getByText("export function doThing() {")).toBeInTheDocument();
    expect(indexQuery).toHaveBeenCalledWith(initial.activeSessionId, "doThing", 50);
  });

  it("shows the empty state when the index returns nothing", async () => {
    indexQuery.mockResolvedValue([]);
    render(<SearchPanel />);

    typeQuery("nothinghere");

    expect(
      await screen.findByText("No matches in the indexed workspace."),
    ).toBeInTheDocument();
  });

  it("shows the error state when indexQuery rejects", async () => {
    indexQuery.mockRejectedValue(new Error("agent offline"));
    render(<SearchPanel />);

    typeQuery("boom");

    expect(
      await screen.findByText(/Couldn't reach the workspace index/i),
    ).toBeInTheDocument();
  });

  it("shows the amber hash-fallback note only when embedder.is_fallback is true", async () => {
    indexStatus.mockResolvedValue(
      status({ kind: "hash", model: null, dim: 256, is_fallback: true }),
    );
    indexQuery.mockResolvedValue([]);
    render(<SearchPanel />);

    expect(
      await screen.findByText(/offline hash fallback/i),
    ).toBeInTheDocument();
  });

  it("hides the hash-fallback note when embedder.is_fallback is false", async () => {
    indexStatus.mockResolvedValue(
      status({ kind: "llamacpp", model: "nomic", dim: 768, is_fallback: false }),
    );
    indexQuery.mockResolvedValue([]);
    render(<SearchPanel />);

    await waitFor(() => expect(indexStatus).toHaveBeenCalled());
    expect(screen.queryByText(/offline hash fallback/i)).not.toBeInTheDocument();
  });
});
