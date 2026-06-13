import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PermissionsSection } from "@/features/settings/sections/Permissions";
import { useApp } from "@/lib/store";

const initial = useApp.getState();

describe("PermissionsSection", () => {
  beforeEach(() => {
    useApp.setState({ ...initial });
  });

  it("renders the empty per-tool overrides hint when there are no grants", async () => {
    useApp.setState({
      toolGrants: [],
      loadPermissions: vi.fn(async () => {}),
      loadToolDescriptors: vi.fn(async () => {}),
      loadToolGrants: vi.fn(async () => {}),
    });

    render(<PermissionsSection />);

    expect(
      await screen.findByText(/No per-tool grants yet/i),
    ).toBeInTheDocument();
  });

  it("lists an active per-tool grant and revokes it via the button", async () => {
    const revokeTool = vi.fn(async () => true);
    useApp.setState({
      toolGrants: [{ tool: "run_command", granted: true, once: true }],
      loadPermissions: vi.fn(async () => {}),
      loadToolDescriptors: vi.fn(async () => {}),
      loadToolGrants: vi.fn(async () => {}),
      revokeTool,
    });

    render(<PermissionsSection />);

    expect(await screen.findByText("run_command")).toBeInTheDocument();
    expect(screen.getByText(/once/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /revoke/i }));

    await waitFor(() => expect(revokeTool).toHaveBeenCalledWith("run_command"));
  });
});
