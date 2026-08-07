/**
 * One Session row — zoc-agent-chat-rebuild R15.3, R15.4, R15.8, R15.9, R15.11, R35.2, R35.5, task 22.5.
 *
 * The single row markup R35.2 asks for. It is rendered from the header's `SessionSwitcher` and, once 25.2
 * repoints them, from both workspace sessions surfaces — so what it must not do is assume where it is: no
 * width, no surrounding chrome, and every action optional. A surface that cannot fork passes no
 * `onFork` and the item is absent rather than disabled.
 *
 * ## Three facts, always (R15.3)
 *
 * Title, last activity, and message count. The workspace basename is the fourth and is shown only when the
 * row is out of scope for the current workspace — inside one workspace every row would carry the same
 * word, which is noise; across workspaces it is the fact that tells two same-titled Sessions apart.
 *
 * ## Rename is inline and reversible
 *
 * A dialog for a title is a lot of ceremony for a string. `Enter` commits, `Escape` reverts, and blur
 * commits — which is what a user expects from a filename, and what makes an accidental rename cheap to
 * undo because the original is still in the store until it lands.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  Archive,
  ArchiveRestore,
  GitBranch,
  MoreHorizontal,
  Copy,
  Pencil,
  Pin,
  Trash2,
} from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { formatLastActivity } from "./last-activity";
import { ARCHIVED_STATUS, type SessionRowModel } from "./session-list-model";

export interface SessionRowProps {
  row: SessionRowModel;
  active: boolean;
  /** Shown only when the row belongs to another workspace, which is when it disambiguates. */
  showWorkspace?: boolean;
  now?: number;
  onSelect: () => void;
  onTogglePin?: () => void;
  onRename?: (title: string) => void;
  onFork?: () => void;
  onDuplicate?: () => void;
  onArchive?: () => void;
  onUnarchive?: () => void;
  onDelete?: () => void;
  className?: string;
}

export function SessionRow({
  row,
  active,
  showWorkspace = false,
  now = Date.now(),
  onSelect,
  onTogglePin,
  onRename,
  onFork,
  onDuplicate,
  onArchive,
  onUnarchive,
  onDelete,
  className,
}: SessionRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.title);
  /** Whether the field has actually held focus. See the blur guard below. */
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Deferred by one frame, because the rename is started from a Radix menu item and Radix returns focus to
  // the trigger as it closes (R21.6, and correct for every other item). Focusing the input synchronously
  // loses that race: the input is focused, Radix moves focus back, the input blurs, and the blur commits —
  // so the field closes in the same tick it opened.
  useEffect(() => {
    if (!editing) return;
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [editing]);

  const commit = () => {
    setEditing(false);
    setFocused(false);
    const next = draft.trim();
    // An empty title is a mistake rather than an intention: reverting is what a filename field does.
    if (next.length > 0 && next !== row.title) onRename?.(next);
    else setDraft(row.title);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setDraft(row.title);
      setEditing(false);
      setFocused(false);
    }
  };

  const archived = row.status === ARCHIVED_STATUS;

  return (
    <li
      className={cn(
        "flex items-center gap-2 rounded-[var(--zoc-radius-chip)] px-2 py-1",
        className,
      )}
      data-zoc-session-row={row.id}
      data-active={active ? "" : undefined}
      data-archived={archived ? "" : undefined}
      style={{ backgroundColor: active ? "var(--zoc-row-bg)" : undefined }}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          data-zoc-session-rename-input={row.id}
          aria-label={`Rename session ${row.title}`}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            setFocused(true);
          }}
          // Only a blur from a field that held focus is a commit. A blur that arrives before the field was
          // ever focused is Radix's focus restoration, not the user leaving.
          onBlur={() => {
            if (focused) commit();
          }}
          className="min-w-0 flex-1 bg-transparent outline-none"
          style={{ color: "var(--zoc-text)", fontSize: "var(--zoc-text-meta)" }}
        />
      ) : (
        <button
          type="button"
          data-zoc-session-select={row.id}
          onClick={onSelect}
          // The whole row's information in one accessible name: a screen-reader user choosing between
          // Sessions needs the three facts R15.3 names, not just the title.
          aria-label={`${row.title}, ${String(row.messageCount)} ${
            row.messageCount === 1 ? "message" : "messages"
          }, ${formatLastActivity(row.lastActivity, now)}${
            showWorkspace ? `, in ${row.rootBasename}` : ""
          }`}
          aria-current={active ? "true" : undefined}
          className="flex min-w-0 flex-1 items-baseline gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]"
        >
          <span
            className="min-w-0 flex-1 truncate"
            data-zoc-session-title=""
            style={{ color: "var(--zoc-text)", fontSize: "var(--zoc-text-meta)" }}
          >
            {row.title}
          </span>
          {showWorkspace ? (
            <span
              className="shrink-0 truncate font-mono"
              data-zoc-session-workspace={row.rootBasename}
              style={{ color: "var(--zoc-text-faint)", fontSize: "var(--zoc-text-label)" }}
            >
              {row.rootBasename}
            </span>
          ) : null}
          <span
            className="shrink-0 tabular-nums"
            data-zoc-session-count={String(row.messageCount)}
            style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-label)" }}
          >
            {row.messageCount}
          </span>
          <span
            className="shrink-0"
            data-zoc-session-activity=""
            style={{ color: "var(--zoc-text-faint)", fontSize: "var(--zoc-text-label)" }}
          >
            {formatLastActivity(row.lastActivity, now)}
          </span>
        </button>
      )}

      {onTogglePin === undefined ? null : (
        <button
          type="button"
          data-zoc-session-pin={row.id}
          aria-pressed={row.pinned}
          aria-label={row.pinned ? `Unpin ${row.title}` : `Pin ${row.title}`}
          onClick={onTogglePin}
          className="shrink-0 rounded-[var(--zoc-radius-chip)] p-0.5 hover:bg-[var(--zoc-elev-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]"
          style={{ color: row.pinned ? "var(--zoc-agent)" : "var(--zoc-text-faint)" }}
        >
          <Pin aria-hidden className="size-3" />
        </button>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-zoc-session-menu={row.id}
            aria-label={`Actions for ${row.title}`}
            className="shrink-0 rounded-[var(--zoc-radius-chip)] p-0.5 hover:bg-[var(--zoc-elev-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]"
            style={{ color: "var(--zoc-text-muted)" }}
          >
            <MoreHorizontal aria-hidden className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {onRename === undefined ? null : (
            <DropdownMenuItem
              data-zoc-session-action="rename"
              onSelect={() => {
                setDraft(row.title);
                setEditing(true);
              }}
            >
              <Pencil aria-hidden className="mr-2 size-3.5" />
              Rename
            </DropdownMenuItem>
          )}
          {onFork === undefined ? null : (
            <DropdownMenuItem data-zoc-session-action="fork" onSelect={onFork}>
              <GitBranch aria-hidden className="mr-2 size-3.5" />
              Fork from here
            </DropdownMenuItem>
          )}
          {onDuplicate === undefined ? null : (
            <DropdownMenuItem data-zoc-session-action="duplicate" onSelect={onDuplicate}>
              <Copy aria-hidden className="mr-2 size-3.5" />
              Duplicate
            </DropdownMenuItem>
          )}
          {archived ? (
            onUnarchive === undefined ? null : (
              <DropdownMenuItem data-zoc-session-action="unarchive" onSelect={onUnarchive}>
                <ArchiveRestore aria-hidden className="mr-2 size-3.5" />
                Restore
              </DropdownMenuItem>
            )
          ) : onArchive === undefined ? null : (
            <DropdownMenuItem data-zoc-session-action="archive" onSelect={onArchive}>
              <Archive aria-hidden className="mr-2 size-3.5" />
              Archive
            </DropdownMenuItem>
          )}
          {onDelete === undefined ? null : (
            <DropdownMenuItem data-zoc-session-action="delete" onSelect={onDelete}>
              <Trash2 aria-hidden className="mr-2 size-3.5" />
              Delete…
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
