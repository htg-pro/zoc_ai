/**
 * Sessions view pure selectors and mutations (R2.2-R2.8, R2.11, R2.12).
 *
 * Everything here is a pure function of its inputs so it can be exercised with
 * generated session lists independently of the DOM. Recency grouping is
 * computed against an injected `now` (ms epoch) so it is deterministic.
 */
import type { Session } from "@llama-studio/shared-types";

export type SessionFilter = "all" | "active" | "pinned" | "archived";
export type SortOption = "recent" | "oldest" | "title" | "model";

export interface SessionGroups {
  pinned: Session[];
  today: Session[];
  yesterday: Session[];
  earlier: Session[];
}

export interface TabCounts {
  all: number;
  active: number;
  pinned: number;
  archived: number;
}

export interface SessionStats {
  activeSessions: number;
  runsThisWeek: number;
  modelsUsed: number;
  tokensUsed: number;
}

const MS_PER_DAY = 86_400_000;
const WEEK_MS = 7 * MS_PER_DAY;

/** UTC day index for an ISO timestamp (days since epoch). */
function dayIndex(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : Math.floor(t / MS_PER_DAY);
}

function isPinned(pinned: ReadonlySet<string>, id: string): boolean {
  return pinned.has(id);
}

/**
 * Group sessions into the four ordered buckets. Every bucket is always present
 * (even when empty). A pinned session appears only in `pinned`; every other
 * session appears in exactly one recency bucket (R2.2, R2.3).
 */
export function groupSessions(
  sessions: Session[],
  pinned: ReadonlySet<string>,
  now: number,
): SessionGroups {
  const nowDay = Math.floor(now / MS_PER_DAY);
  const groups: SessionGroups = {
    pinned: [],
    today: [],
    yesterday: [],
    earlier: [],
  };
  for (const s of sessions) {
    if (isPinned(pinned, s.id)) {
      groups.pinned.push(s);
      continue;
    }
    const day = dayIndex(s.updated_at);
    if (day === nowDay) groups.today.push(s);
    else if (day === nowDay - 1) groups.yesterday.push(s);
    else groups.earlier.push(s);
  }
  return groups;
}

/** Case-insensitive substring match on title or model metadata (R2.7). */
export function matchesSearch(session: Session, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  const title = session.title.toLowerCase();
  const model = (session.model ?? "").toLowerCase();
  return title.includes(q) || model.includes(q);
}

/** Whether a session matches the active filter tab (R2.6). */
export function matchesFilter(
  session: Session,
  filter: SessionFilter,
  pinned: ReadonlySet<string>,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "active":
      return session.status === "active";
    case "pinned":
      return isPinned(pinned, session.id);
    case "archived":
      return session.status === "closed";
  }
}

/** Non-negative integer count of sessions matching each tab (R2.5). */
export function tabCounts(
  sessions: Session[],
  pinned: ReadonlySet<string>,
): TabCounts {
  return {
    all: sessions.length,
    active: sessions.filter((s) => matchesFilter(s, "active", pinned)).length,
    pinned: sessions.filter((s) => matchesFilter(s, "pinned", pinned)).length,
    archived: sessions.filter((s) => matchesFilter(s, "archived", pinned))
      .length,
  };
}

/** Statistic-card values (R2.4); all non-negative integers, 0 when empty. */
export function sessionStats(
  sessions: Session[],
  now: number,
  tokensOf: (s: Session) => number = () => 0,
): SessionStats {
  const models = new Set<string>();
  let runsThisWeek = 0;
  let tokensUsed = 0;
  let activeSessions = 0;
  for (const s of sessions) {
    if (s.status === "active") activeSessions += 1;
    if (s.model) models.add(s.model);
    const t = Date.parse(s.updated_at);
    if (!Number.isNaN(t) && now - t <= WEEK_MS && now - t >= 0) runsThisWeek += 1;
    tokensUsed += Math.max(0, Math.floor(tokensOf(s)));
  }
  return {
    activeSessions,
    runsThisWeek,
    modelsUsed: models.size,
    tokensUsed,
  };
}

/**
 * Deterministic, stable, idempotent sort that is a permutation of its input
 * (R2.8). Ties break by id so the order is a total order for distinct ids.
 */
export function sortSessions(list: Session[], option: SortOption): Session[] {
  const copy = list.slice();
  copy.sort((a, b) => {
    let primary = 0;
    switch (option) {
      case "recent":
        primary = Date.parse(b.updated_at) - Date.parse(a.updated_at);
        break;
      case "oldest":
        primary = Date.parse(a.updated_at) - Date.parse(b.updated_at);
        break;
      case "title":
        primary = a.title.localeCompare(b.title);
        break;
      case "model":
        primary = (a.model ?? "").localeCompare(b.model ?? "");
        break;
    }
    if (primary !== 0) return primary;
    return a.id.localeCompare(b.id);
  });
  return copy;
}

/** Apply filter + search, then sort — the displayed Session_Card set (R2.6-R2.8). */
export function filterSortSearch(
  sessions: Session[],
  pinned: ReadonlySet<string>,
  filter: SessionFilter,
  query: string,
  sort: SortOption,
): Session[] {
  const filtered = sessions.filter(
    (s) => matchesFilter(s, filter, pinned) && matchesSearch(s, query),
  );
  return sortSessions(filtered, sort);
}

// ── Pin persistence (R2.11) ──────────────────────────────────────────

export function togglePinned(
  pinned: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(pinned);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function serializePinned(pinned: ReadonlySet<string>): string {
  return JSON.stringify([...pinned].sort());
}

export function deserializePinned(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((x) => typeof x === "string")) : new Set();
  } catch {
    return new Set();
  }
}

// ── Deletion (R2.12) ─────────────────────────────────────────────────

/** Remove exactly the target session, leaving all others unchanged. */
export function deleteSession(sessions: Session[], id: string): Session[] {
  return sessions.filter((s) => s.id !== id);
}
