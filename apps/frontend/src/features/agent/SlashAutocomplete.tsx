import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  FileText,
  FlaskConical,
  RefreshCw,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { matchSlash, type SlashCommand } from "@/lib/slash-commands";
import { cn } from "@/lib/utils";

const COMMAND_ICONS: Record<SlashCommand["name"], LucideIcon> = {
  explain: BookOpen,
  test: FlaskConical,
  fix: Wrench,
  document: FileText,
  refactor: RefreshCw,
};

export function SlashAutocomplete({
  prefix,
  onPick,
}: {
  prefix: string;
  onPick: (command: SlashCommand) => void;
}) {
  const items = useMemo(() => matchSlash(prefix), [prefix]);
  const [active, setActive] = useState(0);
  const activeRef = useRef(0);
  const itemsRef = useRef(items);

  useEffect(() => {
    itemsRef.current = items;
    activeRef.current = 0;
    setActive(0);
  }, [items]);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const list = itemsRef.current;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        setActive((index) => (list.length ? (index + 1) % list.length : 0));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        setActive((index) => (list.length ? (index - 1 + list.length) % list.length : 0));
      } else if (event.key === "Enter" && list.length) {
        event.preventDefault();
        event.stopPropagation();
        onPick(list[activeRef.current]);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onPick]);

  if (items.length === 0) return null;
  return (
    <div
      role="listbox"
      aria-label="Composer commands"
      className="absolute bottom-full left-2 right-2 z-30 mb-2 max-h-60 overflow-auto rounded-md border border-[#26262B] bg-[#131318] p-1 shadow-xl"
    >
      {items.map((command, index) => {
        const Icon = COMMAND_ICONS[command.name];
        return (
          <button
            key={command.name}
            type="button"
            role="option"
            aria-selected={index === active}
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(command);
            }}
            onMouseEnter={() => setActive(index)}
            className={cn(
              "flex min-h-10 w-full items-center gap-2.5 rounded px-2 py-1.5 text-left",
              index === active ? "bg-[#1B1B21]" : "hover:bg-[#1B1B21]/60",
            )}
          >
            <Icon className="h-3.5 w-3.5 shrink-0 text-[#9B6AF1]" />
            <span className="w-[72px] shrink-0 font-mono text-[12px] text-[#FAFAFA]">
              /{command.name}
            </span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-[#A1A1AA]">
              {command.summary}
            </span>
            <span
              className={cn(
                "shrink-0 text-[10px] font-medium",
                command.mode === "ask" ? "text-[#60A5FA]" : "text-[#C4B5FD]",
              )}
            >
              {command.mode === "ask" ? "Ask" : "Agent"}
            </span>
          </button>
        );
      })}
    </div>
  );
}
