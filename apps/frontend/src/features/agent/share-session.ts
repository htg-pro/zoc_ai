/**
 * Read-only LAN session sharing — client helpers (§10.1).
 *
 * Two roles share this module:
 *
 * - The **host** starts/stops the share and displays the URL, QR code and
 *   viewer count.
 * - A **viewer** loads the same bundle from the host's LAN address with
 *   `?token=…` in the URL. It must not offer write actions, so the read-only
 *   determination lives here as a pure function of `location`, testable without
 *   a browser.
 */

/** Query parameter carrying the share token. */
export const SHARE_TOKEN_PARAM = "token";

export interface ViewerContext {
  /** True when this window is watching someone else's session. */
  readOnly: boolean;
  /** The share token this window presented, if any. */
  token: string | null;
  /** Gateway run this share is bound to. */
  runId: string | null;
  /** Host label to show in the banner ("192.168.1.14:52311"). */
  host: string | null;
}

/**
 * Decide whether the current window is a shared-session viewer.
 *
 * A viewer is any window that (a) carries a share token in its URL and (b) is
 * *not* the desktop shell. The Tauri check matters: the host's own window may
 * legitimately have odd query strings, but it always runs inside Tauri, and it
 * must never downgrade itself to read-only.
 */
export function viewerContextFrom(
  search: string,
  hostname: string,
  port: string,
  isDesktop: boolean,
): ViewerContext {
  const params = new URLSearchParams(search);
  const token = params.get(SHARE_TOKEN_PARAM);
  const runId = params.get("runId");
  if (!token || isDesktop) {
    return { readOnly: false, token: null, runId: null, host: null };
  }
  return {
    readOnly: true,
    token,
    runId,
    host: port ? `${hostname}:${port}` : hostname,
  };
}

/** Current window's viewer identity, shared by transport and UI gates. */
export function currentViewerContext(): ViewerContext {
  if (typeof window === "undefined") {
    return { readOnly: false, token: null, runId: null, host: null };
  }
  return viewerContextFrom(
    window.location.search,
    window.location.hostname,
    window.location.port,
    "__TAURI_INTERNALS__" in (window as object),
  );
}

/** Attach the share credential without discarding an endpoint's query. */
export function withShareToken(path: string, token: string): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}${SHARE_TOKEN_PARAM}=${encodeURIComponent(token)}`;
}

export function viewerEventsPath(context: ViewerContext): string | null {
  return context.token ? withShareToken("/v1/agent/events", context.token) : null;
}

export function viewerReplayPath(context: ViewerContext): string | null {
  if (!context.token || !context.runId) return null;
  return withShareToken(
    `/v1/agent/runs/${encodeURIComponent(context.runId)}/events/replay`,
    context.token,
  );
}

/** Human label for the viewer count pill. */
export function viewersLabel(count: number): string {
  if (count <= 0) return "No viewers yet";
  return `${count} ${count === 1 ? "person" : "people"} watching`;
}

/**
 * The URL to show/copy for a share.
 *
 * The token is part of the URL because a viewer has no other way to present it,
 * which is also why a share URL should be treated as a secret — anyone holding
 * it can watch until the host stops sharing.
 */
export function shareUrl(
  lanIp: string,
  port: number,
  token: string,
  runId?: string | null,
): string {
  const params = new URLSearchParams({ [SHARE_TOKEN_PARAM]: token });
  if (runId) params.set("runId", runId);
  return `http://${lanIp}:${port}/?${params.toString()}`;
}

/**
 * Render `text` as a QR code data URL.
 *
 * `qrcode` is imported lazily so the ~40 kB encoder is not in the main bundle
 * for the overwhelmingly common case of never opening the share dialog.
 * Returns `null` on failure — a missing QR must not break the dialog, since the
 * URL is displayed as copyable text anyway.
 */
export async function qrDataUrl(text: string): Promise<string | null> {
  try {
    const { toDataURL } = await import("qrcode");
    return await toDataURL(text, {
      width: 220,
      margin: 1,
      color: { dark: "#0C0C10", light: "#FAFAFA" },
    });
  } catch {
    return null;
  }
}
