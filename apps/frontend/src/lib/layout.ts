/**
 * Panel layout pure helpers (R12.1-R12.4, R12.7, R12.8).
 *
 * Pixel bounds per the design: File_Explorer and Agent_Panel widths in
 * [180, 600]; Bottom_Dock height in [120, 80% of the window height]. Toggling a
 * panel's visibility is an involution; persistence round-trips sizes and
 * visibility through a serialized blob.
 */

export const PANEL_MIN_WIDTH = 180;
export const PANEL_MAX_WIDTH = 600;
export const DOCK_MIN_HEIGHT = 120;
export const DOCK_MAX_HEIGHT_RATIO = 0.8;

export type PanelKey = "explorer" | "dock" | "agent";

export interface LayoutState {
  explorerWidth: number;
  agentWidth: number;
  dockHeight: number;
  explorerOpen: boolean;
  dockOpen: boolean;
  agentOpen: boolean;
}

export const DEFAULT_LAYOUT: LayoutState = {
  explorerWidth: 260,
  agentWidth: 360,
  dockHeight: 220,
  explorerOpen: true,
  dockOpen: true,
  agentOpen: true,
};

const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, n));

/** Clamp a side-panel width into [180, 600] (R12.7). */
export function clampPanelWidth(px: number): number {
  return clamp(px, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH);
}

/** Clamp the dock height into [120, 80% of window height] (R12.7). */
export function clampDockHeight(px: number, windowHeight: number): number {
  const upper = Math.max(
    DOCK_MIN_HEIGHT,
    Math.floor(windowHeight * DOCK_MAX_HEIGHT_RATIO),
  );
  return clamp(px, DOCK_MIN_HEIGHT, upper);
}

/** Invert one panel's visibility (R12.1-R12.3). */
export function togglePanel(state: LayoutState, panel: PanelKey): LayoutState {
  switch (panel) {
    case "explorer":
      return { ...state, explorerOpen: !state.explorerOpen };
    case "dock":
      return { ...state, dockOpen: !state.dockOpen };
    case "agent":
      return { ...state, agentOpen: !state.agentOpen };
  }
}

/** Clamp all sizes in a layout into their bounds. */
export function sanitizeLayout(
  state: LayoutState,
  windowHeight: number,
): LayoutState {
  return {
    ...state,
    explorerWidth: clampPanelWidth(state.explorerWidth),
    agentWidth: clampPanelWidth(state.agentWidth),
    dockHeight: clampDockHeight(state.dockHeight, windowHeight),
    explorerOpen: Boolean(state.explorerOpen),
    dockOpen: Boolean(state.dockOpen),
    agentOpen: Boolean(state.agentOpen),
  };
}

export function serializeLayout(state: LayoutState): string {
  return JSON.stringify(state);
}

/** Load a persisted layout, falling back to defaults for missing/invalid data. */
export function deserializeLayout(
  raw: string | null,
  windowHeight: number,
): LayoutState {
  if (!raw) return { ...DEFAULT_LAYOUT };
  try {
    const parsed = JSON.parse(raw) as Partial<LayoutState>;
    return sanitizeLayout({ ...DEFAULT_LAYOUT, ...parsed }, windowHeight);
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}
