import { useEffect, useRef, useState } from "react";
import { File as FileIcon, Folder, Code } from "lucide-react";
import type { ContextCandidate } from "@zoc-studio/shared-types";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

const KIND_ICON = {
  file: FileIcon,
  folder: Folder,
  symbol: Code,
} as const;

/**
 * `@`-mention context picker. Fetches file/folder/symbol candidates for the
 * active `@query` and lets the user pick one (click or arrow keys + Enter).
 * Owns its keyboard handling via a capture-phase listener so Enter selects a
 * candidate instead of sending the message.
 */
export function MentionAutocomplete({
  query,
  onPick,
  onClose,
}: {
  query: string;
  onPick: (c: ContextCandidate) => void;
  onClose: () => void;
}) {
  const search = useApp((s) => s.searchContextCandidates);
  const [items, setItems] = useState<ContextCandidate[]>([]);
  const [active, setActive] = useState(0);
  const activeRef = useRef(0);
  const itemsRef = useRef<ContextCandidate[]>([]);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      const out = await search(query);
      if (!alive) return;
      setItems(out);
      itemsRef.current = out;
      setActive(0);
      activeRef.current = 0;
    }, 100);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query, search]);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const list = itemsRef.current;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setActive((i) => (list.length ? (i + 1) % list.length : 0));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setActive((i) => (list.length ? (i - 1 + list.length) % list.length : 0));
      } else if (e.key === "Enter") {
        if (list.length) {
          e.preventDefault();
          e.stopPropagation();
          onPick(list[activeRef.current]);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    // Capture phase so we preempt the composer's textarea key handler.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onPick, onClose]);

  if (items.length === 0) return null;

  return (
    <div className="mb-2 max-h-56 overflow-auto rounded-lg border border-[#26262B] bg-[#131318] py-1 shadow-xl">
      {items.map((c, i) => {
        const Icon = KIND_ICON[c.kind] ?? FileIcon;
        return (
          <button
            key={`${c.kind}:${c.path}:${c.line ?? ""}:${i}`}
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(c);
            }}
            onMouseEnter={() => setActive(i)}
            className={cn(
              "flex w-full items-center gap-2 px-2.5 py-1 text-left text-[12px]",
              i === active ? "bg-[#1B1B21]" : "hover:bg-[#1B1B21]/60",
            )}
          >
            <Icon className="h-3.5 w-3.5 shrink-0 text-[#9B6AF1]" />
            <span className="truncate text-[#FAFAFA]">{c.label}</span>
            {c.detail && (
              <span className="ml-auto truncate pl-2 font-mono text-[10.5px] text-[#71717A]">
                {c.detail}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
