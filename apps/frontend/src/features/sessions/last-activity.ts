/**
 * The last-activity label — zoc-agent-chat-rebuild R15.3, task 22.5.
 *
 * Its own module rather than living beside `SessionRow`, for the fast-refresh reason the rest of the
 * feature follows: a module exporting both a component and a function is a refresh boundary. It is also
 * read by the two workspace sessions surfaces once 25.2 repoints them, so a shared home is the right one.
 *
 * The shortest form that still says *when*: a row is one line and a Session list is scanned rather than
 * read. Past thirty days the relative form stops helping — "47d ago" is not a date anyone converts — so it
 * becomes one.
 */

export function formatLastActivity(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${String(days)}d ago` : new Date(at).toISOString().slice(0, 10);
}
