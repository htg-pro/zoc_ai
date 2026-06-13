import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, File, FileCode, FileJson, FileText, Folder, FolderOpen } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MOCK_TREE, type FileNode as MockFileNode } from "@/lib/mock-data";
import { useApp } from "@/lib/store";
import {
  fsListDir,
  fsWatchStart,
  fsWatchStop,
  isTauri,
  onFsChanged,
  type FileNode as LiveFileNode,
} from "@/lib/tauri-bridge";
import { cn } from "@/lib/utils";

function fileIcon(name: string, isDir: boolean) {
  if (isDir) return null;
  const ext = name.split(".").pop();
  if (ext === "json") return <FileJson className="h-3.5 w-3.5 text-amber-400" />;
  if (ext === "md") return <FileText className="h-3.5 w-3.5 text-blue-400" />;
  if (ext === "tsx" || ext === "ts" || ext === "py" || ext === "rs")
    return <FileCode className="h-3.5 w-3.5 text-emerald-400" />;
  return <File className="h-3.5 w-3.5 text-muted-foreground" />;
}

function StatusBadge({ status }: { status: "A" | "M" | "D" | undefined }) {
  if (!status) return null;
  const color =
    status === "A" ? "text-success" : status === "M" ? "text-warning" : "text-destructive";
  return (
    <span className={cn("ml-auto w-3 text-center font-mono text-[10px]", color)}>{status}</span>
  );
}

export function FileTree({ root }: { root?: string }) {
  const workspaceRoot = useApp((s) => s.workspaceRoot);
  const tauri = isTauri();
  const effectiveRoot = root ?? workspaceRoot ?? null;
  if (!tauri || !effectiveRoot) {
    return <MockFileTreeView />;
  }
  return <LiveFileTree root={effectiveRoot} />;
}

function MockFileTreeView() {
  return (
    <ScrollArea className="h-full">
      <div className="px-1 py-1 text-sm">
        {MOCK_TREE.map((node) => (
          <MockTreeNode key={node.id} node={node} depth={0} defaultOpen />
        ))}
      </div>
    </ScrollArea>
  );
}

function MockTreeNode({
  node,
  depth,
  defaultOpen = false,
}: {
  node: MockFileNode;
  depth: number;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const openFile = useApp((s) => s.openFile);
  const activeFile = useApp((s) => s.activeFile);
  // Must be called unconditionally (Rules of Hooks) — it was previously below
  // the `node.kind === "dir"` early return, which is a hooks violation.
  const status = useApp((s) => s.fileStatus[node.path]);
  const indent = { paddingLeft: `${depth * 12 + 6}px` };

  if (node.kind === "dir") {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={cn(
            "group flex w-full items-center gap-1 rounded py-0.5 text-left text-xs text-sidebar-foreground/90 hover:bg-accent/60",
          )}
          style={indent}
        >
          <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
          {open ? (
            <FolderOpen className="h-3.5 w-3.5 text-primary/80" />
          ) : (
            <Folder className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
        {open && node.children?.map((child) => <MockTreeNode key={child.id} node={child} depth={depth + 1} />)}
      </div>
    );
  }
  const active = activeFile === node.path;
  return (
    <button
      type="button"
      onClick={() => openFile(node.path)}
      className={cn(
        "flex w-full items-center gap-1.5 rounded py-0.5 pr-2 text-left text-xs hover:bg-accent/60",
        active && "bg-[hsl(var(--primary)/0.12)] text-foreground",
      )}
      style={indent}
    >
      <span className="w-3" aria-hidden />
      {fileIcon(node.name, false)}
      <span className={cn("truncate", active && "text-foreground")}>{node.name}</span>
      <StatusBadge status={status} />
    </button>
  );
}

function LiveFileTree({ root }: { root: string }) {
  const openFile = useApp((s) => s.openFile);
  const activeFile = useApp((s) => s.activeFile);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ [root]: true });
  const [children, setChildren] = useState<Record<string, LiveFileNode[]>>({});
  const [version, setVersion] = useState(0);

  /** Fetch a single directory's immediate children (depth=1) so the tree
   *  expands lazily and we don't pay for deep recursion on huge repos. */
  const refresh = useCallback(async (path: string) => {
    const nodes = await fsListDir(path, 1);
    setChildren((c) => ({ ...c, [path]: nodes }));
  }, []);

  useEffect(() => {
    void refresh(root);
    void fsWatchStart(root);
    let off: (() => void) | undefined;
    onFsChanged(() => setVersion((v) => v + 1)).then((fn) => {
      off = fn;
    });
    return () => {
      off?.();
      void fsWatchStop();
    };
  }, [root, refresh]);

  useEffect(() => {
    // Re-fetch every currently-expanded directory after a watcher tick.
    for (const path of Object.keys(expanded)) {
      if (expanded[path]) void refresh(path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const rootChildren = children[root] ?? [];
  return (
    <ScrollArea className="h-full">
      <div className="px-1 py-1 text-sm">
        {rootChildren.map((n) => (
          <LiveTreeNode
            key={n.path}
            node={n}
            depth={0}
            expanded={expanded}
            children_={children}
            onToggle={async (path) => {
              const next = !expanded[path];
              setExpanded((e) => ({ ...e, [path]: next }));
              if (next && !children[path]) await refresh(path);
            }}
            onOpen={(path) => void openFile(path)}
            activeFile={activeFile}
          />
        ))}
      </div>
    </ScrollArea>
  );
}

interface LiveNodeProps {
  node: LiveFileNode;
  depth: number;
  expanded: Record<string, boolean>;
  children_: Record<string, LiveFileNode[]>;
  onToggle: (path: string) => void | Promise<void>;
  onOpen: (path: string) => void;
  activeFile: string | null;
}

function LiveTreeNode({ node, depth, expanded, children_, onToggle, onOpen, activeFile }: LiveNodeProps) {
  const indent = useMemo(() => ({ paddingLeft: `${depth * 12 + 6}px` }), [depth]);
  if (node.kind === "dir") {
    const isOpen = !!expanded[node.path];
    return (
      <div>
        <button
          type="button"
          onClick={() => onToggle(node.path)}
          className="flex w-full items-center gap-1 rounded py-0.5 text-left text-xs text-sidebar-foreground/90 hover:bg-accent/60"
          style={indent}
        >
          <ChevronRight className={cn("h-3 w-3 transition-transform", isOpen && "rotate-90")} />
          {isOpen ? (
            <FolderOpen className="h-3.5 w-3.5 text-primary/80" />
          ) : (
            <Folder className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
        {isOpen &&
          (children_[node.path] ?? []).map((child) => (
            <LiveTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              children_={children_}
              onToggle={onToggle}
              onOpen={onOpen}
              activeFile={activeFile}
            />
          ))}
      </div>
    );
  }
  const active = activeFile === node.path;
  return (
    <button
      type="button"
      onClick={() => onOpen(node.path)}
      className={cn(
        "flex w-full items-center gap-1.5 rounded py-0.5 pr-2 text-left text-xs hover:bg-accent/60",
        active && "bg-[hsl(var(--primary)/0.12)] text-foreground",
      )}
      style={indent}
    >
      <span className="w-3" aria-hidden />
      {fileIcon(node.name, false)}
      <span className={cn("truncate", active && "text-foreground")}>{node.name}</span>
      <LiveStatusBadge path={node.path} />
    </button>
  );
}

function LiveStatusBadge({ path }: { path: string }) {
  const status = useApp((s) => s.fileStatus[path]);
  return <StatusBadge status={status} />;
}
