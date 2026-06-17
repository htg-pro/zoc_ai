import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Code2, RotateCcw, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Kbd } from "@/components/ui/kbd";
import { toast } from "@/components/ui/toast";
import {
  eventToKeybinding,
  formatKeybinding,
  getCommands,
  type Command,
} from "@/lib/commands";
import {
  detectConflicts,
  effectiveKeybinding,
  exportKeybindings,
  loadOverrides,
  parseKeybindingsJson,
  resetAllOverrides,
  resetOverride,
  saveOverrides,
  setOverride,
  subscribeKeybindings,
  wouldConflict,
} from "@/lib/keybinding-overrides";
import { cn } from "@/lib/utils";

/**
 * Keybindings editor (Phase 10). Lists every command, lets the user record a
 * new chord (capturing the next keystroke), flags conflicts, and exposes a raw
 * JSON editor for power users.
 */
export function KeybindingsSection() {
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<string | null>(null);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => subscribeKeybindings(() => setTick((n) => n + 1)), []);

  const commands = getCommands();
  const overrides = loadOverrides();
  const conflicts = useMemo(() => detectConflicts(commands, overrides), [commands, overrides]);
  const conflictChords = new Set(conflicts.map((c) => c.chord));

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) =>
      `${c.title} ${c.id} ${c.category} ${c.aliases?.join(" ") ?? ""}`.toLowerCase().includes(q),
    );
  }, [commands, query]);

  // While recording, capture the next chord and assign it.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      const chord = eventToKeybinding(e);
      if (!chord) return; // wait for a chord with a modifier
      e.preventDefault();
      const clash = wouldConflict(commands, recording, chord);
      setOverride(recording, chord);
      setRecording(null);
      if (clash.length > 0) {
        toast.error("Keybinding conflict", {
          description: `${formatKeybinding(chord)} is also bound to ${clash.join(", ")}.`,
        });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, commands]);

  return (
    <div className="space-y-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Keyboard Shortcuts</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Click a binding to record a new chord. Changes persist across restarts.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setJsonOpen((v) => !v)}>
            <Code2 className="mr-1.5 h-3.5 w-3.5" />
            {jsonOpen ? "Close JSON" : "Edit JSON"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              resetAllOverrides();
              toast.success("Keybindings reset to defaults");
            }}
          >
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            Reset all
          </Button>
        </div>
      </header>

      {conflicts.length > 0 && (
        <div className="flex items-start gap-2 rounded border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>
            {conflicts.length} conflicting {conflicts.length === 1 ? "binding" : "bindings"}:{" "}
            {conflicts.map((c) => formatKeybinding(c.chord)).join(", ")}
          </div>
        </div>
      )}

      {jsonOpen && <JsonEditor />}

      <Input
        placeholder="Search commands…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="h-8"
      />

      <Card>
        <CardHeader>
          <CardTitle>Commands ({filtered.length})</CardTitle>
        </CardHeader>
        <CardContent className="divide-y divide-border/60 p-0">
          {filtered.map((cmd) => (
            <KeybindingRow
              key={cmd.id}
              cmd={cmd}
              chord={effectiveKeybinding(cmd, overrides)}
              hasOverride={cmd.id in overrides}
              recording={recording === cmd.id}
              conflicting={
                !!effectiveKeybinding(cmd, overrides) &&
                conflictChords.has(effectiveKeybinding(cmd, overrides) as string)
              }
              onRecord={() => setRecording(cmd.id)}
              onCancel={() => setRecording(null)}
              onUnbind={() => setOverride(cmd.id, null)}
              onReset={() => resetOverride(cmd.id)}
            />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function KeybindingRow({
  cmd,
  chord,
  hasOverride,
  recording,
  conflicting,
  onRecord,
  onCancel,
  onUnbind,
  onReset,
}: {
  cmd: Command;
  chord: string | undefined;
  hasOverride: boolean;
  recording: boolean;
  conflicting: boolean;
  onRecord: () => void;
  onCancel: () => void;
  onUnbind: () => void;
  onReset: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2">
      <div className="min-w-0">
        <div className="truncate text-[13px]">{cmd.title}</div>
        <code className="text-[10px] text-muted-foreground/70">{cmd.id}</code>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {recording ? (
          <span className="flex items-center gap-1.5 text-xs text-primary">
            <span className="animate-pulse">Press keys…</span>
            <Button size="icon" variant="ghost" className="h-6 w-6" onClick={onCancel}>
              <X className="h-3 w-3" />
            </Button>
          </span>
        ) : (
          <button
            type="button"
            onClick={onRecord}
            className={cn(
              "min-w-[5rem] rounded border px-2 py-1 text-center transition-colors hover:border-primary/60",
              conflicting ? "border-warning/60 bg-warning/10" : "border-border",
            )}
            title="Record new keybinding"
          >
            {chord ? <Kbd>{formatKeybinding(chord)}</Kbd> : <span className="text-xs text-muted-foreground">Unbound</span>}
          </button>
        )}
        {chord && !recording && (
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            title="Unbind"
            aria-label={`Unbind ${cmd.title}`}
            onClick={onUnbind}
          >
            <X className="h-3 w-3" />
          </Button>
        )}
        {hasOverride && (
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            title="Reset to default"
            aria-label={`Reset ${cmd.title}`}
            onClick={onReset}
          >
            <RotateCcw className="h-3 w-3" />
          </Button>
        )}
      </div>
    </div>
  );
}

function JsonEditor() {
  const [text, setText] = useState(() => exportKeybindings());
  const [error, setError] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">keybindings.json</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          className="font-mono text-xs"
          spellCheck={false}
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setText(exportKeybindings())}>
            Revert
          </Button>
          <Button
            size="sm"
            onClick={() => {
              try {
                saveOverrides(parseKeybindingsJson(text));
                setError(null);
                toast.success("Keybindings updated");
              } catch {
                setError("Invalid JSON — check the syntax.");
              }
            }}
          >
            <Check className="mr-1.5 h-3.5 w-3.5" />
            Apply
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
