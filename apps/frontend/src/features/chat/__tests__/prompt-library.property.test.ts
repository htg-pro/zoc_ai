/** Property 68: prompt libraries round-trip and substitute completely (R28.3/R28.5). */
/** Feature: zoc-agent-chat-rebuild, Property 68 (R28.3, R28.5). */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  loadPromptLibrary,
  persistPromptLibrary,
  placeholdersOf,
  substitutePrompt,
  type PromptStorage,
  type SavedPrompt,
} from "../composer/prompt-library";

class MemoryStorage implements PromptStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe("Property 68: prompt library round-trip and substitution", () => {
  it("restores an equal valid library", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            id: fc.uuid(),
            name: fc
              .string({ minLength: 1, maxLength: 40 })
              .filter((value) => value.trim().length > 0),
            content: fc
              .string({ minLength: 1, maxLength: 200 })
              .filter((value) => value.trim().length > 0),
            updatedAt: fc
              .date({ min: new Date(0), max: new Date("2100-01-01") })
              .map((date) => date.toISOString()),
          }),
          { selector: (prompt) => prompt.id, maxLength: 30 },
        ),
        (library) => {
          const storage = new MemoryStorage();
          persistPromptLibrary(storage, library);
          const restored = loadPromptLibrary(storage);
          const expected = (library as SavedPrompt[])
            .map((prompt) => ({ ...prompt, name: prompt.name.trim() }))
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
          expect(restored).toEqual(expected);
        },
      ),
      { numRuns: 120 },
    );
  });

  it("inserts every value and leaves no placeholder syntax", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,12}$/u), { maxLength: 12 }),
        fc.array(fc.string({ maxLength: 30 }), { maxLength: 12 }),
        (names, rawValues) => {
          const values = Object.fromEntries(
            names.map((name, index) => [name, rawValues[index] ?? `v${String(index)}`]),
          );
          const template = names.map((name) => `before {{${name}}} after`).join(" | ");
          const inserted = substitutePrompt(template, values);
          expect(placeholdersOf(inserted)).toEqual([]);
          for (const value of Object.values(values)) expect(inserted).toContain(value);
        },
      ),
      { numRuns: 180 },
    );
  });
});
