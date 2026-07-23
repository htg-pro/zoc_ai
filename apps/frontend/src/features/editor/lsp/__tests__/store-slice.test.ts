// Feature: monaco-lsp-integration, Example (5.7): synchronous status-slice updates
import { afterEach, describe, expect, it } from "vitest";
import { useApp } from "@/lib/store";

afterEach(() => {
  // Leave the slice clean for other suites.
  const { removeServer } = useApp.getState();
  removeServer("pyright");
  removeServer("rust-analyzer");
  removeServer("typescript-language-server");
});

describe("serverStates slice (R5.7)", () => {
  it("setServerState updates the slice synchronously (no debounce/timer)", () => {
    useApp.getState().setServerState("pyright", "starting");
    // Readable immediately on the very next line — no awaiting, no timers.
    expect(useApp.getState().serverStates.get("pyright")).toBe("starting");

    useApp.getState().setServerState("pyright", "connected");
    expect(useApp.getState().serverStates.get("pyright")).toBe("connected");
  });

  it("replaces the Map reference on each write so selectors re-render", () => {
    useApp.getState().setServerState("pyright", "starting");
    const before = useApp.getState().serverStates;
    useApp.getState().setServerState("rust-analyzer", "error");
    const after = useApp.getState().serverStates;
    expect(after).not.toBe(before); // new reference
    expect(after.get("pyright")).toBe("starting"); // prior entry preserved
    expect(after.get("rust-analyzer")).toBe("error");
  });

  it("removeServer drops the entry synchronously (R5.6)", () => {
    useApp.getState().setServerState("pyright", "connected");
    expect(useApp.getState().serverStates.has("pyright")).toBe(true);
    useApp.getState().removeServer("pyright");
    expect(useApp.getState().serverStates.has("pyright")).toBe(false);
  });
});
