import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CloudDownload,
  CloudUpload,
  GitBranch,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useApp } from "@/lib/store";
import { isTauri, type GitBranchInfo, type GitEntry } from "@/lib/tauri-bridge";
import { basename } from "@/lib/paths";
import { cn } from "@/lib/utils";

export function SourceControlPanel() {
  const git = useApp((s) => s.git);
  const refreshGit = useApp((s) => s.refreshGit);
  const fsRefreshNonce = useApp((s) => s.fsRefreshNonce);

  useEffect(() => {
    void refreshGit();
  }, [refreshGit, fsRefreshNonce]);

  if (!isTauri()) {
    return <Empty title="Source control requires the desktop app" />;
  }
  if (!git) {
    return <Empty title="Loading source control…" />;
  }
  if (!git.is_repo) {
    return <Empty title="This workspace is not a Git repository" hint="Run git init to start tracking changes." />;
  }
  return <RepoView />;
}

function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
      <GitBranch className="h-6 w-6 text-muted-foreground" />
      <div className="text-xs text-muted-foreground">{title}</div>
      {hint && <div className="text-[10px] text-muted-foreground/70">{hint}</div>}
    </div>
  );
}

function RepoView() {
  const git = useApp((s) => s.git)!;
  const refreshGit = useApp((s) => s.refreshGit);
  const stageFiles = useApp((s) => s.stageFiles);
  const unstageFiles = useApp((s) => s.unstageFiles);
  const discardFiles = useApp((s) => s.discardFiles);
  const deleteEntry = useApp((s) => s.deleteEntry);
  const commitChanges = useApp((s) => s.commitChanges);
  const pullChanges = useApp((s) => s.pullChanges);
  const pushChanges = useApp((s) => s.pushChanges);

  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const stagedPaths = useMemo(() => git.staged.map((e) => e.path), [git.staged]);
  const unstagedPaths = useMemo(() => git.unstaged.map((e) => e.path), [git.unstaged]);
  const untrackedPaths = useMemo(() => git.untracked.map((e) => e.path), [git.untracked]);
  const canCommit = git.staged.length > 0 && message.trim().length > 0 && !busy;

  const doCommit = async () => {
    setBusy(true);
    const hash = await commitChanges(message);
    setBusy(false);
    if (hash) setMessage("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <BranchBar
        branch={git.branch}
        ahead={git.ahead}
        behind={git.behind}
        onPull={() => void pullChanges()}
        onPush={() => void pushChanges()}
        onRefresh={() => void refreshGit()}
      />

      <div className="space-y-1.5 border-b border-border px-2 py-2">
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={`Message (commit on ${git.branch ?? "HEAD"})`}
          rows={2}
          className="resize-none text-xs"
        />
        <Button
          size="sm"
          className="h-7 w-full text-xs"
          disabled={!canCommit}
          onClick={() => void doCommit()}
        >
          <Check className="mr-1 h-3.5 w-3.5" />
          Commit {git.staged.length > 0 ? `(${git.staged.length})` : ""}
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-1 py-1">
          <Section
            title="Conflicts"
            tone="destructive"
            entries={git.conflicts}
            actions={() => null}
          />
          <Section
            title="Staged Changes"
            entries={git.staged}
            staged
            onHeaderAction={
              git.staged.length > 0 ? () => void unstageFiles(stagedPaths) : undefined
            }
            headerActionIcon={Minus}
            headerActionLabel="Unstage all"
            actions={(e) => (
              <RowButton label="Unstage" onClick={() => void unstageFiles([e.path])}>
                <Minus className="h-3 w-3" />
              </RowButton>
            )}
          />
          <Section
            title="Changes"
            entries={git.unstaged}
            onHeaderAction={
              git.unstaged.length > 0 ? () => void stageFiles(unstagedPaths) : undefined
            }
            headerActionIcon={Plus}
            headerActionLabel="Stage all"
            actions={(e) => (
              <>
                <RowButton label="Discard" danger onClick={() => void discardFiles([e.path])}>
                  <RotateCcw className="h-3 w-3" />
                </RowButton>
                <RowButton label="Stage" onClick={() => void stageFiles([e.path])}>
                  <Plus className="h-3 w-3" />
                </RowButton>
              </>
            )}
          />
          <Section
            title="Untracked"
            entries={git.untracked}
            onHeaderAction={
              git.untracked.length > 0 ? () => void stageFiles(untrackedPaths) : undefined
            }
            headerActionIcon={Plus}
            headerActionLabel="Stage all"
            actions={(e) => (
              <>
                <RowButton label="Delete" danger onClick={() => void deleteEntry(e.path)}>
                  <Trash2 className="h-3 w-3" />
                </RowButton>
                <RowButton label="Stage" onClick={() => void stageFiles([e.path])}>
                  <Plus className="h-3 w-3" />
                </RowButton>
              </>
            )}
          />
          {git.staged.length +
            git.unstaged.length +
            git.untracked.length +
            git.conflicts.length ===
            0 && (
            <div className="px-2 py-6 text-center text-[11px] text-muted-foreground">
              No changes — working tree clean.
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function BranchBar({
  branch,
  ahead,
  behind,
  onPull,
  onPush,
  onRefresh,
}: {
  branch: string | null;
  ahead: number;
  behind: number;
  onPull: () => void;
  onPush: () => void;
  onRefresh: () => void;
}) {
  const listGitBranches = useApp((s) => s.listGitBranches);
  const checkoutBranch = useApp((s) => s.checkoutBranch);
  const createGitBranch = useApp((s) => s.createGitBranch);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const loadBranches = async () => setBranches(await listGitBranches());

  return (
    <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
      <DropdownMenu onOpenChange={(o) => o && void loadBranches()}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-accent"
            title="Switch branch"
          >
            <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate font-mono">{branch ?? "(detached)"}</span>
            {(ahead > 0 || behind > 0) && (
              <span className="ml-1 shrink-0 font-mono text-[10px] text-muted-foreground">
                {behind > 0 && `↓${behind}`}
                {ahead > 0 && `↑${ahead}`}
              </span>
            )}
            <ChevronDown className="ml-auto h-3 w-3 shrink-0 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          {branches.map((b) => (
            <DropdownMenuItem
              key={b.name}
              onSelect={() => !b.current && void checkoutBranch(b.name)}
              className="flex items-center gap-2"
            >
              {b.current ? <Check className="h-3.5 w-3.5 text-primary" /> : <span className="w-3.5" />}
              <span className="truncate font-mono text-xs">{b.name}</span>
            </DropdownMenuItem>
          ))}
          {branches.length > 0 && <DropdownMenuSeparator />}
          {creating ? (
            <div className="p-1">
              <Input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newName.trim()) {
                    void createGitBranch(newName.trim());
                    setNewName("");
                    setCreating(false);
                  } else if (e.key === "Escape") {
                    setCreating(false);
                  }
                }}
                placeholder="new branch name"
                className="h-6 font-mono text-[11px]"
              />
            </div>
          ) : (
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                setCreating(true);
              }}
            >
              <Plus className="mr-2 h-3.5 w-3.5" /> Create new branch…
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Button size="icon" variant="ghost" className="h-6 w-6" title="Pull" aria-label="Pull" onClick={onPull}>
        <CloudDownload className="h-3.5 w-3.5" />
      </Button>
      <Button size="icon" variant="ghost" className="h-6 w-6" title="Push" aria-label="Push" onClick={onPush}>
        <CloudUpload className="h-3.5 w-3.5" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-6 w-6"
        title="Refresh"
        aria-label="Refresh source control"
        onClick={onRefresh}
      >
        <RefreshCw className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function Section({
  title,
  tone,
  entries,
  staged,
  actions,
  onHeaderAction,
  headerActionIcon: HeaderIcon,
  headerActionLabel,
}: {
  title: string;
  tone?: "destructive";
  entries: GitEntry[];
  staged?: boolean;
  actions: (entry: GitEntry) => React.ReactNode;
  onHeaderAction?: () => void;
  headerActionIcon?: typeof Plus;
  headerActionLabel?: string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  if (entries.length === 0) return null;
  return (
    <div className="mb-1">
      <div className="group flex items-center gap-1 px-1 py-0.5">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
        >
          <ChevronRight className={cn("h-3 w-3 transition-transform", !collapsed && "rotate-90")} />
          <span className={cn(tone === "destructive" && "text-destructive")}>{title}</span>
          <Badge variant="muted" className="ml-1">
            {entries.length}
          </Badge>
        </button>
        {onHeaderAction && HeaderIcon && (
          <button
            type="button"
            onClick={onHeaderAction}
            title={headerActionLabel}
            aria-label={headerActionLabel}
            className="opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
          >
            <HeaderIcon className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        )}
      </div>
      {!collapsed && entries.map((e) => <FileRow key={`${title}:${e.path}`} entry={e} staged={!!staged} actions={actions} />)}
    </div>
  );
}

function FileRow({
  entry,
  staged,
  actions,
}: {
  entry: GitEntry;
  staged: boolean;
  actions: (entry: GitEntry) => React.ReactNode;
}) {
  const openFile = useApp((s) => s.openFile);
  const gitFileDiff = useApp((s) => s.gitFileDiff);
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);

  const toggleDiff = async () => {
    const next = !open;
    setOpen(next);
    if (next && diff === null) setDiff(await gitFileDiff(entry.path, staged));
  };

  const tone =
    entry.label === "Deleted"
      ? "text-destructive"
      : entry.label === "Added" || entry.label === "Untracked"
        ? "text-success"
        : entry.label === "Conflict"
          ? "text-destructive"
          : "text-warning";

  return (
    <div>
      <div className="group flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent/60">
        <button
          type="button"
          onClick={() => void toggleDiff()}
          className="text-muted-foreground"
          aria-label="Toggle diff"
        >
          <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
        </button>
        <button
          type="button"
          onClick={() => void openFile(entry.path)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          title={entry.path}
        >
          <span className="truncate font-mono text-[11px]">{basename(entry.path)}</span>
          <span className="truncate text-[10px] text-muted-foreground">{shortDir(entry.path)}</span>
          <span className={cn("ml-auto shrink-0 font-mono text-[10px]", tone)} title={entry.label}>
            {entry.label[0]}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
          {actions(entry)}
        </div>
      </div>
      {open && (
        <pre className="ml-4 mb-1 max-h-60 overflow-auto rounded border border-border/60 bg-card/40 p-1.5 text-[10.5px] leading-snug">
          {diff === null ? (
            <span className="text-muted-foreground">Loading diff…</span>
          ) : diff.trim() === "" ? (
            <span className="text-muted-foreground">No textual diff (new, binary, or untracked file).</span>
          ) : (
            diff.split("\n").map((line, i) => (
              <div
                key={i}
                className={cn(
                  "whitespace-pre font-mono",
                  line.startsWith("+") && !line.startsWith("+++") && "text-success",
                  line.startsWith("-") && !line.startsWith("---") && "text-destructive",
                  line.startsWith("@@") && "text-primary",
                  (line.startsWith("diff ") || line.startsWith("index ")) && "text-muted-foreground",
                )}
              >
                {line || " "}
              </div>
            ))
          )}
        </pre>
      )}
    </div>
  );
}

function shortDir(path: string): string {
  const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const dir = path.slice(0, path.lastIndexOf(sep));
  const parts = dir.split(sep).filter(Boolean);
  return parts.slice(-2).join(sep);
}

function RowButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent",
        danger ? "hover:text-destructive" : "hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
