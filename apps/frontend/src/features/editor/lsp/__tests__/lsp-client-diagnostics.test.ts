import { describe, expect, it, vi } from "vitest";
import { createDiagnosticsMiddleware } from "../lsp-client";
import type { LspDiagnostic } from "../diagnostics-bridge";

/** A Monaco-like Uri whose `toString()` yields the canonical string form. */
function fakeUri(value: string): { toString(): string } {
  return { toString: () => value };
}

const diags: LspDiagnostic[] = [
  { range: { start: { line: 0, character: 0 } }, message: "boom", severity: 1 },
];

describe("lsp-client handleDiagnostics middleware (task 2.4)", () => {
  it("forwards the stringified URI and diagnostics to the hook, then calls next", () => {
    const hook = vi.fn();
    const next = vi.fn();
    const mw = createDiagnosticsMiddleware("pyright", hook);

    mw.handleDiagnostics(fakeUri("file:///a/b.py"), diags, next);

    expect(hook).toHaveBeenCalledWith("pyright", "file:///a/b.py", diags);
    expect(next).toHaveBeenCalledWith(expect.anything(), diags);
  });

  it("still calls next even when the hook throws (native squiggles preserved)", () => {
    const hook = vi.fn(() => {
      throw new Error("bridge failure");
    });
    const next = vi.fn();
    const mw = createDiagnosticsMiddleware("typescript-language-server", hook);

    expect(() =>
      mw.handleDiagnostics(fakeUri("file:///a.ts"), diags, next),
    ).toThrow("bridge failure");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("calls next even when no hook is provided", () => {
    const next = vi.fn();
    const mw = createDiagnosticsMiddleware("rust-analyzer");
    mw.handleDiagnostics(fakeUri("file:///a.rs"), diags, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
