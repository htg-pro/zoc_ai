import { test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { strToU8, zipSync } from "fflate";
import { PluginMarketplace } from "../PluginMarketplace";
import { __resetPluginHostForTests, getPlugin, installPlugin } from "@/lib/plugins";

const REGISTRY = [
  {
    id: "zoc.hello",
    name: "Hello World",
    description: "hi",
    author: "Zoc",
    version: "1.0.0",
    tags: ["example"],
    downloadUrl: "https://plugins.test/hello.zip",
    stars: 1,
    verified: true,
  },
  {
    id: "zoc.word",
    name: "Word Count",
    description: "counts",
    author: "Zoc",
    version: "1.0.0",
    tags: ["productivity"],
    downloadUrl: "",
    stars: 2,
    verified: false,
  },
];

const originalFetch = globalThis.fetch;

beforeEach(() => {
  __resetPluginHostForTests();
  globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("registry.zoc.studio")) throw new Error("offline"); // remote fails → fallback
    if (u.includes("plugins.json")) {
      return { ok: true, text: async () => JSON.stringify(REGISTRY) } as Response;
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetPluginHostForTests();
  vi.restoreAllMocks();
});

test("renders the registry from the bundled fallback and filters live", async () => {
  render(<PluginMarketplace />);
  await waitFor(() => expect(screen.getByText("Hello World")).toBeTruthy());
  expect(screen.getByText("Word Count")).toBeTruthy();
  expect(screen.getByRole("button", { name: /Unavailable/ })).toBeDisabled();

  fireEvent.change(screen.getByLabelText("Search plugins"), { target: { value: "product" } });
  expect(screen.queryByText("Hello World")).toBeNull(); // filtered out by tag search
  expect(screen.getByText("Word Count")).toBeTruthy();
});

test("Installed tab lists installed plugins and supports uninstall", async () => {
  installPlugin(
    { id: "inst.one", name: "Installed One", version: "1.0.0", contributes: {} },
    "zip",
  );
  render(<PluginMarketplace />);
  fireEvent.click(screen.getByText(/Installed \(/));
  await waitFor(() => expect(screen.getByText("Installed One")).toBeTruthy());
  expect(screen.getByLabelText("Uninstall Installed One")).toBeTruthy();
});

test("downloads a binary zip and installs its validated entry code", async () => {
  const code = "zoc.commands.register('zoc.hello.say', () => undefined);";
  const artifact = zipSync({
    "package/manifest.json": strToU8(
      JSON.stringify({
        id: "zoc.hello",
        name: "Hello World",
        version: "1.0.0",
        main: "main.js",
        contributes: { commands: [{ id: "zoc.hello.say", title: "Say hello" }] },
      }),
    ),
    "package/main.js": strToU8(code),
  });
  globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
    const value = String(url);
    if (value.includes("registry.zoc.studio")) throw new Error("offline");
    if (value.endsWith("/plugins.json")) {
      return { ok: true, text: async () => JSON.stringify(REGISTRY) } as Response;
    }
    if (value === "https://plugins.test/hello.zip") {
      return new Response(artifact, {
        status: 200,
        headers: { "content-length": String(artifact.byteLength) },
      });
    }
    throw new Error(`unexpected fetch: ${value}`);
  }) as typeof fetch;

  render(<PluginMarketplace />);
  await waitFor(() => expect(screen.getByText("Hello World")).toBeTruthy());
  const card = screen.getByText("Hello World").closest('[data-plugin-id="zoc.hello"]');
  fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "Install" }));

  await waitFor(() =>
    expect(screen.getByText("Hello World installed and activated.")).toBeTruthy(),
  );
  expect(getPlugin("zoc.hello")).toMatchObject({
    source: "zip",
    code,
    manifest: { main: "main.js" },
  });
});

test("refuses a downloaded zip without manifest.json", async () => {
  const artifact = zipSync({ "README.md": strToU8("not a plugin") });
  globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
    const value = String(url);
    if (value.includes("registry.zoc.studio")) throw new Error("offline");
    if (value.endsWith("/plugins.json")) {
      return { ok: true, text: async () => JSON.stringify(REGISTRY) } as Response;
    }
    if (value === "https://plugins.test/hello.zip") return new Response(artifact);
    throw new Error(`unexpected fetch: ${value}`);
  }) as typeof fetch;

  render(<PluginMarketplace />);
  await waitFor(() => expect(screen.getByText("Hello World")).toBeTruthy());
  const card = screen.getByText("Hello World").closest('[data-plugin-id="zoc.hello"]');
  fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "Install" }));

  await waitFor(() => expect(screen.getByText(/No manifest\.json found/)).toBeTruthy());
  expect(getPlugin("zoc.hello")).toBeUndefined();
});
