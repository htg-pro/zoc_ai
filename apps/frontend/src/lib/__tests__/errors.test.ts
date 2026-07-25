/**
 * The normaliser exists to make one class of bug impossible: a value that is
 * not an `Error` reaching the chat panel and rendering as `Error: undefined` or
 * `[object Object]`. Every case below is something this app actually throws or
 * rejects with.
 */
import { describe, expect, it } from "vitest";

import {
  ErrorCodes,
  formatDiagnostics,
  formatUserError,
  isAbort,
  normalizeError,
} from "../errors";

describe("normalizeError", () => {
  it("keeps a real Error's message", () => {
    const result = normalizeError(new Error("disk is full"));
    expect(result.message).toBe("disk is full");
    expect(result.code).toBe(ErrorCodes.unknown);
  });

  it("never yields undefined for a thrown non-Error", () => {
    // The exact shapes that produced "Error: undefined" before.
    for (const thrown of [undefined, null, 0, false, {}, [], NaN]) {
      const result = normalizeError(thrown);
      expect(result.message).toBeTruthy();
      expect(result.message).not.toContain("undefined");
      expect(result.message).not.toContain("[object Object]");
    }
  });

  it("never yields undefined for an Error with an empty message", () => {
    const result = normalizeError(new Error(""));
    expect(result.message).toBeTruthy();
    expect(result.message).not.toContain("undefined");
  });

  it("uses a thrown string as the message", () => {
    // Tauri `invoke` rejects with a plain string.
    const result = normalizeError("workspace not found: /gone");
    expect(result.message).toBe("workspace not found: /gone");
  });

  it("reads the gateway envelope, preserving code and retryability", () => {
    const result = normalizeError({
      code: "no_workspace",
      message: "No workspace is open. Open a project folder before using Agent mode.",
      details: "workspace_id=none",
      retryable: false,
    });
    expect(result.code).toBe(ErrorCodes.noWorkspace);
    expect(result.message).toContain("Open a project folder");
    expect(result.details).toBe("workspace_id=none");
    expect(result.retryable).toBe(false);
  });

  it("unwraps an envelope nested under FastAPI's `detail`", () => {
    const result = normalizeError({
      detail: { code: "run_not_found", message: "The agent run ended before it could be attached. Please retry.", retryable: true },
    });
    expect(result.code).toBe(ErrorCodes.runNotFound);
    expect(result.retryable).toBe(true);
  });

  it("recovers an envelope serialised into an Error message", () => {
    const raw = JSON.stringify({ code: "run_failed", message: "The run stopped because of an error." });
    const result = normalizeError(new Error(raw));
    expect(result.code).toBe(ErrorCodes.runFailed);
    expect(result.message).toBe("The run stopped because of an error.");
    // The user must never see raw JSON.
    expect(result.message).not.toContain("{");
  });

  it("reads a `code` carried on an Error subclass", () => {
    class Transport extends Error {
      code = "no_workspace";
    }
    const result = normalizeError(new Transport("boom"));
    expect(result.code).toBe(ErrorCodes.noWorkspace);
  });

  it("treats an abort as a cancellation, not a failure", () => {
    const abort = new DOMException("aborted", "AbortError");
    expect(isAbort(abort)).toBe(true);
    expect(normalizeError(abort).code).toBe(ErrorCodes.cancelled);
  });

  it("applies the caller's fallback code when the value carries none", () => {
    const result = normalizeError(new Error("nope"), ErrorCodes.terminalSpawnFailed);
    expect(result.code).toBe(ErrorCodes.terminalSpawnFailed);
  });

  it("bounds an oversized message", () => {
    const result = normalizeError("x".repeat(5_000));
    expect(result.message.length).toBeLessThanOrEqual(601);
  });
});

describe("formatUserError", () => {
  it("shows only the message, never the internal code", () => {
    const line = formatUserError({ code: "run_not_found", message: "Please retry." });
    expect(line).toBe("Please retry.");
    expect(line).not.toContain("run_not_found");
  });
});

describe("formatDiagnostics", () => {
  it("carries the code and details the user-facing line omits", () => {
    const blob = formatDiagnostics(
      { code: "run_failed", message: "It failed.", details: "stage=apply", retryable: true },
      { runId: "run-1", mode: "agent" },
    );
    expect(blob).toContain("code: run_failed");
    expect(blob).toContain("details: stage=apply");
    expect(blob).toContain("runId: run-1");
  });
});
