/**
 * Whether this window is watching someone else's session — zoc-agent-chat-rebuild R1.3, R1.4,
 * task 25.3.
 *
 * Homed in `lib` because it is genuinely cross-feature: `App.tsx` gates the shell on it and the
 * Chat_Surface gates every write action on it, so leaving it inside `features/agent` — which 26.1
 * deletes — would make the read-only determination disappear along with the legacy panel.
 *
 * The determination is a pure function of `location` plus one Tauri probe, which is what makes it
 * testable without a browser. That mattered enough to keep: the failure it prevents is a viewer
 * window offering write actions it cannot perform, and the Tauri check is the half that is easy to
 * get wrong — the host's own window may legitimately carry odd query strings, but it always runs
 * inside Tauri, and it must never downgrade *itself* to read-only.
 *
 * The rest of `features/agent/share-session.ts` — the URL builders, the QR helper, the viewer-count
 * label — stays there and dies with it. Only the read-only gate is cross-feature.
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
 * A viewer is any window that (a) carries a share token in its URL and (b) is *not* the desktop
 * shell.
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
