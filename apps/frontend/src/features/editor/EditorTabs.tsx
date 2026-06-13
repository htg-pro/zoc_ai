import { FileCode, FileJson, FileText, File as FileIcon, X } from "lucide-react";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

function tabIcon(name: string) {
  const ext = name.split(".").pop();
  if (ext === "json") return <FileJson className="h-3.5 w-3.5" />;
  if (ext === "md") return <FileText className="h-3.5 w-3.5" />;
  if (ext === "tsx" || ext === "ts" || ext === "py" || ext === "rs") return <FileCode className="h-3.5 w-3.5" />;
  return <FileIcon className="h-3.5 w-3.5" />;
}

export function EditorTabs() {
  const openFiles = useApp((s) => s.openFiles);
  const activeFile = useApp((s) => s.activeFile);
  const setActiveFile = useApp((s) => s.setActiveFile);
  const closeFile = useApp((s) => s.closeFile);
  const fileStatus = useApp((s) => s.fileStatus);

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-border bg-[hsl(var(--surface))]">
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {openFiles.map((f) => {
          const active = f.path === activeFile;
          const modified = f.dirty || fileStatus[f.path] === "M";
          return (
            <div
              key={f.path}
              className={cn(
                "group relative flex items-center gap-1.5 border-r border-border px-3.5 text-[12.5px] transition-colors",
                active
                  ? "bg-background text-foreground"
                  : "bg-transparent text-muted-foreground hover:bg-accent/40",
              )}
            >
              {active && <span className="absolute left-0 right-0 top-0 h-[2px] bg-primary" />}
              <button
                type="button"
                onClick={() => setActiveFile(f.path)}
                className={cn(
                  "flex items-center gap-1.5 py-2",
                  active ? "text-primary" : "text-muted-foreground",
                )}
              >
                <span className={active ? "text-primary" : "text-muted-foreground"}>{tabIcon(f.name)}</span>
                <span className={cn("truncate", active ? "text-foreground" : "text-muted-foreground")}>
                  {f.name}
                </span>
              </button>
              {modified && (
                <span
                  className="h-1.5 w-1.5 rounded-full bg-warning"
                  title={f.dirty ? "Unsaved changes" : "Modified"}
                  aria-hidden
                />
              )}
              <button
                type="button"
                aria-label={`Close ${f.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  closeFile(f.path);
                }}
                className={cn(
                  "flex h-4 w-4 items-center justify-center rounded text-muted-foreground/70 hover:bg-accent hover:text-foreground",
                  active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                )}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
