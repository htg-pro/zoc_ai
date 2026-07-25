import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  fetchMcpServers: vi.fn(),
  reloadMcp: vi.fn(),
  testMcpServer: vi.fn(),
  fsCreateDir: vi.fn(),
  fsReadText: vi.fn(),
  fsWriteText: vi.fn(),
}));

vi.mock("@/lib/mcp-client", () => ({
  fetchMcpServers: mocks.fetchMcpServers,
  reloadMcp: mocks.reloadMcp,
  testMcpServer: mocks.testMcpServer,
}));

vi.mock("@/lib/tauri-bridge", () => ({
  isTauri: () => true,
  fsCreateDir: mocks.fsCreateDir,
  fsReadText: mocks.fsReadText,
  fsWriteText: mocks.fsWriteText,
}));

import { McpSection } from "../Mcp";
import { useApp } from "@/lib/store";

const bundled = {
  id: "web-search",
  transport: "stdio" as const,
  scope: "workspace" as const,
  command: "/opt/zoc-studio-agent",
  args: ["--mcp-server", "web_search"],
  env: {},
  url: null,
  disabled: false,
  autoApprove: ["web_search"],
  status: "running" as const,
  errorReason: null,
};

describe("McpSection runtime management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useApp.setState({ workspaceRoot: "/workspace" });
    mocks.fsReadText.mockResolvedValue(null);
    mocks.fsCreateDir.mockResolvedValue("/workspace/.zoc");
    mocks.fsWriteText.mockResolvedValue(true);
    mocks.fetchMcpServers.mockResolvedValue([bundled]);
    mocks.reloadMcp.mockResolvedValue([bundled]);
    mocks.testMcpServer.mockResolvedValue({
      outcome: "success",
      toolCount: 1,
      bareNames: ["tool"],
    });
  });

  it("lists merged runtime definitions even when they are absent from workspace JSON", async () => {
    render(<McpSection />);

    expect(await screen.findByText("web-search")).toBeTruthy();
    expect(screen.getByText("● running")).toBeTruthy();
    expect(screen.getByText("web_search")).toBeTruthy();
  });

  it("the Reload control requests a live gateway reload", async () => {
    render(<McpSection />);
    await screen.findByText("web-search");

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(mocks.reloadMcp).toHaveBeenCalledTimes(1));
  });

  it("validates transport-specific fields before writing", async () => {
    render(<McpSection />);
    await screen.findByText("web-search");

    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    fireEvent.change(screen.getByPlaceholderText("my-server"), { target: { value: "missing" } });
    fireEvent.click(screen.getByRole("button", { name: "Save & reload" }));

    expect(await screen.findByText("A stdio server command is required.")).toBeTruthy();
    expect(mocks.fsWriteText).not.toHaveBeenCalled();
    expect(mocks.reloadMcp).not.toHaveBeenCalled();
  });

  it("creates .zoc and writes a workspace override before live reload", async () => {
    render(<McpSection />);
    await screen.findByText("web-search");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save & reload" }));

    await waitFor(() => expect(mocks.fsWriteText).toHaveBeenCalledTimes(1));
    expect(mocks.fsCreateDir).toHaveBeenCalledWith("/workspace/.zoc");
    const written = JSON.parse(mocks.fsWriteText.mock.calls[0][1] as string) as {
      mcpServers: Record<string, unknown>;
    };
    expect(written.mcpServers["web-search"]).toEqual(
      expect.objectContaining({
        command: "/opt/zoc-studio-agent",
        args: ["--mcp-server", "web_search"],
        autoApprove: ["web_search"],
      }),
    );
    expect(mocks.reloadMcp).toHaveBeenCalledTimes(1);
  });

  it("tests the unsaved candidate without writing or reloading", async () => {
    render(<McpSection />);
    await screen.findByText("web-search");

    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    fireEvent.change(screen.getByPlaceholderText("my-server"), { target: { value: "candidate" } });
    fireEvent.change(screen.getByPlaceholderText("python"), { target: { value: "python3" } });
    fireEvent.change(screen.getByPlaceholderText("-m my_server"), {
      target: { value: "-m candidate_server" },
    });
    fireEvent.change(screen.getByPlaceholderText("tool_a, tool_b"), {
      target: { value: "safe" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    await waitFor(() => expect(mocks.testMcpServer).toHaveBeenCalledTimes(1));
    expect(mocks.testMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "candidate",
        transport: "stdio",
        command: "python3",
        args: ["-m", "candidate_server"],
        autoApprove: ["safe"],
        disabled: false,
      }),
    );
    expect(mocks.fsWriteText).not.toHaveBeenCalled();
    expect(mocks.reloadMcp).not.toHaveBeenCalled();
    expect(await screen.findByText(/OK — 1 tool/)).toBeTruthy();
  });
});
