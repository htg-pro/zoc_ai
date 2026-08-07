/**
 * Commit discipline for a streaming transcript — zoc-agent-chat-rebuild R8.1, R19.4, R20.3,
 * task 17.1.
 *
 * Feature: zoc-agent-chat-rebuild, task 17.1 (R8.1, R19.4, R20.3).
 *
 * Two hooks, and both exist for the same reason: a Run delivering 40 parts per second (R20.3)
 * must not produce 40 React commits per second, and the commits it does produce must not touch
 * a row that already settled (R8.1).
 *
 * ## Why coalescing lives here rather than in the transport
 *
 * The transport's job is ordering and delivery (11.1); by the time a chunk reaches `useChat` the
 * SDK has already applied it to `messages`, and the number of times *React* commits that state is
 * a renderer concern. Putting the throttle in the transport would also throttle the sequence
 * bookkeeping R16.4 depends on, which has to see every chunk.
 *
 * ## Why the equality function is not optional in practice
 *
 * {@link useFrameCoalesced} holds a value and re-commits it on the next animation frame. If the
 * caller passes a value it recomputes on every render — a derived object, a mapped array — then
 * `Object.is` reports a change the caller did not make, the hook schedules a frame, the commit
 * re-renders the caller, and the cycle repeats at the frame rate forever. So callers coalesce the
 * *source* (the `messages` array `useChat` owns) and derive afterwards, and pass the comparison
 * that matches how their source changes. {@link sameItems} is that comparison for an array whose
 * elements are replaced rather than mutated, which is how the AI SDK updates a message list.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Element-wise identity, for an array whose members are replaced rather than mutated.
 *
 * The AI SDK builds a new `messages` array on every chunk and carries unchanged messages over by
 * reference, so element identity is exactly the "did anything I render change" question — and
 * comparing the array references alone would answer "yes" to every chunk of every Run.
 */
export function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((item, index) => item === b[index]);
}

/**
 * The latest `value`, committed at most once per animation frame.
 *
 * The pending value is held in a ref and the flush is a `requestAnimationFrame` callback, so a
 * burst of deltas between two frames produces one commit carrying the last of them. Nothing is
 * dropped: the flush reads the ref rather than the value captured when it was scheduled.
 *
 * **The first value commits synchronously.** A transcript that rendered empty for one frame on
 * mount would flash, and a test that asserted against the first paint would have to know about
 * the frame. Only *changes* are coalesced.
 *
 * The effect has no dependency array on purpose. The question it asks — "is the committed value
 * behind the latest one" — has to be asked after every render, including the renders where the
 * caller's props did not change but the value it derived did.
 */
export function useFrameCoalesced<T>(value: T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const [committed, setCommitted] = useState<T>(value);
  const latest = useRef<T>(value);
  const frame = useRef<number | null>(null);
  latest.current = value;

  useEffect(() => {
    if (isEqual(value, committed)) return;
    // A frame is already owed, and it will read the ref rather than this render's value.
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      setCommitted(latest.current);
    });
  });

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    },
    [],
  );

  return committed;
}

/**
 * A callback with a permanent identity that always calls the newest `fn`.
 *
 * Row slots are memoised so a text delta cannot re-render a settled row (R8.1, Property 6), and a
 * memo is only as good as the identity of the props it compares. A handler defined inline in the
 * panel — `onToolRetry={(id) => retry(id)}` — is a new function on every render, which would make
 * every settled row's props unequal on every delta and defeat the memo entirely. Wrapping it here
 * moves that mistake out of the caller's reach.
 *
 * `undefined` is preserved rather than wrapped: a row decides whether to draw a control by whether
 * it received a handler, so returning a stable no-op would draw a control that does nothing.
 */
export function useStableCallback<A extends readonly unknown[], R>(
  fn: ((...args: A) => R) | undefined,
): ((...args: A) => R) | undefined {
  const latest = useRef(fn);
  latest.current = fn;

  const stable = useCallback((...args: A): R => {
    const current = latest.current;
    if (current === undefined) {
      // Unreachable while `fn` is defined, and it stays a throw rather than a silent return so a
      // handler that disappears mid-Run is a visible failure rather than a dead control.
      throw new Error("useStableCallback: the wrapped handler was removed while it was in use.");
    }
    return current(...args);
  }, []);

  return fn === undefined ? undefined : stable;
}
