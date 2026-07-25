import { describe, expect, it } from "vitest";
import {
  SHARE_TOKEN_PARAM,
  shareUrl,
  viewerContextFrom,
  viewerEventsPath,
  viewerReplayPath,
  viewersLabel,
} from "../share-session";

describe("viewerContextFrom", () => {
  it("treats a tokened browser window as a read-only viewer", () => {
    const ctx = viewerContextFrom(
      "?token=deadbeefdeadbeef&runId=run-42",
      "192.168.1.14",
      "52311",
      false,
    );
    expect(ctx).toEqual({
      readOnly: true,
      token: "deadbeefdeadbeef",
      runId: "run-42",
      host: "192.168.1.14:52311",
    });
  });

  it("never marks the desktop shell read-only, even with a token", () => {
    const ctx = viewerContextFrom("?token=abc", "localhost", "1420", true);
    expect(ctx.readOnly).toBe(false);
    expect(ctx.token).toBeNull();
    expect(ctx.runId).toBeNull();
  });

  it("is not read-only without a token", () => {
    expect(viewerContextFrom("", "localhost", "1420", false).readOnly).toBe(false);
    expect(viewerContextFrom("?other=1", "localhost", "", false).readOnly).toBe(false);
  });

  it("omits the port from the host label when there isn't one", () => {
    expect(viewerContextFrom("?token=t", "zoc.local", "", false).host).toBe("zoc.local");
  });
});

describe("viewersLabel", () => {
  it("pluralises and handles the empty case", () => {
    expect(viewersLabel(0)).toBe("No viewers yet");
    expect(viewersLabel(-1)).toBe("No viewers yet");
    expect(viewersLabel(1)).toBe("1 person watching");
    expect(viewersLabel(4)).toBe("4 people watching");
  });
});

describe("shareUrl", () => {
  it("builds a tokened, run-bound LAN URL", () => {
    expect(shareUrl("10.0.0.5", 5000, "abc123", "run-42")).toBe(
      `http://10.0.0.5:5000/?${SHARE_TOKEN_PARAM}=abc123&runId=run-42`,
    );
  });

  it("encodes the token", () => {
    const url = new URL(shareUrl("10.0.0.5", 1, "a b"));
    expect(url.searchParams.get(SHARE_TOKEN_PARAM)).toBe("a b");
  });
});

describe("viewer event transport", () => {
  it("adds the credential to live and replay requests", () => {
    const context = viewerContextFrom(
      "?token=a%20b&runId=run-42",
      "10.0.0.5",
      "5000",
      false,
    );
    expect(viewerEventsPath(context)).toBe("/v1/agent/events?token=a%20b");
    expect(viewerReplayPath(context)).toBe(
      "/v1/agent/runs/run-42/events/replay?token=a%20b",
    );
  });
});
