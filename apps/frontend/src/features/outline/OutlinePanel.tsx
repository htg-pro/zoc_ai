import { useMemo, useState } from "react";
import { Code2, FileText } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useApp } from "@/lib/store";
import { extractOutline, filterOutline, type SymbolKind } from "@/lib/outline";
import { revealLine } from "@/lib/editor-actions";
import { cn } from "@/lib/utils";

const KIND_COLOR: Record<SymbolKind, string> = {
  function: "text-[#4ec9b0]",
  method: "text-[#4ec9b0]",
  class: "text-[#c586c0]",
  interface: "text-[#569cd6]",
  type: "text-[#569cd6]",
  enum: "text-[#d7ba7d]",
  struct: "text-[#c586c0]",
  const: "text-[#9cdcfe]",
};

/**
 * Outline side view (develop.md Side Panel → Outline). Lists the symbols of the
 * active file using the offline outline extractor and jumps the editor to a
 * symbol on click. Updates as the active file / its content changes.
 */
export function OutlinePanel() {
  const file = useApp((s) => {
    const active = s.activeFile;
    return active ? s.openFiles.find((f) => f.path === active) ?? null : null;
  });
  const [query, setQuery] = useState("");

  const symbols = useMemo(
    () => (file ? extractOutline(file.content, file.language) : []),
    [file],
  );
  const filtered = useMemo(() => filterOutline(symbols, query), [symbols, query]);

  if (!file) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-xs text-muted-foreground">
        <FileText className="h-6 w-6 opacity-50" />
        No active file to outline.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-2 pb-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter symbols"
          className="h-7 text-xs"
        />
      </div>
      {filtered.length === 0 ? (
        <p className="px-3 py-4 text-center text-xs text-muted-foreground">
          {symbols.length === 0 ? "No symbols found." : `No symbols match “${query}”.`}
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
          {filtered.map((s, i) => (
            <li key={`${s.name}:${s.line}:${i}`}>
              <button
                type="button"
                onClick={() => revealLine(s.line)}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] hover:bg-accent"
              >
                <Code2 className={cn("h-3 w-3 shrink-0", KIND_COLOR[s.kind])} />
                <span className="truncate font-mono">{s.name}</span>
                <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                  :{s.line}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
