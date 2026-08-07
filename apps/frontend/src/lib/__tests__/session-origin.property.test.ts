// Feature: zoc-ai-agent-chat-overhaul, Property 30: Sessions are bound to the resolved workspace
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { sessionOrigin } from "@/lib/session-origin";

describe("sessionOrigin (Property 30 — frontend foreign-session predicate)", () => {
  it("is foreign exactly when the roots differ and then requires confirmation", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).map((s) => `/${s.replace(/\//g, "_")}`),
        fc.option(
          fc.string({ minLength: 1 }).map((s) => `/${s.replace(/\//g, "_")}`),
          { nil: null },
        ),
        (sessionRoot, resolvedRoot) => {
          const origin = sessionOrigin(sessionRoot, resolvedRoot);
          const stripped = (r: string) => r.replace(/[/\\]+$/, "");
          const same = resolvedRoot !== null && stripped(sessionRoot) === stripped(resolvedRoot);
          if (same) {
            expect(origin.kind).toBe("current");
          } else {
            expect(origin.kind).toBe("foreign");
            if (origin.kind === "foreign") {
              expect(origin.requiresConfirmation).toBe(true);
              expect(origin.basename.length).toBeGreaterThan(0);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("treats trailing-separator differences as the same root", () => {
    expect(sessionOrigin("/home/proj/", "/home/proj").kind).toBe("current");
    expect(sessionOrigin("/home/proj", "/home/other").kind).toBe("foreign");
    expect(sessionOrigin("/home/proj", null).kind).toBe("foreign");
  });
});
