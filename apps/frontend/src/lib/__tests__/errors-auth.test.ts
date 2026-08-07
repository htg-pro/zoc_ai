// Feature: zoc-ai-agent-chat-overhaul, Task 13: structured GatewayRequestError is retained; auth errors are recognized
import { describe, expect, it } from "vitest";
import { AUTH_STATUSES, isAuthError, normalizeError } from "../errors";
import { GatewayRequestError } from "@/lib/gateway-client";

describe("error normalization retains structured GatewayRequestError fields", () => {
  it("keeps code/status/details/retryable through normalizeError", () => {
    const err = new GatewayRequestError("Invalid API key", {
      code: "authentication_error",
      status: 401,
      details: "provider rejected the key",
      retryable: false,
    });
    const app = normalizeError(err, "run");
    expect(app.code).toBe("authentication_error");
    expect(app.status).toBe(401);
    expect(app.details).toBe("provider rejected the key");
    expect(app.retryable).toBe(false);
    expect(app.message).toBe("Invalid API key");
  });

  it("recognizes auth failures by status (401/403) and by code", () => {
    for (const status of AUTH_STATUSES) {
      expect(isAuthError({ status })).toBe(true);
    }
    expect(isAuthError({ code: "invalid_api_key" })).toBe(true);
    expect(isAuthError({ code: "unauthorized" })).toBe(true);
    expect(isAuthError({ status: 500 })).toBe(false);
    expect(isAuthError({ code: "model_not_ready" })).toBe(false);
    expect(isAuthError(null)).toBe(false);
  });

  it("normalizeError + isAuthError compose for a 403 gateway error", () => {
    const err = new GatewayRequestError("Forbidden", { code: "forbidden", status: 403 });
    expect(isAuthError(normalizeError(err, "run"))).toBe(true);
  });
});
