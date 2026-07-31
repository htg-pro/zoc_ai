/**
 * The Session list's model — zoc-agent-chat-rebuild R15.2, R15.5, R15.8, R15.9, R15.10, R15.11, R35.2,
 * R35.5, task 22.5.
 *
 * Scoping, search, the archive partition, and the two copy operations, as pure functions over
 * `Session[]`. Four properties assert against this module, and none of them mounts a list — which is the
 * point: what R15.8 and R15.9 actually constrain is that a *copy* leaves its source alone, and that is a
 * claim about data rather than about a rendered row.
 *
 * ## Why the rows are metadata and why that is not an R2.4 violation
 *
 * R2.4 forbids per-part and per-stream data in the app store, and the Session_Store lives there (R35.1).
 * A row is a Session's *metadata* — id, title, timestamps, message count, status, workspace root — and the
 * transcript continues to live only in `useChat`. {@link SessionRowModel} is that distinction made
 * concrete: it has no `messages` field at all, so a row cannot carry a transcript even by accident.
 *
 * The search functions do read message text, and they read it from the Session objects the store already
 * holds for the *sessions surface* rather than from a second copy. 25.5 strips `lib/store.ts` down and a
 * reader applying R2.4 there without this distinction would delete the rows; the note is repeated in the
 * task for that reason.
 *
 * ## Why "session" everywhere
 *
 * R35.5: every user-visible label naming a stored conversation reads "session", never "thread". Enforced
 * by vocabulary here — the exported names are the ones the components use, so a label cannot drift without
 * this module drifting first.
 */

import type { Message, Session, SessionStatus } from "@zoc-studio/shared-types";

import { rootBasename } from "@/features/agent/session-origin";

/**
 * A Session as a row shows it. **No transcript** — see the header.
 *
 * `lastActivity` is the ISO timestamp rather than a formatted string, because the format depends on how
 * long ago it was and that is the row's business.
 */
export interface SessionRowModel {
  readonly id: string;
  readonly title: string;
  readonly lastActivity: string;
  readonly messageCount: number;
  /** Trailing segment of the Session's workspace root. Never empty. */
  readonly rootBasename: string;
  readonly status: SessionStatus;
  readonly pinned: boolean;
}

/** Which Sessions a list shows (R15.11). */
export type SessionFilter = "open" | "archived";

/** The status archiving sets. The third member of the existing enum, not a new one (R15.11). */
export const ARCHIVED_STATUS: SessionStatus = "closed";

/** Whether a Session is archived. One predicate, so the list and the filter cannot disagree. */
export function isArchived(session: Session): boolean {
  return session.status === ARCHIVED_STATUS;
}

/**
 * Canonicalise a workspace root for comparison.
 *
 * Trailing separators are dropped and the comparison is case-insensitive, because the same folder reaches
 * the surface spelled several ways: a root chosen through a file dialog, one restored from
 * `desktop.json`, and one echoed by a Session all differ in the trailing slash, and Windows and macOS
 * differ in case. A scoping bug that compared raw strings would hide a user's Sessions from them with no
 * error anywhere — which is why `sessionHistory`'s generator draws roots with exactly those variants.
 */
export function canonicalRoot(root: string): string {
  return root.replace(/[/\\]+$/, "").toLowerCase();
}

/** Sessions bound to `root` (R15.10). An unresolved root scopes to nothing rather than to everything. */
export function scopeToWorkspace(
  sessions: readonly Session[],
  root: string | null,
): readonly Session[] {
  if (root === null || root.trim().length === 0) return [];
  const target = canonicalRoot(root);
  return sessions.filter((session) => canonicalRoot(session.workspace_root ?? "") === target);
}

/** The two halves of the list, by status (R15.11). Every Session is in exactly one. */
export function partitionByStatus(sessions: readonly Session[]): {
  readonly open: readonly Session[];
  readonly archived: readonly Session[];
} {
  const open: Session[] = [];
  const archived: Session[] = [];
  for (const session of sessions) {
    if (isArchived(session)) archived.push(session);
    else open.push(session);
  }
  return { open, archived };
}

/**
 * The rows for one filter, newest first, pinned Sessions ahead of the rest.
 *
 * Sorting here rather than in the component so the list and its property agree on order, and so "newest
 * first" is one comparison rather than one per surface. Pinning is local state (`useApp`'s `pinnedSessions`)
 * and is passed in rather than read, because this module has no store.
 */
export function sessionRows(
  sessions: readonly Session[],
  options: {
    readonly workspaceRoot: string | null;
    readonly filter?: SessionFilter;
    readonly pinned?: Readonly<Record<string, true>>;
  },
): readonly SessionRowModel[] {
  const scoped = scopeToWorkspace(sessions, options.workspaceRoot);
  const partition = partitionByStatus(scoped);
  const chosen = (options.filter ?? "open") === "archived" ? partition.archived : partition.open;
  const pinned = options.pinned ?? {};

  return [...chosen]
    .map((session) => ({
      id: session.id,
      title: session.title,
      lastActivity: session.updated_at,
      messageCount: session.messages.length,
      rootBasename: rootBasename(session.workspace_root ?? ""),
      status: session.status,
      pinned: pinned[session.id] === true,
    }))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const byTime = Date.parse(b.lastActivity) - Date.parse(a.lastActivity);
      // Ties break on id so the order is total: two Sessions saved in the same second must not swap
      // places between renders.
      return Number.isNaN(byTime) || byTime === 0 ? a.id.localeCompare(b.id) : byTime;
    });
}

export interface SessionSearchHit {
  readonly session: Session;
  /** Where the query was found. The title is searched as well as the messages. */
  readonly matchedTitle: boolean;
  /** Ids of the messages whose text contains the query, in transcript order. */
  readonly matchedMessageIds: readonly string[];
}

/** Case-insensitive substring, which is the rule R15.5's "search over message text" implies. */
function contains(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle);
}

/**
 * Sessions whose title or message text contains `query` (R15.5).
 *
 * A substring rather than a fuzzy match, deliberately: a Session search is a *recall* tool — the user
 * remembers a phrase they wrote — and fuzzy matching over 500 transcripts returns results nobody can
 * explain while costing more. The mention picker fuzzy-matches because it is a *completion* tool, which is
 * the opposite problem.
 *
 * An empty query matches every Session rather than none, so clearing the box restores the list.
 */
export function searchSessions(
  sessions: readonly Session[],
  query: string,
): readonly SessionSearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return sessions.map((session) => ({
      session,
      matchedTitle: false,
      matchedMessageIds: [],
    }));
  }

  const hits: SessionSearchHit[] = [];
  for (const session of sessions) {
    const matchedTitle = contains(session.title, needle);
    const matchedMessageIds: string[] = [];
    for (const message of session.messages) {
      if (contains(message.content, needle)) matchedMessageIds.push(message.id);
    }
    if (matchedTitle || matchedMessageIds.length > 0) {
      hits.push({ session, matchedTitle, matchedMessageIds });
    }
  }
  return hits;
}

/** The longest title a generated one is allowed to be, so a row's one line stays one line. */
export const MAX_GENERATED_TITLE = 60;

/**
 * A title from the Session's first user message (R15.2).
 *
 * The first *user* message, not the first message: an assistant preamble would title the Session with the
 * agent's words rather than the user's intent. Newlines collapse, because a title is one line and a
 * pasted stack trace as a first message would otherwise make the row unreadable.
 */
export function titleFromFirstMessage(messages: readonly Message[]): string {
  const first = messages.find((message) => message.role === "user" && message.content.trim().length > 0);
  if (first === undefined) return "New session";
  const flattened = first.content.replace(/\s+/gu, " ").trim();
  return flattened.length <= MAX_GENERATED_TITLE
    ? flattened
    : `${flattened.slice(0, MAX_GENERATED_TITLE - 1).trimEnd()}…`;
}

export interface CopyOptions {
  /** The new Session's id. Supplied so the caller controls identity and the function stays pure. */
  readonly id: string;
  /** ISO timestamp for the copy's `created_at` and `updated_at`. */
  readonly now: string;
  readonly title?: string;
}

/**
 * A new Session carrying the source's messages up to and including `atMessageIndex` (R15.8).
 *
 * **The source is not touched**, and that is the half of R15.8 a happy-path test misses: the copy's
 * message array is a new array of the same message objects, and `plan` and `tool_calls` are copied by
 * value into new arrays. A shared array would make a later append to the fork appear in the source, which
 * is a data-loss bug the user would read as their history rewriting itself.
 *
 * An index past the end is a duplicate, which is the boundary {@link duplicateSession} is named for.
 */
export function forkSession(
  source: Session,
  atMessageIndex: number,
  options: CopyOptions,
): Session {
  const cut = Math.max(0, Math.min(atMessageIndex + 1, source.messages.length));
  const messages = source.messages.slice(0, cut).map((message) => ({ ...message }));
  return {
    ...source,
    id: options.id,
    title: options.title ?? titleFromFirstMessage(messages),
    status: "active",
    created_at: options.now,
    updated_at: options.now,
    messages,
    plan: source.plan === undefined ? undefined : source.plan,
    tool_calls: [...source.tool_calls],
  };
}

/** A new Session carrying the whole transcript (R15.9). A fork at the last message. */
export function duplicateSession(source: Session, options: CopyOptions): Session {
  return forkSession(source, source.messages.length - 1, {
    ...options,
    title: options.title ?? `${source.title} (copy)`,
  });
}

/**
 * The same Session with its status set to archived (R15.11).
 *
 * A status change, never a truncation: the transcript is returned byte-identical, which is what lets the
 * archived filter show a Session that still has everything in it. Property 89 asserts the transcript
 * before and after.
 */
export function archiveSession(source: Session, now: string): Session {
  return { ...source, status: ARCHIVED_STATUS, updated_at: now, messages: [...source.messages] };
}

/** The same Session restored to the open list. */
export function unarchiveSession(source: Session, now: string): Session {
  return { ...source, status: "idle", updated_at: now, messages: [...source.messages] };
}
