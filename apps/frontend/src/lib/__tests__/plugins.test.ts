import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetPluginHostForTests,
  activeContributedViews,
  getPluginLogs,
  getPlugins,
  installPlugin,
  reportPluginError,
  setPluginEnabled,
  uninstallPlugin,
} from "@/lib/plugins";
import { getCommand, getCommands } from "@/lib/commands";

const realLocalStorage = globalThis.localStorage;

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

const PLUGIN = {
  id: "hello",
  name: "Hello",
  version: "1.0.0",
  contributes: {
    commands: [{ id: "hello.say", title: "Say Hi" }],
    views: [{ id: "hello.view", name: "Hello", location: "sidebar" }],
  },
};

describe("plugin host", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeStorage());
    __resetPluginHostForTests();
  });
  afterAll(() => {
    vi.stubGlobal("localStorage", realLocalStorage);
    __resetPluginHostForTests();
  });

  it("installs a plugin and contributes a command + a view", () => {
    const errors = installPlugin(PLUGIN, "folder");
    expect(errors).toEqual([]);
    expect(getPlugins()).toHaveLength(1);
    // Command appears in the palette and is runnable.
    expect(getCommand("hello.say")).toBeDefined();
    expect(getCommands().some((c) => c.id === "hello.say")).toBe(true);
    // View is exposed with its owning plugin.
    expect(activeContributedViews()).toEqual([
      expect.objectContaining({ id: "hello.view", name: "Hello", pluginId: "hello" }),
    ]);
  });

  it("disabling a plugin removes its contributed commands + views", () => {
    installPlugin(PLUGIN);
    expect(getCommand("hello.say")).toBeDefined();
    setPluginEnabled("hello", false);
    expect(getCommand("hello.say")).toBeUndefined();
    expect(activeContributedViews()).toEqual([]);
    // Re-enabling restores them.
    setPluginEnabled("hello", true);
    expect(getCommand("hello.say")).toBeDefined();
  });

  it("isolates a bad manifest: logs an error, leaves others intact", () => {
    installPlugin(PLUGIN);
    const errors = installPlugin({ name: "broken" }); // no id/version
    expect(errors.length).toBeGreaterThan(0);
    expect(getPlugins()).toHaveLength(1); // the good one survives
    expect(getCommand("hello.say")).toBeDefined();
    expect(getPluginLogs().some((l) => l.level === "error")).toBe(true);
  });

  it("reportPluginError disables contributions but keeps the plugin visible", () => {
    installPlugin(PLUGIN);
    reportPluginError("hello", "activation threw");
    const p = getPlugins().find((x) => x.manifest.id === "hello");
    expect(p?.errored).toBe(true);
    expect(getCommand("hello.say")).toBeUndefined(); // contributions dropped
    expect(getPluginLogs().some((l) => l.message.includes("activation threw"))).toBe(true);
  });

  it("uninstall removes the plugin and its contributions", () => {
    installPlugin(PLUGIN);
    uninstallPlugin("hello");
    expect(getPlugins()).toHaveLength(0);
    expect(getCommand("hello.say")).toBeUndefined();
  });

  it("persists installs and re-hydrates after a reset", () => {
    installPlugin(PLUGIN);
    setPluginEnabled("hello", false);
    // Simulate a reload: drop in-memory state, keep localStorage.
    __resetPluginHostForTests();
    const plugins = getPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].enabled).toBe(false); // disabled state survived
  });

  it("updating an installed id preserves enabled state", () => {
    installPlugin(PLUGIN);
    setPluginEnabled("hello", false);
    installPlugin({ ...PLUGIN, version: "2.0.0" });
    const p = getPlugins().find((x) => x.manifest.id === "hello");
    expect(p?.manifest.version).toBe("2.0.0");
    expect(p?.enabled).toBe(false);
  });
});
