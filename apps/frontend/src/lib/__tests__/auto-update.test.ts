import { beforeEach, describe, expect, it } from "vitest";
import {
  DISMISS_WINDOW_MS,
  RELEASES_URL,
  __resetUpdateStateForTests,
  checkForUpdate,
  dismissUpdate,
  installUpdate,
  isDismissed,
  releaseNotesApiUrl,
} from "../auto-update";

/** In-memory Storage stand-in. */
function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    clear: () => map.clear(),
  };
}

const NOW = 1_800_000_000_000;

beforeEach(() => {
  __resetUpdateStateForTests();
});

describe("isDismissed / dismissUpdate", () => {
  it("is not dismissed before anything is recorded", () => {
    expect(isDismissed("0.0.3", NOW, memoryStorage())).toBe(false);
  });

  it("suppresses the same version inside the 24h window", () => {
    const storage = memoryStorage();
    dismissUpdate("0.0.3", NOW, storage);
    expect(isDismissed("0.0.3", NOW + 1000, storage)).toBe(true);
    expect(isDismissed("0.0.3", NOW + DISMISS_WINDOW_MS - 1, storage)).toBe(true);
  });

  it("expires exactly at the window boundary", () => {
    const storage = memoryStorage();
    dismissUpdate("0.0.3", NOW, storage);
    expect(isDismissed("0.0.3", NOW + DISMISS_WINDOW_MS, storage)).toBe(false);
  });

  it("does not suppress a different (newer) version", () => {
    const storage = memoryStorage();
    dismissUpdate("0.0.3", NOW, storage);
    expect(isDismissed("0.0.4", NOW + 1000, storage)).toBe(false);
  });

  it("ignores corrupt storage instead of throwing", () => {
    const storage = memoryStorage();
    storage.setItem("zoc:update-dismissed", "not json");
    expect(isDismissed("0.0.3", NOW, storage)).toBe(false);
  });

  it("tolerates a storage that refuses writes", () => {
    const readOnly = {
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => dismissUpdate("0.0.3", NOW, readOnly)).not.toThrow();
  });
});

describe("releaseNotesApiUrl", () => {
  it("prefixes a bare version with v and leaves tags alone", () => {
    expect(releaseNotesApiUrl("0.0.2")).toMatch(/\/tags\/v0\.0\.2$/);
    expect(releaseNotesApiUrl("v0.0.2")).toMatch(/\/tags\/v0\.0\.2$/);
  });

  it("points at the same repo as the releases page", () => {
    const repo = RELEASES_URL.replace("https://github.com/", "").replace("/releases", "");
    expect(releaseNotesApiUrl("1.0.0")).toContain(repo);
  });
});

describe("checkForUpdate", () => {
  it("resolves to null when the updater plugin is unavailable", async () => {
    // No Tauri runtime in vitest, so the dynamic import fails — which must be
    // indistinguishable from "no update available".
    await expect(checkForUpdate()).resolves.toBeNull();
  });
});

describe("installUpdate", () => {
  it("rejects when no update is pending", async () => {
    await expect(installUpdate()).rejects.toThrow(/no update is pending/i);
  });
});
