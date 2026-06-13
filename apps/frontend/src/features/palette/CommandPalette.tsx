import { useEffect } from "react";
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
import { File, MessageSquare, Settings, Terminal as TerminalIcon, FileDiff, Palette } from "lucide-react";
import { useApp } from "@/lib/store";
import { MOCK_FILE_CONTENT } from "@/lib/mock-data";
import { SLASH_COMMANDS } from "@/lib/slash-commands";

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const toggle = useApp((s) => s.togglePalette);
  const openFile = useApp((s) => s.openFile);
  const setMainView = useApp((s) => s.setMainView);
  const setBottomTab = useApp((s) => s.setBottomTab);
  const sendUserMessage = useApp((s) => s.sendUserMessage);

  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && toggle(false);
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [open, toggle]);

  const close = () => toggle(false);

  return (
    <Dialog open={open} onOpenChange={toggle}>
      <DialogContent hideClose className="overflow-hidden p-0 sm:max-w-xl">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <Command label="Command Palette">
          <CommandInput placeholder="Type a command, file, or > for actions…" autoFocus />
          <CommandList>
            <CommandEmpty>No results.</CommandEmpty>
            <CommandGroup heading="Files">
              {Object.keys(MOCK_FILE_CONTENT).map((path) => (
                <CommandItem
                  key={path}
                  value={`file ${path}`}
                  onSelect={() => {
                    openFile(path);
                    close();
                  }}
                >
                  <File className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="font-mono text-xs">{path}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Agent">
              {SLASH_COMMANDS.map((c) => (
                <CommandItem
                  key={c.name}
                  value={`slash ${c.name}`}
                  onSelect={() => {
                    sendUserMessage(`/${c.name}`);
                    close();
                  }}
                >
                  <MessageSquare className="h-3.5 w-3.5 text-primary" />
                  <span className="font-mono text-xs">/{c.name}</span>
                  <span className="text-xs text-muted-foreground">{c.summary}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Views">
              <CommandItem
                value="view diff review"
                onSelect={() => {
                  setMainView("diff");
                  close();
                }}
              >
                <FileDiff className="h-3.5 w-3.5" />
                Open diff review
                <CommandShortcut>⌘⇧D</CommandShortcut>
              </CommandItem>
              <CommandItem
                value="view sessions"
                onSelect={() => {
                  setMainView("sessions");
                  close();
                }}
              >
                <MessageSquare className="h-3.5 w-3.5" />
                Sessions & history
              </CommandItem>
              <CommandItem
                value="view settings"
                onSelect={() => {
                  setMainView("settings");
                  close();
                }}
              >
                <Settings className="h-3.5 w-3.5" />
                Settings
                <CommandShortcut>⌘,</CommandShortcut>
              </CommandItem>
              <CommandItem
                value="view showcase"
                onSelect={() => {
                  setMainView("showcase");
                  close();
                }}
              >
                <Palette className="h-3.5 w-3.5" />
                Component showcase
              </CommandItem>
              <CommandItem
                value="terminal toggle"
                onSelect={() => {
                  setBottomTab("terminal");
                  close();
                }}
              >
                <TerminalIcon className="h-3.5 w-3.5" />
                Open terminal
                <CommandShortcut>⌘J</CommandShortcut>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
