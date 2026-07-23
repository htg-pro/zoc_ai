import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { Diagnostic } from "@/lib/problem-matchers";
import { lspSourceKey } from "../lsp/diagnostics-bridge";

// Capture the fs-changed callback and unsubscribe spy so the test can drive
// `fs://changed` events and assert unsubscription on dispose.
const h = vi.hoisted(() => ({
  fsCb: null as ((paths: string[]) => void) | null,
  unsub: vi.fn(),
}));

vi.mock("@/lib/tauri-bridge", () => ({
  onFsChanged: vi.fn(async (cb: (paths: string[]) => void) => {
    h.fsCb = cb;
    return h.unsub;
  }),
  fsStat: vi.fn(async (path: string) =>
    path.includes("deleted")
      ? { exists: false, is_dir: false, is_file: false, size: 0, modified_ms: null }
      : { exists: true, is_dir: false, is_file: true, size: 1, modified_ms: null },
  ),
  isTauri: () => false,
}));

// Keep the heavy monaco services layer inert in this hook test.
vi.mock("../lsp/monaco-services", () => ({
  ensureServicesInitialized: vi.fn(async () => undefined),
}));

import { useApp } from "@/lib/store";
import { useLspLifecycle } from "../useLspLifecycle";

const initial = useApp.getState();

function diag(file: string): Diagnostic {
  return { source: "pyright", file, line: 1, column: 1, severity: "error", message: "m" };
}

beforeEach(() => {
  useApp.setState({ ...initial, diagnostics: {}, openFiles: [] });
  h.fsCb = null;
  h.unsub.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useLspLifecycle diagnostics wiring (task 4.2)", () => {
  it("adds no lsp:* keys and leaves checker entries untouched with no server (R7.1, R7.2)", async () => {
    const checker: Diagnostic[] = [
      { source: "typescript", file: "/ws/a.ts", line: 1, column: 1, severity: "error", message: "e" },
    ];
    useApp.setState({ diagnostics: { typescript: checker } });

    const { unmount } = renderHook(() => useLspLifecycle());
    await waitFor(() => expect(h.fsCb).not.toBeNull());

    const diagnostics = useApp.getState().diagnostics;
    // No server connected → no LSP entries were created.
    expect(Object.keys(diagnostics).some((k) => k.startsWith("lsp:"))).toBe(false);
    // The command-checker entry is byte-identical.
    expect(diagnostics.typescript).toBe(checker);
    unmount();
  });

  it("clears the lsp:* entry for a confirmed-deleted file, and ignores events after dispose (R5.1, R5.5)", async () => {
    const key = lspSourceKey("file:///ws/deleted.ts");
    const kept = lspSourceKey("file:///ws/keep.ts");
    useApp.setState({
      diagnostics: {
        [key]: [diag("/ws/deleted.ts")],
        [kept]: [diag("/ws/keep.ts")],
        typescript: [diag("/ws/a.ts")],
      },
    });

    const { unmount } = renderHook(() => useLspLifecycle());
    await waitFor(() => expect(h.fsCb).not.toBeNull());

    // A deletion event for the deleted file clears only its lsp entry.
    h.fsCb?.(["/ws/deleted.ts"]);
    await waitFor(() => expect(key in useApp.getState().diagnostics).toBe(false));
    const afterDelete = useApp.getState().diagnostics;
    expect(kept in afterDelete).toBe(true); // other lsp entry kept
    expect(afterDelete.typescript).toBeDefined(); // checker entry kept

    // R5.5: after dispose, unsubscribe fired and later events change nothing.
    unmount();
    expect(h.unsub).toHaveBeenCalledTimes(1);
    const snapshot = useApp.getState().diagnostics;
    h.fsCb?.(["/ws/keep.ts"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(useApp.getState().diagnostics).toBe(snapshot);
    expect(kept in useApp.getState().diagnostics).toBe(true);
  });
});
