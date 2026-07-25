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
