import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import {
  AlertTriangle,
  ArrowUpToLine,
  Blocks,
  Bug,
  Check,
  ChevronRight,
  Command as CommandIcon,
  CornerDownRight,
  Database,
  File,
  FileDiff,
  Files,
  FlaskConical,
  Folder,
  GitBranch,
  Hammer,
  Hash,
  History,
  ListChecks,
  ListTree,
  Map as MapIcon,
  MessageCircleQuestion,
  MessagesSquare,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Save,
  Search,
  Settings,
  ShieldAlert,
  SplitSquareHorizontal,
  Terminal as TerminalIcon,
  Undo2,
  WandSparkles,
  X,
  Zap,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
} from "@/components/ui/command";
import { useApp } from "@/lib/store";
import {
  formatKeybinding,
  getCommands,
  isCommandEnabled,
  runCommand,
  type Command as AppCommand,
} from "@/lib/commands";
import { recentFiles } from "@/lib/recents";
import { cn } from "@/lib/utils";
import type { ContextCandidate } from "@zoc-studio/shared-types";

const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  AlertTriangle,
  ArrowUpToLine,
  Blocks,
  Bug,
  Check,
  ChevronRight,
  Command: CommandIcon,
  CornerDownRight,
  Database,
  File,
  FileDiff,
  Files,
  FlaskConical,
  Folder,
  GitBranch,
  Hammer,
  Hash,
  History,
  ListChecks,
  ListTree,
  Map: MapIcon,
  MessageCircleQuestion,
  MessagesSquare,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Save,
  Search,
  Settings,
  ShieldAlert,
  SplitSquareHorizontal,
  Terminal: TerminalIcon,
  Undo2,
  WandSparkles,
  X,
  Zap,
};

function Icon({ name, className }: { name?: string; className?: string }) {
  const C = (name && ICONS[name]) || File;
  return <C className={className} />;
}

type Mode = "command" | "symbol" | "file";

function modeOf(query: string): { mode: Mode; term: string } {
  if (query.startsWith(">")) return { mode: "command", term: query.slice(1).trim() };
  if (query.startsWith("@")) return { mode: "symbol", term: query.slice(1).trim() };
  return { mode: "file", term: query.trim() };
}

function matchesCommand(cmd: AppCommand, term: string): boolean {
  if (!term) return true;
  const q = term.toLowerCase();
  return (
    cmd.title.toLowerCase().includes(q) ||
    cmd.category.toLowerCase().includes(q) ||
    cmd.id.toLowerCase().includes(q) ||
    (cmd.aliases ?? []).some((a) => a.toLowerCase().includes(q))
  );
}

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const seed = useApp((s) => s.paletteSeed);
  const toggle = useApp((s) => s.togglePalette);
  const openFile = useApp((s) => s.openFile);
  const searchContext = useApp((s) => s.searchContextCandidates);
  const appState = useApp;

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ContextCandidate[]>([]);
  const [loading, setLoading] = useState(false);

  // Seed the input from the mode prefix each time the palette opens.
  useEffect(() => {
    if (open) setQuery(seed);
  }, [open, seed]);

  const { mode, term } = useMemo(() => modeOf(query), [query]);

  // Live workspace search for file / symbol modes (debounced). Never reads
  // mock data: the store's searchContextCandidates only falls back to open
  // files when the sidecar is unavailable.
  const reqId = useRef(0);
  useEffect(() => {
    if (!open || mode === "command") {
      setResults([]);
      return;
    }
    if (!term) {
      setResults([]);
      setLoading(false);
      return;
    }
    const id = ++reqId.current;
    setLoading(true);
    const t = setTimeout(async () => {
      const out = await searchContext(term);
      if (id !== reqId.current) return; // a newer query superseded this one
      setResults(out);
      setLoading(false);
    }, 140);
    return () => clearTimeout(t);
  }, [open, mode, term, searchContext]);

  const close = () => toggle(false);

  const commands = useMemo(() => getCommands().filter((c) => matchesCommand(c, term)), [term]);
  const recents = useMemo(() => (open ? recentFiles() : []), [open]);

  const fileResults = mode === "symbol" ? results.filter((r) => r.kind === "symbol") : results;

  return (
    <Dialog open={open} onOpenChange={toggle}>
      <DialogContent hideClose className="overflow-hidden p-0 sm:max-w-xl">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <Command label="Command Palette" shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search files by name, > for commands, @ for symbols…"
            autoFocus
          />
          <CommandList>
            {mode === "command" ? (
              <CommandModeList commands={commands} onRun={(id) => void runCommand(id).then(close)} getState={appState.getState} />
            ) : (
              <>
                {loading && (
                  <div className="px-3 py-2 text-xs text-muted-foreground">Searching…</div>
                )}
                {!term && recents.length > 0 && (
                  <CommandGroup heading="Recent files">
                    {recents.map((path) => (
                      <CommandItem
                        key={`recent-${path}`}
                        value={`recent ${path}`}
                        onSelect={() => {
                          void openFile(path);
                          close();
                        }}
                      >
                        <History className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="truncate font-mono text-xs">{path}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                {fileResults.length > 0 && (
                  <CommandGroup heading={mode === "symbol" ? "Symbols" : "Files"}>
                    {fileResults.map((c) => (
                      <CommandItem
                        key={`${c.kind}-${c.path}-${c.line ?? ""}-${c.label}`}
                        value={`${c.kind} ${c.path} ${c.label}`}
                        onSelect={() => {
                          void openFile(c.path);
                          close();
                        }}
                      >
                        <Icon
                          name={c.kind === "folder" ? "Folder" : c.kind === "symbol" ? "Hash" : "File"}
                          className="h-3.5 w-3.5 text-muted-foreground"
                        />
                        <span className="truncate font-mono text-xs">{c.label}</span>
                        {c.detail && (
                          <span className="ml-auto truncate text-[10px] text-muted-foreground">
                            {c.detail}
                          </span>
                        )}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                {!loading && term && fileResults.length === 0 && (
                  <CommandEmpty>No {mode === "symbol" ? "symbols" : "files"} match “{term}”.</CommandEmpty>
                )}
                <CommandSeparator />
                <CommandGroup heading="Commands">
                  <CommandItem
                    value="show all commands"
                    onSelect={() => setQuery(">")}
                  >
                    <CommandIcon className="h-3.5 w-3.5 text-primary" />
                    Show all commands
                    <CommandShortcut>type &gt;</CommandShortcut>
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function CommandModeList({
  commands,
  onRun,
  getState,
}: {
  commands: AppCommand[];
  onRun: (id: string) => void;
  getState: () => ReturnType<typeof useApp.getState>;
}) {
  const mac = undefined; // formatKeybinding auto-detects platform
  const state = getState();
  const byCategory = useMemo(() => {
    const groups = new Map<string, AppCommand[]>();
    for (const c of commands) {
      const arr = groups.get(c.category) ?? [];
      arr.push(c);
      groups.set(c.category, arr);
    }
    return [...groups.entries()];
  }, [commands]);

  if (commands.length === 0) return <CommandEmpty>No matching commands.</CommandEmpty>;

  return (
    <>
      {byCategory.map(([category, cmds], gi) => (
        <div key={category}>
          {gi > 0 && <CommandSeparator />}
          <CommandGroup heading={category}>
            {cmds.map((cmd) => {
              const enabled = isCommandEnabled(cmd, state);
              const reason = !enabled && cmd.disabledReason ? cmd.disabledReason(state) : null;
              return (
                <CommandItem
                  key={cmd.id}
                  value={`cmd ${cmd.id} ${cmd.title} ${(cmd.aliases ?? []).join(" ")}`}
                  disabled={!enabled}
                  onSelect={() => enabled && onRun(cmd.id)}
                  className={cn(!enabled && "opacity-50")}
                >
                  <Icon name={cmd.icon} className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs">{cmd.title}</span>
                  {reason ? (
                    <span className="ml-auto truncate text-[10px] text-muted-foreground" title={reason}>
                      {reason}
                    </span>
                  ) : cmd.keybinding ? (
                    <CommandShortcut>{formatKeybinding(cmd.keybinding, mac)}</CommandShortcut>
                  ) : null}
                </CommandItem>
              );
            })}
          </CommandGroup>
        </div>
      ))}
    </>
  );
}
