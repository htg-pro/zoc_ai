import { test, expect } from "vitest";
import { strToU8, zipSync } from "fflate";
import fc from "fast-check";
import {
  filterPlugins,
  manifestFromArtifact,
  MAX_PLUGIN_ARCHIVE_BYTES,
  MAX_PLUGIN_FILES,
  MAX_PLUGIN_UNCOMPRESSED_BYTES,
  parseRegistry,
  type RegistryPlugin,
} from "../plugin-registry";

function plugin(over: Partial<RegistryPlugin> = {}): RegistryPlugin {
  return {
    id: "p",
    name: "Plugin",
    description: "",
    author: "",
    version: "1.0.0",
    tags: [],
    downloadUrl: "",
    stars: 0,
    verified: false,
    ...over,
  };
}

const nameArb = fc.string({ minLength: 1, maxLength: 8 });
const pluginArb = fc.record({
  id: fc.string({ minLength: 1, maxLength: 6 }),
  name: nameArb,
  tags: fc.array(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 3 }),
});

// Feature: plugin-system, Property 6: Registry filtering
test("filterPlugins keeps exactly the name/tag matches; empty query keeps all", () => {
  fc.assert(
    fc.property(
      fc.array(pluginArb, { maxLength: 10 }),
      fc.string({ maxLength: 4 }),
      (raw, query) => {
        const list = raw.map((r) => plugin(r));
        const result = filterPlugins(list, query);
        const q = query.trim().toLowerCase();

        if (q === "") {
          expect(result).toEqual(list); // empty query returns all, order preserved
          return;
        }
        const expected = list.filter(
          (p) =>
            p.name.toLowerCase().includes(q) || p.tags.some((t) => t.toLowerCase().includes(q)),
        );
        expect(result).toEqual(expected);
        for (const p of result) {
          expect(
            p.name.toLowerCase().includes(q) || p.tags.some((t) => t.toLowerCase().includes(q)),
          ).toBe(true);
        }
      },
    ),
    { numRuns: 200 },
  );
});

// Feature: plugin-system, Property 7: Install validates before adding
test("manifestFromArtifact returns a plugin only for a valid extracted manifest", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        id: fc.constantFrom("a.b", "my-plugin", "x1"),
        name: nameArb,
        version: fc.constant("1.0.0"),
      }),
      fc.boolean(),
      async (manifestObj, present) => {
        const extract = async () =>
          present ? JSON.stringify({ ...manifestObj, contributes: {} }) : null;
        const result = await manifestFromArtifact("artifact-bytes", extract);
        if (present) {
          expect(result.manifest).not.toBeNull();
          expect(result.manifest?.id).toBe(manifestObj.id);
        } else {
          expect(result.manifest).toBeNull();
          expect(result.errors.length).toBeGreaterThan(0);
        }
      },
    ),
    { numRuns: 150 },
  );
});

test("manifestFromArtifact rejects an invalid manifest without a plugin", async () => {
  const missingId = await manifestFromArtifact('{"name":"No Id","version":"1.0.0"}');
  expect(missingId.manifest).toBeNull();
  expect(missingId.errors.length).toBeGreaterThan(0);

  const notJson = await manifestFromArtifact("not json at all");
  expect(notJson.manifest).toBeNull();
});

test("parseRegistry drops invalid entries and tolerates junk", () => {
  const text = JSON.stringify([
    { id: "a", name: "A", verified: true, stars: 3, tags: ["x"] },
    { id: "", name: "no id" }, // invalid → dropped
    { name: "missing id" }, // invalid → dropped
    "not an object", // dropped
  ]);
  const parsed = parseRegistry(text);
  expect(parsed).toHaveLength(1);
  expect(parsed[0]).toMatchObject({ id: "a", name: "A", verified: true, stars: 3, tags: ["x"] });
  expect(parseRegistry("not json")).toEqual([]);
  expect(parseRegistry('{"not":"array"}')).toEqual([]);
});

test("extracts a validated manifest and its declared JavaScript entry from a real zip", async () => {
  const manifest = {
    id: "zoc.example",
    name: "Example",
    version: "1.2.3",
    main: "dist/main.js",
    contributes: { commands: [{ id: "zoc.example.run", title: "Run" }] },
  };
  const code = "zoc.commands.register('zoc.example.run', () => undefined);";
  const artifact = zipSync({
    "example/manifest.json": strToU8(JSON.stringify(manifest)),
    "example/dist/main.js": strToU8(code),
    "example/README.md": strToU8("ignored"),
  });

  const result = await manifestFromArtifact(artifact);

  expect(result.errors).toEqual([]);
  expect(result.manifest).toMatchObject({ id: "zoc.example", main: "dist/main.js" });
  expect(result.code).toBe(code);
});

test("rejects unsafe, ambiguous, or missing zip entrypoints", async () => {
  const base = { id: "p", name: "Plugin", version: "1.0.0", contributes: {} };
  const unsafe = zipSync({
    "manifest.json": strToU8(JSON.stringify({ ...base, main: "../escape.js" })),
    "escape.js": strToU8("bad"),
  });
  await expect(manifestFromArtifact(unsafe)).resolves.toMatchObject({ manifest: null });
  expect((await manifestFromArtifact(unsafe)).errors.join(" ")).toContain(
    "Unsafe plugin main entry",
  );

  const ambiguous = zipSync({
    "a/manifest.json": strToU8(JSON.stringify(base)),
    "b/manifest.json": strToU8(JSON.stringify(base)),
  });
  expect((await manifestFromArtifact(ambiguous)).errors.join(" ")).toContain("ambiguous");

  const missingEntry = zipSync({
    "manifest.json": strToU8(JSON.stringify({ ...base, main: "main.js" })),
  });
  expect((await manifestFromArtifact(missingEntry)).errors.join(" ")).toContain("not found");
});

test("rejects oversized downloads, excessive entries, and high-expansion archives", async () => {
  const oversized = new Uint8Array(MAX_PLUGIN_ARCHIVE_BYTES + 1);
  expect((await manifestFromArtifact(oversized)).errors.join(" ")).toContain("10 MiB");

  const manyFiles: Record<string, Uint8Array> = {
    "manifest.json": strToU8(
      JSON.stringify({ id: "many", name: "Many", version: "1.0.0", contributes: {} }),
    ),
  };
  for (let index = 0; index < MAX_PLUGIN_FILES; index += 1) {
    manyFiles[`files/${index}.txt`] = new Uint8Array();
  }
  const excessive = zipSync(manyFiles);
  expect((await manifestFromArtifact(excessive)).errors.join(" ")).toContain("too many files");

  const bomb = zipSync(
    {
      "manifest.json": strToU8(
        JSON.stringify({ id: "bomb", name: "Bomb", version: "1.0.0", contributes: {} }),
      ),
      "payload.bin": new Uint8Array(MAX_PLUGIN_UNCOMPRESSED_BYTES + 1),
    },
    { level: 9 },
  );
  expect((await manifestFromArtifact(bomb)).errors.join(" ")).toContain("expands beyond");
});

test("uses index.js when a zip manifest omits main", async () => {
  const code = "zoc.ui.showMessage('loaded');";
  const artifact = zipSync({
    "manifest.json": strToU8(
      JSON.stringify({ id: "default-main", name: "Default", version: "1.0.0", contributes: {} }),
    ),
    "index.js": strToU8(code),
  });
  const result = await manifestFromArtifact(artifact);
  expect(result.manifest?.id).toBe("default-main");
  expect(result.code).toBe(code);
});
