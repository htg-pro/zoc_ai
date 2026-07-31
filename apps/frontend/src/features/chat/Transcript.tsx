/**
 * The transcript — zoc-agent-chat-rebuild R8.1, R20.3, R20.4, R20.7, R20.8, R21.2, task 17.1.
 *
 * Two stacked regions in one **native** scroll container: a virtualised region for every settled
 * row, and an always-mounted tail for the in-flight Run. The split, the per-kind estimates, and the
 * row cache live in `transcript-regions.ts`; the row `switch` lives in `transcript-model.ts` and
 * `TranscriptRowView.tsx`. What is left here is the four mechanisms that make a growing transcript
 * hold still, in the order they matter.
 *
 * **1. The streaming tail is outside the virtualiser.** See `transcript-regions.ts` — the
 * virtualiser is never handed an item whose height is still changing.
 *
 * **2. Deltas commit at most once per frame.** `useFrameCoalesced` holds the newest `messages` and
 * flushes on `requestAnimationFrame`, so 40 parts per second (R20.3) is at most 60 commits per
 * second on a 60 Hz display, and every part still arrives — the flush reads a ref rather than a
 * captured value.
 *
 * **3. Anchoring is a layout effect over a measured distance.** The scroll write lands in the same
 * frame as the DOM growth; a passive effect produces one frame of visible drift per delta (R20.7).
 * The distance is computed in the store's `observeScroll`, so the 32 px entry rule is stated once.
 *
 * **4. Keys are row ids and measurement is cached by key.** An expand re-measures one row rather
 * than invalidating every row below it, and a settled row is measured once for the lifetime of the
 * Session.
 *
 * ## Why a plain `div` and not `ScrollArea`
 *
 * `@radix-ui/react-scroll-area` virtualises nothing and its viewport wrapper sits between the
 * element that scrolls and the element the virtualiser measures, which breaks the
 * `getScrollElement` contract. The app's `::-webkit-scrollbar` styling in `globals.css` already
 * gives a native container the right appearance.
 *
 * ## The one prop that exists for a test
 *
 * `onRowMeasured` is the seam the measurement guard counts, and it is a prop rather than a spy
 * because the alternative is asserting against `getBoundingClientRect` call counts — which Radix,
 * Motion, and jsdom itself also call, so the number would drift for reasons unrelated to
 * measurement thrash. It is documented as instrumentation and nothing in the app passes it.
 */
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type UIEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { cn } from "@/lib/utils";
import { JumpToLatest } from "./JumpToLatest";
import { ReviewSurfaceContext, type ReviewSurface } from "./review/review-surface";
import { TranscriptRowView } from "./TranscriptRowView";
import { sameItems, useFrameCoalesced, useStableCallback } from "./commit-discipline";
import { markFirstPaint } from "./first-part-latency";
import { useChatSurface } from "./store";
import {
  estimatedRowHeight,
  transcriptRegions,
  type RowCache,
  type TranscriptRegions,
} from "./transcript-regions";
import type { RowFactoryOptions, TranscriptRow } from "./transcript-model";
import type { ZocUIMessage } from "./wire/ui-message";
import type { ToolKind } from "@zoc-studio/shared-types";

/** Rows kept mounted above and below the visible range (R20.4's overscan window). */
const OVERSCAN = 8;

/** The identity a transcript with no review surface provides, so the context value never changes. */
const EMPTY_REVIEW_SURFACE: ReviewSurface = {};

/**
 * A row that re-renders only when its own props change.
 *
 * This is the other half of R8.1, and the memo is only as good as the identity of what it compares:
 * the row objects come from a per-message cache, and every handler passes through
 * `useStableCallback` first. Property 6 asserts the pair — a text delta on the tail must not call a
 * settled row's render function.
 */
const MemoisedRow = memo(TranscriptRowView);

export interface TranscriptProps {
  /** `useChat`'s message list, unmodified. This component is its only reader. */
  messages: readonly ZocUIMessage[];
  /** True while a Run is in flight — `status` is `submitted` or `streaming`. */
  streaming: boolean;
  /** R23.2's migrated legacy events, already ordered and collapsed (24.2). */
  historicalRows?: readonly TranscriptRow[];
  /** The authoritative tool kind, from 22.1's `/v1/tools` catalogue. */
  toolKindOf?: (toolName: string) => ToolKind | undefined;
  onToolRetry?: (toolCallId: string) => void;
  onErrorRetry?: () => void;
  /** R16.5: carry on from an interrupted Run's partial transcript. Offered on that row only. */
  onErrorContinue?: () => void;
  resolveFoldedTurn?: (messageId: string) => string | undefined;
  /**
   * The plan-review surface: digests, receipts, and the apply/discard/regenerate/rollback handlers
   * (18.2). Provided through context rather than row props so a receipt arriving re-renders the plan
   * rows and nothing else — see `review/review-surface.ts`.
   */
  review?: ReviewSurface;
  /** Instrumentation for the measurement guard. Not used by the app. */
  onRowMeasured?: (rowId: string, height: number) => void;
  className?: string;
}

export function Transcript({
  messages,
  streaming,
  historicalRows,
  toolKindOf,
  onToolRetry,
  onErrorRetry,
  onErrorContinue,
  resolveFoldedTurn,
  review,
  onRowMeasured,
  className,
}: TranscriptProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const anchored = useChatSurface((state) => state.anchored);
  const observeScroll = useChatSurface((state) => state.observeScroll);
  const noteRowAppended = useChatSurface((state) => state.noteRowAppended);

  // Every handler is given a permanent identity before it reaches a row, so a memoised settled row
  // cannot be re-rendered by a caller that defines its handlers inline (R8.1, Property 6).
  const stableToolRetry = useStableCallback(onToolRetry);
  const stableErrorRetry = useStableCallback(onErrorRetry);
  const stableErrorContinue = useStableCallback(onErrorContinue);
  const stableResolveFoldedTurn = useStableCallback(resolveFoldedTurn);
  const stableToolKindOf = useStableCallback(toolKindOf);
  const stableRowMeasured = useStableCallback(onRowMeasured);

  // The factory and the cache are built together because the cache's lifetime *is* the factory's:
  // a tool-kind resolver that arrives after the catalogue loads changes what a cached row says, so
  // the old rows are wrong rather than stale, and a `WeakMap` has no iteration to invalidate them
  // through. Deriving them in one memo also keeps the invalidation visible — a second memo keyed on
  // `factory` reads as an unused dependency, which is exactly what a reviewer would delete.
  const { factory, cache } = useMemo<{ factory: RowFactoryOptions; cache: RowCache }>(
    () => ({
      factory: stableToolKindOf === undefined ? {} : { toolKindOf: stableToolKindOf },
      cache: new WeakMap(),
    }),
    [stableToolKindOf],
  );

  // Coalesced at the source. Deriving first and coalescing the derived object would schedule a
  // frame on every render — the derived object is new every time — and the commit would schedule
  // the next one, at the frame rate, forever.
  const committedMessages = useFrameCoalesced(messages, sameItems);

  const regions: TranscriptRegions = useMemo(
    () =>
      transcriptRegions(committedMessages, {
        inFlight: streaming,
        cache,
        factory,
        ...(historicalRows === undefined ? {} : { historicalRows }),
      }),
    [committedMessages, streaming, cache, factory, historicalRows],
  );

  const settled = regions.settled;

  const virtualizer = useVirtualizer({
    count: settled.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => estimatedRowHeight(settled[index]),
    // Stable ids, never the index: this is what makes an expand re-measure one row instead of
    // invalidating the measurement cache of every row below it.
    getItemKey: (index) => settled[index]?.id ?? index,
    overscan: OVERSCAN,
    measureElement: (element) => {
      const height = element.getBoundingClientRect().height;
      if (stableRowMeasured !== undefined) {
        stableRowMeasured(element.getAttribute("data-zoc-row-id") ?? "", height);
      }
      return height;
    },
  });

  // Included in the anchoring effect's dependencies: measurement runs after the commit that mounted
  // a row, so a row taller than its estimate grows the content *after* the scroll write. Without
  // this the view sits a few rows short of the bottom whenever an estimate was low.
  const totalSize = virtualizer.getTotalSize();

  // R20.1's clock stops here, in a layout effect, on the first commit that has something to show: the
  // budget is about when content *appeared*, and a passive effect would report one frame late.
  // `markFirstPaint` is idempotent, so calling it on every commit of the tail costs nothing.
  useLayoutEffect(() => {
    const painted = regions.streaming.some(
      (row) => (row.kind === "answer" || row.kind === "reasoning") && row.text.length > 0,
    );
    if (painted) markFirstPaint();
  }, [regions]);

  useLayoutEffect(() => {
    if (!anchored) return;
    const element = scrollRef.current;
    if (element === null) return;
    // The browser clamps to `scrollHeight - clientHeight`; asking for the full height is how the
    // bottom is named without measuring the viewport first.
    element.scrollTop = element.scrollHeight;
  }, [anchored, regions, totalSize]);

  // R20.8's count. Incremented per row rather than per commit, because the control reports rows and
  // one commit can carry several; the store ignores the call while the view is anchored.
  const rowCount = settled.length + regions.streaming.length;
  const previousRowCount = useRef(rowCount);
  useEffect(() => {
    const added = rowCount - previousRowCount.current;
    previousRowCount.current = rowCount;
    for (let index = 0; index < added; index += 1) noteRowAppended();
  }, [rowCount, noteRowAppended]);

  const handleScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const element = event.currentTarget;
      observeScroll({
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
        clientHeight: element.clientHeight,
      });
    },
    [observeScroll],
  );

  const rowProps = {
    ...(stableToolRetry === undefined ? {} : { onToolRetry: stableToolRetry }),
    ...(stableErrorRetry === undefined ? {} : { onErrorRetry: stableErrorRetry }),
    ...(stableErrorContinue === undefined ? {} : { onErrorContinue: stableErrorContinue }),
    ...(stableResolveFoldedTurn === undefined
      ? {}
      : { resolveFoldedTurn: stableResolveFoldedTurn }),
  };

  // The empty object is a stable identity, so a transcript with no review surface never re-renders a
  // plan row through the context.
  const reviewSurface = review ?? EMPTY_REVIEW_SURFACE;

  return (
    <ReviewSurfaceContext.Provider value={reviewSurface}>
      <div className={cn("relative flex min-h-0 flex-1 flex-col", className)}>
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          data-zoc-transcript-scroll=""
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-3"
        >
          {/* The settled region. Absolutely positioned rows inside a spacer of the total size. */}
          <div
            data-zoc-transcript-settled=""
            style={{ height: totalSize, position: "relative", width: "100%" }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const row = settled[item.index];
              if (row === undefined) return null;
              return (
                <div
                  key={item.key}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  data-zoc-row-id={row.id}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${String(item.start)}px)`,
                  }}
                >
                  <MemoisedRow row={row} {...rowProps} />
                </div>
              );
            })}
          </div>

          {/*
          The streaming tail. `aria-atomic="false"` so a screen reader announces the appended text
          rather than re-reading the whole region on every delta (R21.2).
        */}
          <div
            data-zoc-transcript-streaming=""
            aria-live="polite"
            aria-atomic="false"
            className="flex flex-col gap-3"
          >
            {regions.streaming.map((row) => (
              <div key={row.id} data-zoc-row-id={row.id}>
                <MemoisedRow row={row} {...rowProps} />
              </div>
            ))}
          </div>
        </div>

        <JumpToLatest />
      </div>
    </ReviewSurfaceContext.Provider>
  );
}
