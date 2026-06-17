import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import {
  ChevronRight,
  ChevronsDownUp,
  Copy,
  CopyPlus,
  ExternalLink,
  File,
  FileCode,
  FileJson,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { basename, isWithin, sepOf } from "@/lib/paths";
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

function AgentEditingDot({ path }: { path: string }) {
  const editing = useApp(
    (s) => (s.streaming || s.isRunning) && (s.fileStatus[path] === "M" || s.fileStatus[path] === "A"),
  );
  if (!editing) return null;
  return (
    <span
      className="relative mr-1 inline-flex h-1.5 w-1.5 shrink-0 items-center justify-center"
      title="Agent is editing"
      aria-label="Agent is editing"
    >
      <span className="absolute inline-flex h-2 w-2 animate-ping rounded-full bg-primary/50" />
      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
    </span>
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
      <span className="ml-auto flex items-center">
        <AgentEditingDot path={node.path} />
        <StatusBadge status={status} />
      </span>
    </button>
  );
}

type EditState =
  | { kind: "rename"; path: string }
  | { kind: "newfile" | "newfolder"; dir: string }
  | null;

interface NodeHandlers {
  onOpen: (path: string) => void;
  onToggle: (path: string) => void | Promise<void>;
  onMenu: (e: ReactMouseEvent, node: LiveFileNode | null) => void;
  onMove: (from: string, toDir: string) => void;
  onSubmitEdit: (name: string) => void;
  onCancelEdit: () => void;
}

function relativeTo(root: string, path: string): string {
  if (!isWithin(root, path) || path === root) return path;
  const sep = sepOf(root);
  const prefix = root.endsWith(sep) ? root : root + sep;
  return path.slice(prefix.length);
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  return false;
}

function ExplorerToolbar({
  onNewFile,
  onNewFolder,
  onRefresh,
  onCollapseAll,
}: {
  onNewFile: () => void;
  onNewFolder: () => void;
  onRefresh: () => void;
  onCollapseAll: () => void;
}) {
  const Btn = ({
    label,
    onClick,
    children,
  }: {
    label: string;
    onClick: () => void;
    children: ReactNode;
  }) => (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className="h-6 w-6 text-muted-foreground hover:text-foreground"
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      {children}
    </Button>
  );
  return (
    <div className="flex items-center justify-end gap-0.5 border-b border-border px-1.5 py-1">
      <Btn label="New File" onClick={onNewFile}>
        <FilePlus className="h-3.5 w-3.5" />
      </Btn>
      <Btn label="New Folder" onClick={onNewFolder}>
        <FolderPlus className="h-3.5 w-3.5" />
      </Btn>
      <Btn label="Refresh Explorer" onClick={onRefresh}>
        <RefreshCw className="h-3.5 w-3.5" />
      </Btn>
      <Btn label="Collapse Folders" onClick={onCollapseAll}>
        <ChevronsDownUp className="h-3.5 w-3.5" />
      </Btn>
    </div>
  );
}

function LiveFileTree({ root }: { root: string }) {
  const openFile = useApp((s) => s.openFile);
  const activeFile = useApp((s) => s.activeFile);
  const workspaceRoot = useApp((s) => s.workspaceRoot) ?? root;
  const fsRefreshNonce = useApp((s) => s.fsRefreshNonce);
  const createFile = useApp((s) => s.createFile);
  const createFolder = useApp((s) => s.createFolder);
  const renameEntry = useApp((s) => s.renameEntry);
  const duplicateEntry = useApp((s) => s.duplicateEntry);
  const deleteEntry = useApp((s) => s.deleteEntry);
  const moveEntry = useApp((s) => s.moveEntry);
  const revealEntry = useApp((s) => s.revealEntry);
  const openFilesDirty = useApp((s) => s.openFiles);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({ [root]: true });
  const [children, setChildren] = useState<Record<string, LiveFileNode[]>>({});
  const [version, setVersion] = useState(0);
  const [menu, setMenu] = useState<{ node: LiveFileNode | null; x: number; y: number } | null>(null);
  const [edit, setEdit] = useState<EditState>(null);
  const [confirmDelete, setConfirmDelete] = useState<LiveFileNode | null>(null);

  const refresh = useCallback(async (path: string) => {
    const nodes = await fsListDir(path, 1);
    setChildren((c) => ({ ...c, [path]: nodes }));
  }, []);

  const refreshAll = useCallback(async () => {
    await refresh(root);
    for (const path of Object.keys(expanded)) {
      if (expanded[path] && path !== root) await refresh(path);
    }
  }, [refresh, root, expanded]);

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
    for (const path of Object.keys(expanded)) {
      if (expanded[path]) void refresh(path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, fsRefreshNonce]);

  const expand = useCallback((path: string) => {
    setExpanded((e) => ({ ...e, [path]: true }));
  }, []);

  const handlers: NodeHandlers = useMemo(
    () => ({
      onOpen: (path) => void openFile(path),
      onToggle: async (path) => {
        const next = !expanded[path];
        setExpanded((e) => ({ ...e, [path]: next }));
        if (next && !children[path]) await refresh(path);
      },
      onMenu: (e, node) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ node, x: e.clientX, y: e.clientY });
      },
      onMove: (from, toDir) => {
        if (from === toDir || basename(from) === "" ) return;
        void moveEntry(from, toDir);
      },
      onSubmitEdit: (name) => {
        const current = edit;
        setEdit(null);
        if (!current || !name.trim()) return;
        if (current.kind === "rename") void renameEntry(current.path, name);
        else if (current.kind === "newfile") void createFile(current.dir, name);
        else void createFolder(current.dir, name);
      },
      onCancelEdit: () => setEdit(null),
    }),
    [expanded, children, refresh, openFile, moveEntry, renameEntry, createFile, createFolder, edit],
  );

  const startCreate = (dir: string, kind: "newfile" | "newfolder") => {
    setMenu(null);
    const target = dir || root;
    if (target !== root) expand(target);
    setEdit({ kind, dir: target });
  };

  const rootChildren = children[root] ?? [];
  const rootCreate = edit && edit.kind !== "rename" && edit.dir === root ? edit : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ExplorerToolbar
        onNewFile={() => startCreate(root, "newfile")}
        onNewFolder={() => startCreate(root, "newfolder")}
        onRefresh={() => void refreshAll()}
        onCollapseAll={() => setExpanded({ [root]: true })}
      />
      <ScrollArea className="h-full min-h-0">
        <div
          className="px-1 py-1 text-sm"
          onContextMenu={(e) => handlers.onMenu(e, null)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            const from = e.dataTransfer.getData("text/zoc-path");
            if (from) handlers.onMove(from, root);
          }}
        >
          {rootCreate && (
            <InlineInput
              kind={rootCreate.kind}
              depth={0}
              onSubmit={handlers.onSubmitEdit}
              onCancel={handlers.onCancelEdit}
            />
          )}
          {rootChildren.map((n) => (
            <LiveTreeNode
              key={n.path}
              node={n}
              depth={0}
              expanded={expanded}
              children_={children}
              handlers={handlers}
              activeFile={activeFile}
              edit={edit}
            />
          ))}
          {rootChildren.length === 0 && !rootCreate && (
            <div className="px-2 py-6 text-center text-[11px] text-muted-foreground">
              Empty folder. Use the toolbar to create a file or folder.
            </div>
          )}
        </div>
      </ScrollArea>

      {menu && (
        <NodeContextMenu
          x={menu.x}
          y={menu.y}
          node={menu.node}
          onClose={() => setMenu(null)}
          actions={{
            newFile: (dir) => startCreate(dir, "newfile"),
            newFolder: (dir) => startCreate(dir, "newfolder"),
            open: (p) => void openFile(p),
            rename: (p) => {
              setMenu(null);
              setEdit({ kind: "rename", path: p });
            },
            duplicate: (p) => {
              setMenu(null);
              void duplicateEntry(p);
            },
            del: (node) => {
              setMenu(null);
              setConfirmDelete(node);
            },
            reveal: (p) => {
              setMenu(null);
              void revealEntry(p);
            },
            copyPath: (p) => {
              setMenu(null);
              void copyToClipboard(p);
            },
            copyRelative: (p) => {
              setMenu(null);
              void copyToClipboard(relativeTo(workspaceRoot, p));
            },
            refresh: () => {
              setMenu(null);
              void refreshAll();
            },
            collapseAll: () => {
              setMenu(null);
              setExpanded({ [root]: true });
            },
          }}
        />
      )}

      <DeleteConfirmDialog
        node={confirmDelete}
        dirtyOpen={
          !!confirmDelete &&
          openFilesDirty.some((f) => isWithin(confirmDelete.path, f.path) && f.dirty)
        }
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          const target = confirmDelete;
          setConfirmDelete(null);
          if (target) void deleteEntry(target.path);
        }}
      />
    </div>
  );
}

interface LiveNodeProps {
  node: LiveFileNode;
  depth: number;
  expanded: Record<string, boolean>;
  children_: Record<string, LiveFileNode[]>;
  handlers: NodeHandlers;
  activeFile: string | null;
  edit: EditState;
}

function LiveTreeNode({ node, depth, expanded, children_, handlers, activeFile, edit }: LiveNodeProps) {
  const indent = useMemo(() => ({ paddingLeft: `${depth * 12 + 6}px` }), [depth]);
  const renaming = edit?.kind === "rename" && edit.path === node.path;

  if (renaming) {
    return (
      <InlineInput
        kind={node.kind === "dir" ? "newfolder" : "newfile"}
        depth={depth}
        initial={node.name}
        onSubmit={handlers.onSubmitEdit}
        onCancel={handlers.onCancelEdit}
      />
    );
  }

  if (node.kind === "dir") {
    const isOpen = !!expanded[node.path];
    const creatingHere = edit && edit.kind !== "rename" && edit.dir === node.path ? edit : null;
    return (
      <div
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onDrop={(e) => {
          e.stopPropagation();
          const from = e.dataTransfer.getData("text/zoc-path");
          if (from) handlers.onMove(from, node.path);
        }}
      >
        <button
          type="button"
          draggable
          onDragStart={(e) => e.dataTransfer.setData("text/zoc-path", node.path)}
          onClick={() => handlers.onToggle(node.path)}
          onContextMenu={(e) => handlers.onMenu(e, node)}
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
        {isOpen && creatingHere && (
          <InlineInput
            kind={creatingHere.kind}
            depth={depth + 1}
            onSubmit={handlers.onSubmitEdit}
            onCancel={handlers.onCancelEdit}
          />
        )}
        {isOpen &&
          (children_[node.path] ?? []).map((child) => (
            <LiveTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              children_={children_}
              handlers={handlers}
              activeFile={activeFile}
              edit={edit}
            />
          ))}
      </div>
    );
  }
  const active = activeFile === node.path;
  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/zoc-path", node.path)}
      onClick={() => handlers.onOpen(node.path)}
      onContextMenu={(e) => handlers.onMenu(e, node)}
      className={cn(
        "flex w-full items-center gap-1.5 rounded py-0.5 pr-2 text-left text-xs hover:bg-accent/60",
        active && "bg-[hsl(var(--primary)/0.12)] text-foreground",
      )}
      style={indent}
    >
      <span className="w-3" aria-hidden />
      {fileIcon(node.name, false)}
      <span className={cn("truncate", active && "text-foreground")}>{node.name}</span>
      <span className="ml-auto flex items-center">
        <AgentEditingDot path={node.path} />
        <LiveStatusBadge path={node.path} />
      </span>
    </button>
  );
}

function InlineInput({
  kind,
  depth,
  initial = "",
  onSubmit,
  onCancel,
}: {
  kind: "newfile" | "newfolder";
  depth: number;
  initial?: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const indent = { paddingLeft: `${depth * 12 + 6}px` };
  return (
    <div className="flex items-center gap-1.5 py-0.5" style={indent}>
      {kind === "newfolder" ? (
        <Folder className="h-3.5 w-3.5 text-muted-foreground" />
      ) : (
        <File className="h-3.5 w-3.5 text-muted-foreground" />
      )}
      <input
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit(value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => onCancel()}
        placeholder={kind === "newfolder" ? "folder name" : "file name"}
        aria-label={kind === "newfolder" ? "New folder name" : "New file name"}
        className="h-5 flex-1 rounded border border-primary/50 bg-background px-1 font-mono text-[11px] outline-none focus:border-primary"
      />
    </div>
  );
}

interface MenuActions {
  newFile: (dir: string) => void;
  newFolder: (dir: string) => void;
  open: (path: string) => void;
  rename: (path: string) => void;
  duplicate: (path: string) => void;
  del: (node: LiveFileNode) => void;
  reveal: (path: string) => void;
  copyPath: (path: string) => void;
  copyRelative: (path: string) => void;
  refresh: () => void;
  collapseAll: () => void;
}

function NodeContextMenu({
  x,
  y,
  node,
  onClose,
  actions,
}: {
  x: number;
  y: number;
  node: LiveFileNode | null;
  onClose: () => void;
  actions: MenuActions;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onEsc);
    };
  }, [onClose]);

  const Item = ({
    icon: I,
    label,
    onClick,
    danger,
  }: {
    icon: typeof File;
    label: string;
    onClick: () => void;
    danger?: boolean;
  }) => (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] hover:bg-accent",
        danger ? "text-destructive" : "text-foreground",
      )}
    >
      <I className="h-3.5 w-3.5" />
      {label}
    </button>
  );
  const Sep = () => <div className="my-1 h-px bg-border" />;

  // Clamp to viewport so the menu never overflows offscreen.
  const left = Math.min(x, (typeof window !== "undefined" ? window.innerWidth : 9999) - 220);
  const top = Math.min(y, (typeof window !== "undefined" ? window.innerHeight : 9999) - 320);

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 w-52 rounded-md border border-border bg-popover p-1 shadow-lg"
      style={{ left, top }}
    >
      {node === null ? (
        <>
          <Item icon={FilePlus} label="New File" onClick={() => actions.newFile("")} />
          <Item icon={FolderPlus} label="New Folder" onClick={() => actions.newFolder("")} />
          <Sep />
          <Item icon={RefreshCw} label="Refresh" onClick={actions.refresh} />
          <Item icon={ChevronsDownUp} label="Collapse All" onClick={actions.collapseAll} />
        </>
      ) : node.kind === "dir" ? (
        <>
          <Item icon={FilePlus} label="New File" onClick={() => actions.newFile(node.path)} />
          <Item icon={FolderPlus} label="New Folder" onClick={() => actions.newFolder(node.path)} />
          <Sep />
          <Item icon={Pencil} label="Rename" onClick={() => actions.rename(node.path)} />
          <Item icon={CopyPlus} label="Duplicate" onClick={() => actions.duplicate(node.path)} />
          <Item icon={Trash2} label="Delete" danger onClick={() => actions.del(node)} />
          <Sep />
          <Item icon={ExternalLink} label="Reveal in File Manager" onClick={() => actions.reveal(node.path)} />
          <Item icon={Copy} label="Copy Path" onClick={() => actions.copyPath(node.path)} />
          <Item icon={Copy} label="Copy Relative Path" onClick={() => actions.copyRelative(node.path)} />
        </>
      ) : (
        <>
          <Item icon={File} label="Open" onClick={() => actions.open(node.path)} />
          <Item icon={Pencil} label="Rename" onClick={() => actions.rename(node.path)} />
          <Item icon={CopyPlus} label="Duplicate" onClick={() => actions.duplicate(node.path)} />
          <Item icon={Trash2} label="Delete" danger onClick={() => actions.del(node)} />
          <Sep />
          <Item icon={ExternalLink} label="Reveal in File Manager" onClick={() => actions.reveal(node.path)} />
          <Item icon={Copy} label="Copy Path" onClick={() => actions.copyPath(node.path)} />
          <Item icon={Copy} label="Copy Relative Path" onClick={() => actions.copyRelative(node.path)} />
        </>
      )}
    </div>
  );
}

function DeleteConfirmDialog({
  node,
  dirtyOpen,
  onCancel,
  onConfirm,
}: {
  node: LiveFileNode | null;
  dirtyOpen: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={!!node} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {node?.kind === "dir" ? "folder" : "file"}?</DialogTitle>
          <DialogDescription>
            {node ? (
              <>
                <span className="font-mono text-foreground">{node.name}</span> will be permanently
                deleted{node.kind === "dir" ? ", including everything inside it" : ""}. This can’t be
                undone.
                {dirtyOpen && (
                  <span className="mt-2 block text-warning">
                    This file has unsaved changes that will be lost.
                  </span>
                )}
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm}>
            <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LiveStatusBadge({ path }: { path: string }) {
  const status = useApp((s) => s.fileStatus[path]);
  return <StatusBadge status={status} />;
}
