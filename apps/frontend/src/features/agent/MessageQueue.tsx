import { useState } from "react";
import { ChevronDown, ChevronUp, GripVertical, X } from "lucide-react";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * Queued-message list (develop.md Phase 11). Shows messages the user composed
 * while a run is active, with drag/keyboard reorder and per-item removal. They
 * are released one at a time as each run completes.
 */
export function MessageQueue() {
  const queue = useApp((s) => s.messageQueue);
  const dequeue = useApp((s) => s.dequeueMessage);
  const reorder = useApp((s) => s.reorderQueue);
  const clearQueue = useApp((s) => s.clearQueue);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  if (queue.length === 0) return null;

  return (
    <div className="mb-2 rounded-lg border border-[#26262B] bg-[#15151A] p-1.5">
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-[10.5px] font-medium uppercase tracking-wide text-[#71717A]">
          Queued ({queue.length})
        </span>
        <button
          type="button"
          onClick={clearQueue}
          className="text-[10.5px] text-[#71717A] hover:text-foreground"
        >
          Clear all
        </button>
      </div>
      <ul className="flex flex-col gap-1">
        {queue.map((m, i) => (
          <li
            key={m.id}
            draggable
            onDragStart={() => setDragIndex(i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragIndex !== null && dragIndex !== i) reorder(dragIndex, i);
              setDragIndex(null);
            }}
            onDragEnd={() => setDragIndex(null)}
            className={cn(
              "group flex items-center gap-1.5 rounded-md border border-transparent bg-[#1B1B21] px-1.5 py-1 text-[11.5px] text-[#D4D4D8]",
              dragIndex === i && "opacity-50",
            )}
          >
            <GripVertical className="h-3 w-3 shrink-0 cursor-grab text-[#52525B]" aria-hidden />
            <span className="min-w-0 flex-1 truncate" title={m.content}>
              {m.content}
            </span>
            <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
              <button
                type="button"
                aria-label={`Move up: ${m.content}`}
                disabled={i === 0}
                onClick={() => reorder(i, i - 1)}
                className="flex h-5 w-5 items-center justify-center rounded text-[#71717A] hover:text-foreground disabled:opacity-30"
              >
                <ChevronUp className="h-3 w-3" />
              </button>
              <button
                type="button"
                aria-label={`Move down: ${m.content}`}
                disabled={i === queue.length - 1}
                onClick={() => reorder(i, i + 1)}
                className="flex h-5 w-5 items-center justify-center rounded text-[#71717A] hover:text-foreground disabled:opacity-30"
              >
                <ChevronDown className="h-3 w-3" />
              </button>
              <button
                type="button"
                aria-label={`Remove from queue: ${m.content}`}
                onClick={() => dequeue(m.id)}
                className="flex h-5 w-5 items-center justify-center rounded text-[#71717A] hover:text-destructive"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
