/**
 * The one Session list — zoc-agent-chat-rebuild R15.3, R15.4, R15.5, R15.10, R15.11, R35.2, task 22.5.
 *
 * Search, the open/archived filter, the rows, and the delete confirmation. R35.2 asks for a single
 * Session_List, and this is it: the header's `SessionSwitcher` renders it inside a dropdown, and both
 * workspace sessions surfaces render it once 25.2 repoints them.
 *
 * ## What R35's ground-truth note gets wrong, and how that changed this component
 *
 * The requirement names "the chat panel's own switcher" as one of three implementations to consolidate.
 * Reading `features/agent/` finds no switcher at all — `AgentMenu.tsx` is a memory menu, and the nearest
 * thing to switching is `selectSession(activeSessionId)` used as a reload. So there are two row markups to
 * reconcile, not three, and the chat panel's obligation is to *gain* a list it never had. This component is
 * therefore new work rather than a deletion, which is the opposite of how the note reads.
 *
 * ## Why the delete confirmation lives outside the row
 *
 * One dialog, whichever row asked for it. A dialog per row would mount one Radix `Dialog` per Session — 500
 * of them in the 22.5 search fixture — and the confirmation is about a decision rather than about a row.
 * 25.2 moved the markup out to {@link SessionDeleteDialog}, because the two workspace sessions surfaces
 * replace their `window.confirm` calls with the same dialog and three copies of it would be the divergence
 * R35.2 asks us to stop.
 *
 * ## Why search filters the rows rather than the Sessions
 *
 * `searchSessions` returns hits carrying which messages matched, and the list only needs the Session ids —
 * but the hits are what a later "3 matches" affordance would render, so the search runs once and the row
 * projection is applied to its result. That keeps R15.5's soundness a property of one function.
 */
import { useMemo, useState } from "react";
import { Search } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Session } from "@zoc-studio/shared-types";
import { SessionDeleteDialog } from "./SessionDeleteDialog";
import { SessionRow } from "./SessionRow";
import { searchSessions, sessionRows, type SessionFilter } from "./session-list-model";

export interface SessionListProps {
  sessions: readonly Session[];
  activeSessionId: string | null;
  /** Sessions outside this root are not listed (R15.10). */
  workspaceRoot: string | null;
  pinned?: Readonly<Record<string, true>>;
  onSelect: (sessionId: string) => void;
  onTogglePin?: (sessionId: string) => void;
  onRename?: (sessionId: string, title: string) => void;
  onFork?: (sessionId: string) => void;
  onDuplicate?: (sessionId: string) => void;
  onArchive?: (sessionId: string) => void;
  onUnarchive?: (sessionId: string) => void;
  onDelete?: (sessionId: string) => void;
  /** Shown by the workspace surfaces, which list across workspaces; the header's switcher does not. */
  showWorkspace?: boolean;
  now?: number;
  className?: string;
}

export function SessionList({
  sessions,
  activeSessionId,
  workspaceRoot,
  pinned,
  onSelect,
  onTogglePin,
  onRename,
  onFork,
  onDuplicate,
  onArchive,
  onUnarchive,
  onDelete,
  showWorkspace = false,
  now,
  className,
}: SessionListProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SessionFilter>("open");
  const [pendingDelete, setPendingDelete] = useState<Session | null>(null);

  const rows = useMemo(() => {
    const hits = searchSessions(sessions, query);
    const matching = hits.map((hit) => hit.session);
    return sessionRows(matching, {
      workspaceRoot,
      filter,
      ...(pinned === undefined ? {} : { pinned }),
    });
  }, [sessions, query, workspaceRoot, filter, pinned]);

  const byId = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);

  return (
    <div className={cn("flex min-h-0 flex-col", className)} data-zoc-session-list="">
      <div className="flex items-center gap-2 px-2 py-1">
        <Search
          aria-hidden
          className="size-3.5 shrink-0"
          style={{ color: "var(--zoc-text-faint)" }}
        />
        <input
          value={query}
          data-zoc-session-search=""
          // "session", never "thread" (R35.5).
          aria-label="Search sessions"
          placeholder="Search sessions"
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-[color:var(--zoc-text-faint)]"
          style={{ color: "var(--zoc-text)", fontSize: "var(--zoc-text-meta)" }}
        />
      </div>

      <div
        role="tablist"
        aria-label="Session filter"
        className="flex items-center gap-1 px-2 pb-1"
        data-zoc-session-filter={filter}
      >
        {(["open", "archived"] as const).map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="tab"
            aria-selected={filter === candidate}
            data-zoc-session-filter-tab={candidate}
            onClick={() => {
              setFilter(candidate);
            }}
            className="rounded-[var(--zoc-radius-chip)] px-1.5 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]"
            style={{
              backgroundColor: filter === candidate ? "var(--zoc-row-bg)" : undefined,
              color: filter === candidate ? "var(--zoc-text)" : "var(--zoc-text-muted)",
              fontSize: "var(--zoc-text-label)",
            }}
          >
            {candidate === "open" ? "Open" : "Archived"}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <p
          data-zoc-session-empty=""
          className="px-2 py-2"
          style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-label)" }}
        >
          {query.trim().length > 0
            ? "No session matches that."
            : filter === "archived"
              ? "No archived sessions."
              : "No sessions in this workspace yet."}
        </p>
      ) : (
        <ul role="list" className="flex min-h-0 flex-col overflow-y-auto">
          {rows.map((row) => (
            <SessionRow
              key={row.id}
              row={row}
              active={row.id === activeSessionId}
              showWorkspace={showWorkspace}
              {...(now === undefined ? {} : { now })}
              onSelect={() => {
                onSelect(row.id);
              }}
              {...(onTogglePin === undefined
                ? {}
                : {
                    onTogglePin: () => {
                      onTogglePin(row.id);
                    },
                  })}
              {...(onRename === undefined
                ? {}
                : {
                    onRename: (title: string) => {
                      onRename(row.id, title);
                    },
                  })}
              {...(onFork === undefined
                ? {}
                : {
                    onFork: () => {
                      onFork(row.id);
                    },
                  })}
              {...(onDuplicate === undefined
                ? {}
                : {
                    onDuplicate: () => {
                      onDuplicate(row.id);
                    },
                  })}
              {...(onArchive === undefined
                ? {}
                : {
                    onArchive: () => {
                      onArchive(row.id);
                    },
                  })}
              {...(onUnarchive === undefined
                ? {}
                : {
                    onUnarchive: () => {
                      onUnarchive(row.id);
                    },
                  })}
              {...(onDelete === undefined
                ? {}
                : {
                    onDelete: () => {
                      setPendingDelete(byId.get(row.id) ?? null);
                    },
                  })}
            />
          ))}
        </ul>
      )}

      <SessionDeleteDialog
        session={pendingDelete}
        onCancel={() => {
          setPendingDelete(null);
        }}
        onConfirm={(sessionId) => {
          setPendingDelete(null);
          onDelete?.(sessionId);
        }}
      />
    </div>
  );
}
