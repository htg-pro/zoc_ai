/**
 * viewer-context.test.ts — the read-only gate, tested directly.
 *
 * Until task 26.1 these rows lived in `features/agent/__tests__/share-session.test.ts` and reached
 * `viewerContextFrom` through that module's re-export. `lib/viewer-context.ts` outlives that tree, so
 * the coverage had to move or it would have vanished with the shim — leaving the one determination
 * that decides whether a window offers write actions with no test at all.
 *
 * The row that matters most is the desktop one: a viewer is a *browser* window carrying a token, and
 * the host's own Tauri window must never downgrade itself to read-only however odd its query string.
 */
import { describe, expect, it } from "vitest";

import { SHARE_TOKEN_PARAM, currentViewerContext, viewerContextFrom } from "../viewer-context";

describe("viewerContextFrom", () => {
  it("treats a tokened browser window as a read-only viewer", () => {
    expect(
      viewerContextFrom("?token=deadbeefdeadbeef&runId=run-42", "192.168.1.14", "52311", false),
    ).toEqual({
      readOnly: true,
      token: "deadbeefdeadbeef",
      runId: "run-42",
      host: "192.168.1.14:52311",
    });
  });

  it("never marks the desktop shell read-only, even with a token", () => {
    const ctx = viewerContextFrom("?token=abc&runId=run-42", "localhost", "1420", true);
    expect(ctx.readOnly).toBe(false);
    expect(ctx.token).toBeNull();
    expect(ctx.runId).toBeNull();
    expect(ctx.host).toBeNull();
  });

  it("is not read-only without a token", () => {
    expect(viewerContextFrom("", "localhost", "1420", false).readOnly).toBe(false);
    expect(viewerContextFrom("?other=1", "localhost", "", false).readOnly).toBe(false);
    expect(viewerContextFrom("?runId=run-42", "localhost", "", false).readOnly).toBe(false);
  });

  it("omits the port from the host label when there isn't one", () => {
    expect(viewerContextFrom("?token=t", "zoc.local", "", false).host).toBe("zoc.local");
  });

  it("carries a token without a runId — a share can be unbound", () => {
    const ctx = viewerContextFrom(`?${SHARE_TOKEN_PARAM}=t`, "zoc.local", "80", false);
    expect(ctx.readOnly).toBe(true);
    expect(ctx.runId).toBeNull();
  });
});

describe("currentViewerContext", () => {
  it("reads the live location, and is not read-only on a plain URL", () => {
    window.history.replaceState({}, "", "/");
    expect(currentViewerContext()).toEqual({
      readOnly: false,
      token: null,
      runId: null,
      host: null,
    });
  });

  it("becomes a viewer once the URL carries a token", () => {
    window.history.replaceState({}, "", "/?token=abc123&runId=run-7");
    const ctx = currentViewerContext();
    expect(ctx.readOnly).toBe(true);
    expect(ctx.token).toBe("abc123");
    expect(ctx.runId).toBe("run-7");
    window.history.replaceState({}, "", "/");
  });
});
