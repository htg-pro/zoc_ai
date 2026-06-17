import { describe, expect, it } from "vitest";
import { parsePluginManifest } from "@/lib/plugin-manifest";

const VALID = {
  id: "hello-world",
  name: "Hello World",
  version: "1.2.3",
  description: "A sample.",
  activationEvents: ["onStartup"],
  contributes: {
    commands: [{ id: "hello.say", title: "Say Hi", category: "Hello" }],
    views: [{ id: "hello.view", name: "Hello", location: "panel" }],
    tasks: [{ id: "t1", label: "Build", command: "make" }],
    snippets: [{ language: "ts", name: "log", prefix: "log", body: "console.log()" }],
    themes: [{ id: "dark+", label: "Dark+", type: "light" }],
    languages: [{ id: "toml", extensions: [".toml"], aliases: ["TOML"] }],
  },
};

describe("parsePluginManifest", () => {
  it("parses a full, valid manifest", () => {
    const { manifest, errors } = parsePluginManifest(VALID);
    expect(errors).toEqual([]);
    expect(manifest).not.toBeNull();
    expect(manifest!.id).toBe("hello-world");
    expect(manifest!.contributes.commands[0]).toEqual({
      id: "hello.say",
      title: "Say Hi",
      category: "Hello",
    });
    expect(manifest!.contributes.views[0]).toEqual({
      id: "hello.view",
      name: "Hello",
      location: "panel",
    });
    expect(manifest!.contributes.themes[0].type).toBe("light");
    expect(manifest!.contributes.languages[0].extensions).toEqual([".toml"]);
  });

  it("accepts a JSON string and defaults optional fields", () => {
    const { manifest } = parsePluginManifest(
      JSON.stringify({ id: "x", name: "X", version: "0.1.0" }),
    );
    expect(manifest).not.toBeNull();
    expect(manifest!.activationEvents).toEqual([]);
    expect(manifest!.contributes.commands).toEqual([]);
    expect(manifest!.description).toBe("");
  });

  it("defaults view location to sidebar", () => {
    const { manifest } = parsePluginManifest({
      id: "x",
      name: "X",
      version: "0.1.0",
      contributes: { views: [{ id: "v", name: "V" }] },
    });
    expect(manifest!.contributes.views[0].location).toBe("sidebar");
  });

  it("rejects missing identity fields (fatal → null manifest)", () => {
    const { manifest, errors } = parsePluginManifest({ name: "No Id" });
    expect(manifest).toBeNull();
    expect(errors.some((e) => e.includes("id"))).toBe(true);
    expect(errors.some((e) => e.includes("version"))).toBe(true);
  });

  it("rejects an invalid id and version", () => {
    const bad = parsePluginManifest({ id: "Bad Id!", name: "X", version: "1.x" });
    expect(bad.manifest).toBeNull();
    expect(bad.errors.some((e) => e.includes("Invalid id"))).toBe(true);
    expect(bad.errors.some((e) => e.includes("Invalid version"))).toBe(true);
  });

  it("collects per-contribution errors for malformed commands/views", () => {
    const { errors } = parsePluginManifest({
      id: "x",
      name: "X",
      version: "1.0.0",
      contributes: { commands: [{ title: "no id" }], views: [{ id: "v" }] },
    });
    expect(errors.some((e) => e.includes("commands[0]"))).toBe(true);
    expect(errors.some((e) => e.includes("views[0]"))).toBe(true);
  });

  it("handles non-JSON and non-object input", () => {
    expect(parsePluginManifest("{ not json").manifest).toBeNull();
    expect(parsePluginManifest("[]").errors.length).toBeGreaterThan(0);
  });
});
