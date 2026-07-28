// Feature: zoc-ai-agent-chat-overhaul, Property 33: The reasoning-effort parameter is present exactly when supported
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import {
  REASONING_EFFORTS,
  buildReasoningEffortField,
  composerControls,
} from "../composer-controls";
import { getReasoningEffort, setReasoningEffort } from "@/lib/settings";
import type { RunGate } from "../model-availability";

const okGate: RunGate = { canStart: true };

const realLocalStorage = globalThis.localStorage;
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

describe("reasoning effort parameter (Property 33)", () => {
  it("is present exactly when the model supports it, and the control is marked unsupported otherwise", () => {
    fc.assert(
      fc.property(fc.constantFrom(...REASONING_EFFORTS), fc.boolean(), (effort, supported) => {
        const field = buildReasoningEffortField(supported, effort);
        if (supported) {
          expect(field).toBe(effort);
        } else {
          expect(field).toBeUndefined();
        }
        const controls = composerControls({
          mode: "agent",
          activeRunMode: null,
          effort,
          modelSupportsEffort: supported,
          readOnly: false,
          gate: okGate,
        });
        expect(controls.effort.supported).toBe(supported);
      }),
      { numRuns: 150 },
    );
  });

  it("persists the selected level across a fresh settings read", () => {
    vi.stubGlobal("localStorage", fakeStorage());
    fc.assert(
      fc.property(fc.constantFrom(...REASONING_EFFORTS), (effort) => {
        setReasoningEffort(effort);
        expect(getReasoningEffort()).toBe(effort);
      }),
      { numRuns: 100 },
    );
    vi.stubGlobal("localStorage", realLocalStorage);
  });
});
