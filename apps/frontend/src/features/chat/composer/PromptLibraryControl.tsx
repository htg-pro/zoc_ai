/** Feature: zoc-agent-chat-rebuild, task 32.1 (R28.1, R28.2, R28.4, R28.5). */
import { useMemo, useState } from "react";
import { BookOpen, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { validateMessage } from "@/lib/composer-validate";
import {
  loadPromptLibrary,
  matchesPromptSearch,
  persistPromptLibrary,
  placeholdersOf,
  substitutePrompt,
  type PromptStorage,
  type SavedPrompt,
} from "./prompt-library";

interface EditorState {
  readonly id: string | null;
  readonly name: string;
  readonly content: string;
}

export interface PromptLibraryControlProps {
  composerValue: string;
  onInsert(value: string): void;
  storage?: PromptStorage | null;
  requestPlaceholder?: (name: string) => string | null;
}

const browserStorage = (): PromptStorage | null =>
  typeof window === "undefined" ? null : window.localStorage;

export function PromptLibraryControl({
  composerValue,
  onInsert,
  storage = browserStorage(),
  requestPlaceholder = (name) => window.prompt(`Value for ${name}`),
}: PromptLibraryControlProps) {
  const [open, setOpen] = useState(false);
  const [prompts, setPrompts] = useState<SavedPrompt[]>(() => loadPromptLibrary(storage));
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SavedPrompt | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const visible = useMemo(
    () => prompts.filter((prompt) => matchesPromptSearch(prompt, query)),
    [prompts, query],
  );

  const commit = (next: SavedPrompt[]) => {
    setPrompts(next);
    persistPromptLibrary(storage, next);
  };

  const insert = (prompt: SavedPrompt) => {
    const values: Record<string, string> = {};
    for (const name of placeholdersOf(prompt.content)) {
      const value = requestPlaceholder(name);
      if (value === null) return;
      values[name] = value;
    }
    onInsert(substitutePrompt(prompt.content, values));
    setOpen(false);
  };

  const saveEditor = () => {
    if (editor === null || editor.name.trim().length === 0) {
      setMessage("A prompt name is required.");
      return;
    }
    const verdict = validateMessage(editor.content);
    if (!verdict.valid) {
      setMessage(
        verdict.reason === "empty" ? "Prompt content is required." : "Prompt content is too long.",
      );
      return;
    }
    const now = new Date().toISOString();
    const id = editor.id ?? globalThis.crypto?.randomUUID?.() ?? `prompt-${String(Date.now())}`;
    const next = [
      { id, name: editor.name.trim(), content: editor.content, updatedAt: now },
      ...prompts.filter((prompt) => prompt.id !== id),
    ];
    commit(next);
    setEditor(null);
    setMessage(null);
  };

  return (
    <>
      <button
        type="button"
        aria-label="Open prompt library"
        data-zoc-prompt-library=""
        onClick={() => setOpen(true)}
        className="inline-flex size-7 items-center justify-center rounded-[var(--zoc-radius-chip)] hover:bg-[var(--zoc-row-bg)]"
        style={{ color: "var(--zoc-text-muted)" }}
      >
        <BookOpen aria-hidden className="size-3.5" />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-zoc-prompt-library-dialog="" className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Prompt library</DialogTitle>
            <DialogDescription>
              Save reusable prompts. Use {"{{name}}"} for values requested on insert.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2 rounded border border-border px-2">
            <Search aria-hidden className="size-3.5 text-muted-foreground" />
            <input
              aria-label="Search saved prompts"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none"
              placeholder="Search prompts"
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEditor({ id: null, name: "", content: composerValue })}
            >
              <Plus className="mr-1 size-3.5" /> Save current
            </Button>
          </div>

          {message === null ? null : <p className="text-xs text-[var(--zoc-error)]">{message}</p>}

          {editor === null ? (
            <ul className="max-h-72 space-y-1 overflow-y-auto" role="list">
              {visible.map((prompt) => (
                <li
                  key={prompt.id}
                  className="flex items-start gap-2 rounded border border-border px-2 py-1.5"
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => insert(prompt)}
                  >
                    <span className="block truncate text-sm font-medium">{prompt.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {prompt.content}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Edit ${prompt.name}`}
                    onClick={() =>
                      setEditor({ id: prompt.id, name: prompt.name, content: prompt.content })
                    }
                  >
                    <Pencil aria-hidden className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${prompt.name}`}
                    onClick={() => setDeleteTarget(prompt)}
                  >
                    <Trash2 aria-hidden className="size-3.5" />
                  </button>
                </li>
              ))}
              {visible.length === 0 ? (
                <li className="py-6 text-center text-sm text-muted-foreground">
                  No matching prompts.
                </li>
              ) : null}
            </ul>
          ) : (
            <div className="space-y-2">
              <input
                aria-label="Prompt name"
                className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
                value={editor.name}
                onChange={(event) => setEditor({ ...editor, name: event.target.value })}
              />
              <textarea
                aria-label="Prompt content"
                className="h-36 w-full resize-y rounded border border-border bg-background px-2 py-1 text-sm"
                value={editor.content}
                onChange={(event) => setEditor({ ...editor, content: event.target.value })}
              />
              <DialogFooter>
                <Button variant="ghost" onClick={() => setEditor(null)}>
                  Cancel
                </Button>
                <Button onClick={saveEditor}>Save prompt</Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null);
        }}
      >
        <DialogContent data-zoc-prompt-delete-confirm="">
          <DialogHeader>
            <DialogTitle>Delete saved prompt?</DialogTitle>
            <DialogDescription>
              {deleteTarget?.name} will be removed from this device.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteTarget !== null)
                  commit(prompts.filter((prompt) => prompt.id !== deleteTarget.id));
                setDeleteTarget(null);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
