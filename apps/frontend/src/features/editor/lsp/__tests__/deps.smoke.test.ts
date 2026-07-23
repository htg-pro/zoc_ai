// Feature: monaco-lsp-integration, Smoke (3.1): LSP client deps are declared
import { describe, expect, it } from "vitest";
// Resolves to apps/frontend/package.json (five levels up from this test file).
import pkg from "../../../../../package.json";

describe("monaco LSP dependencies", () => {
  it("declares monaco-languageclient and vscode-ws-jsonrpc in dependencies", () => {
    const deps = (pkg as { dependencies?: Record<string, string> }).dependencies ?? {};
    expect(deps["monaco-languageclient"]).toBeTruthy();
    expect(deps["vscode-ws-jsonrpc"]).toBeTruthy();
  });
});
