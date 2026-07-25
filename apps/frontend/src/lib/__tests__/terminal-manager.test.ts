import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  events: [] as Array<
    | { type: "data"; chunk: string }
    | { type: "exit"; code: number | null }
    | { type: "error"; message: string }
  >,
  spawnTerminal: vi.fn(),
  stopTerminal: vi.fn(),
}));

vi.mock("../agent-client", () => ({
  getAgentClient: async () => ({
    spawnTerminal: (...args: unknown[]) => mocks.spawnTerminal(...args),
    stopTerminal: (...args: unknown[]) => mocks.stopTerminal(...args),
    writeTerminal: vi.fn(async () => undefined),
    resizeTerminal: vi.fn(async () => undefined),
    terminalStream: async function* () {
      for (const event of mocks.events) yield event;
    },
  }),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon(): void {}
    open(): void {}
    write(): void {}
    writeln(): void {}
    onData(): void {}
    focus(): void {}
    clear(): void {}
    dispose(): void {}
    registerLinkProvider(): void {}
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit(): void {}
  },
}));

import {
  createTerminal,
  disposeTerminal,
  ensureTerminalCwd,
  getTerminalCwd,
  getTerminalOutput,
  subscribeTerminalOutput,
  writeToTerminal,
} from "../terminal-manager";
import type { TerminalProfile } from "../store";

const PROFILE: TerminalProfile = {
  id: "test-shell",
  name: "Test shell",
  command: "/bin/sh",
  args: [],
};

beforeEach(() => {
  mocks.events = [
    { type: "data", chunk: "\u001b[31msrc/main.ts:9:2\u001b[0m\n" },
    { type: "exit", code: 0 },
  ];
  mocks.spawnTerminal.mockReset();
  mocks.spawnTerminal.mockResolvedValue({ id: "backend-1" });
  mocks.stopTerminal.mockReset();
  mocks.stopTerminal.mockResolvedValue({ id: "backend-1" });
});

test("deduplicates concurrent creation and publishes a plain bounded transcript", async () => {
  const id = `manager-${Date.now()}`;
  const listener = vi.fn();
  const unsubscribe = subscribeTerminalOutput(id, listener);

  await Promise.all([
    createTerminal(id, PROFILE, "/workspace"),
    createTerminal(id, PROFILE, "/workspace"),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(mocks.spawnTerminal).toHaveBeenCalledTimes(1);
  expect(getTerminalOutput(id)).toContain("src/main.ts:9:2");
  expect(getTerminalOutput(id)).not.toContain("\u001b[31m");
  expect(listener).toHaveBeenCalled();

  writeToTerminal(id, "x".repeat(70 * 1024));
  expect(getTerminalOutput(id).length).toBeLessThanOrEqual(64 * 1024);

  unsubscribe();
  await disposeTerminal(id);
  expect(mocks.stopTerminal).toHaveBeenCalledWith("backend-1");
});

test("always sends an explicit cwd to the sidecar", async () => {
  // Omitting `cwd` is what made the sidecar start the shell in its own
  // directory — the app's install/bin path in a packaged build.
  const id = `cwd-${Date.now()}`;
  await createTerminal(id, PROFILE, "/workspace/project");

  expect(mocks.spawnTerminal).toHaveBeenCalledWith(
    "/bin/sh",
    expect.objectContaining({ cwd: "/workspace/project" }),
  );
  expect(getTerminalCwd(id)).toBe("/workspace/project");
  await disposeTerminal(id);
});

test("does not spawn a PTY when no workspace is open", async () => {
  const id = `nows-${Date.now()}`;
  await createTerminal(id, PROFILE, null);

  expect(mocks.spawnTerminal).not.toHaveBeenCalled();
  expect(getTerminalCwd(id)).toBeNull();
  // The pane explains itself rather than opening a shell somewhere arbitrary.
  expect(getTerminalOutput(id)).toContain("Open a project folder");
  await disposeTerminal(id);
});

test("reuses a terminal already rooted in the active workspace", async () => {
  const id = `reuse-${Date.now()}`;
  await ensureTerminalCwd(id, PROFILE, "/workspace/a");
  await ensureTerminalCwd(id, PROFILE, "/workspace/a");

  expect(mocks.spawnTerminal).toHaveBeenCalledTimes(1);
  await disposeTerminal(id);
});

test("recreates the terminal when the workspace switches", async () => {
  // Previously the pane skipped any session that already had an instance, so
  // the old PTY — still sitting in the previous project — stayed attached and
  // `pwd` reported the wrong directory.
  const id = `switch-${Date.now()}`;
  await ensureTerminalCwd(id, PROFILE, "/workspace/a");
  expect(getTerminalCwd(id)).toBe("/workspace/a");

  await ensureTerminalCwd(id, PROFILE, "/workspace/b");

  expect(mocks.spawnTerminal).toHaveBeenCalledTimes(2);
  expect(mocks.spawnTerminal).toHaveBeenLastCalledWith(
    "/bin/sh",
    expect.objectContaining({ cwd: "/workspace/b" }),
  );
  expect(getTerminalCwd(id)).toBe("/workspace/b");
  // The stale PTY was torn down, not leaked.
  expect(mocks.stopTerminal).toHaveBeenCalled();
  await disposeTerminal(id);
});

test("reports a stopped terminal distinctly from a crash", async () => {
  mocks.events = [{ type: "exit", code: null, reason: "crashed" } as never];
  const crashed = `crash-${Date.now()}`;
  await createTerminal(crashed, PROFILE, "/workspace");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(getTerminalOutput(crashed)).toContain("exited unexpectedly");
  await disposeTerminal(crashed);

  mocks.events = [{ type: "exit", code: 0, reason: "stopped" } as never];
  const stopped = `stop-${Date.now()}`;
  await createTerminal(stopped, PROFILE, "/workspace");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(getTerminalOutput(stopped)).toContain("terminal stopped");
  await disposeTerminal(stopped);
});
