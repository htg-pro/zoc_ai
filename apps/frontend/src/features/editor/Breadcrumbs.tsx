import { useMemo, useState } from "react";
import { ChevronRight, Code2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useApp } from "@/lib/store";
import { extractOutline, type OutlineSymbol } from "@/lib/outline";
import { revealLine } from "@/lib/editor-actions";
import { sepOf } from "@/lib/paths";
import { cn } from "@/lib/utils";

/**
 * VS Code-style breadcrumbs: the active file's path segments plus a symbols
 * dropdown (from the offline outline extractor). Folder segments reveal in the
 * Explorer; a symbol jumps the editor to its line.
 */
export function Breadcrumbs({ path }: { path: string }) {
  const file = useApp((s) => s.openFiles.find((f) => f.path === path));
  const workspaceRoot = useApp((s) => s.workspaceRoot);
  const setActivity = useApp((s) => s.setActivity);

  const segments = useMemo(() => {
    const sep = sepOf(path);
    const rel =
      workspaceRoot && path.startsWith(workspaceRoot)
        ? path.slice(workspaceRoot.length).replace(/^[\\/]/, "")
        : path.replace(/^[\\/]/, "");
    return rel.split(sep).filter(Boolean);
  }, [path, workspaceRoot]);

  const symbols = useMemo(
    () => (file ? extractOutline(file.content, file.language) : []),
    [file],
  );

  return (
    <div className="flex h-6 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border bg-[hsl(var(--surface))] px-2 text-[11px] text-muted-foreground">
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        return (
          <span key={i} className="flex shrink-0 items-center gap-0.5">
            {i > 0 && <ChevronRight className="h-3 w-3 opacity-50" />}
            <button
              type="button"
              onClick={() => !isLast && setActivity("files")}
              className={cn("rounded px-1 hover:bg-accent", isLast && "text-foreground")}
            >
              {seg}
            </button>
          </span>
        );
      })}
      {symbols.length > 0 && (
        <>
          <ChevronRight className="h-3 w-3 shrink-0 opacity-50" />
          <SymbolDropdown symbols={symbols} />
        </>
      )}
    </div>
  );
}

function SymbolDropdown({ symbols }: { symbols: OutlineSymbol[] }) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex shrink-0 items-center gap-1 rounded px-1 hover:bg-accent"
          title="Go to symbol"
        >
          <Code2 className="h-3 w-3" />
          Symbols
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 w-56 overflow-y-auto">
        {symbols.map((s, i) => (
          <DropdownMenuItem
            key={`${s.name}:${s.line}:${i}`}
            onSelect={() => revealLine(s.line)}
            className="flex items-center gap-2"
          >
            <span className="w-12 shrink-0 text-[9px] uppercase text-muted-foreground">{s.kind}</span>
            <span className="truncate font-mono text-xs">{s.name}</span>
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">:{s.line}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
