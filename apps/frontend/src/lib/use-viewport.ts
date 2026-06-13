import { useEffect, useState } from "react";

/**
 * Viewport breakpoints used to drive the adaptive Shell layout. These are
 * resolution-agnostic: panels are sized as percentages of the window, and on
 * small windows (e.g. half-screen on a laptop, or a low-resolution display)
 * the secondary panels collapse automatically so the editor stays usable.
 */
export interface Viewport {
  width: number;
  height: number;
  /** Hide the side (explorer) panel — very narrow windows. */
  hideSide: boolean;
  /** Hide the right (agent) panel — narrow windows. */
  hideRight: boolean;
  /** Compact density (smaller paddings) on short/narrow windows. */
  compact: boolean;
}

const SIDE_BP = 720;
const RIGHT_BP = 1024;
const COMPACT_BP = 880;

function read(): Viewport {
  const width = typeof window === "undefined" ? 1440 : window.innerWidth;
  const height = typeof window === "undefined" ? 900 : window.innerHeight;
  return {
    width,
    height,
    hideSide: width < SIDE_BP,
    hideRight: width < RIGHT_BP,
    compact: width < COMPACT_BP || height < 600,
  };
}

/** Live viewport descriptor; re-renders on resize (debounced via rAF). */
export function useViewport(): Viewport {
  const [vp, setVp] = useState<Viewport>(read);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let frame = 0;
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setVp(read()));
    };
    window.addEventListener("resize", onResize);
    onResize();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return vp;
}
