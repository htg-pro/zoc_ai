/** Rules and steering editor — zoc-agent-chat-rebuild R30.1–R30.5. */
/** Feature: zoc-agent-chat-rebuild, task 34.1 (R30.1, R30.2, R30.3, R30.4, R30.5). */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, FileWarning, Loader2, Pencil } from "lucide-react";
import type { RuleDocument } from "@zoc-studio/shared-types";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { classifyRuleSources } from "@/lib/rules-sources";
import { fsWriteText } from "@/lib/tauri-bridge";
import { getWorkspaceServicesClient } from "@/lib/workspace-services-client";
import {
  completeEnableMap,
  displayedRuleError,
  enabledFor,
  persistRuleEdit,
  type RuleEnableMap,
} from "./rules-editor-model";

export interface RulesEditorProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly sessionId: string;
  readonly workspaceRoot: string | null;
  readonly enabled: RuleEnableMap;
  readonly onEnabledChange: (enabled: Record<string, boolean>) => void;
}

export function RulesEditor({
  open,
  onOpenChange,
  sessionId,
  workspaceRoot,
  enabled,
  onEnabledChange,
}: RulesEditorProps) {
  const [documents, setDocuments] = useState<readonly RuleDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<RuleDocument | null>(null);
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (sessionId.length === 0) return;
    setLoading(true);
    setLoadError(null);
    try {
      const client = await getWorkspaceServicesClient();
      const result = await client.getProjectRules(sessionId);
      setDocuments(result.documents);
      const complete = completeEnableMap(result.documents, enabled);
      if (JSON.stringify(complete) !== JSON.stringify(enabled)) onEnabledChange(complete);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "Project rules could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [sessionId, enabled, onEnabledChange]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const ordered = useMemo(() => {
    const byPath = new Map(documents.map((document) => [document.path, document]));
    return classifyRuleSources([...byPath.keys()]).flatMap((source) => {
      const document = byPath.get(source.path);
      return document === undefined ? [] : [{ source, document }];
    });
  }, [documents]);

  const save = async () => {
    if (editing === null || workspaceRoot === null) return;
    setSaving(true);
    setSaveMessage(null);
    const wrote = await persistRuleEdit({
      workspaceRoot,
      path: editing.path,
      content,
      write: fsWriteText,
    });
    if (!wrote) {
      setSaveMessage("The source could not be written to its workspace file.");
      setSaving(false);
      return;
    }
    setDocuments((current) =>
      current.map((document) =>
        document.path === editing.path ? { ...document, content, error: null } : document,
      ),
    );
    setEditing(null);
    setSaveMessage("Saved to the originating rules file.");
    setSaving(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl" data-zoc-rules-editor="">
        <DialogHeader>
          <DialogTitle>Rules and steering</DialogTitle>
          <DialogDescription>
            Enabled, valid sources are included in the next run in the precedence shown here.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 aria-hidden className="size-4 animate-spin" /> Discovering rules…
          </p>
        ) : null}
        {loadError === null ? null : (
          <p role="alert" className="text-sm text-[var(--zoc-error)]">
            {loadError}
          </p>
        )}

        {editing === null ? (
          <div className="max-h-[55vh] space-y-2 overflow-y-auto">
            {ordered.map(({ source, document }) => {
              const parseError = displayedRuleError(document);
              const active = enabledFor(document.path, enabled);
              return (
                <article
                  key={document.path}
                  className="rounded-[var(--zoc-radius-card)] border p-3"
                  style={{ borderColor: "var(--zoc-border)" }}
                  data-zoc-rule-source={document.path}
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      aria-label={`Include ${document.path} in the next run`}
                      checked={active}
                      onChange={(event) =>
                        onEnabledChange({ ...enabled, [document.path]: event.target.checked })
                      }
                      data-zoc-rule-enabled={String(active)}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="break-all text-xs">{document.path}</code>
                        <span className="rounded border px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                          {source.label}
                          {source.nested ? " · nested" : ""}
                        </span>
                      </div>
                      {parseError === null ? (
                        <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                          <Check aria-hidden className="size-3" /> Valid source
                        </p>
                      ) : (
                        <p
                          className="mt-1 flex items-start gap-1 text-xs text-[var(--zoc-error)]"
                          role="alert"
                        >
                          <FileWarning aria-hidden className="mt-0.5 size-3 shrink-0" />
                          Line {String(parseError.line)}, column {String(parseError.column)}:{" "}
                          {parseError.message}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      aria-label={`Edit ${document.path}`}
                      disabled={typeof document.content !== "string" || workspaceRoot === null}
                      onClick={() => {
                        setEditing(document);
                        setContent(document.content ?? "");
                        setSaveMessage(null);
                      }}
                      className="rounded p-1 hover:bg-[var(--zoc-row-bg)] disabled:opacity-40"
                    >
                      <Pencil aria-hidden className="size-3.5" />
                    </button>
                  </div>
                </article>
              );
            })}
            {!loading && ordered.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No rules sources were discovered.
              </p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-2">
            <code className="block break-all text-xs">{editing.path}</code>
            <textarea
              aria-label={`Rule content for ${editing.path}`}
              value={content}
              onChange={(event) => setContent(event.target.value)}
              className="h-[45vh] w-full resize-y rounded border border-border bg-background p-2 font-mono text-xs"
            />
            {displayedRuleError({ ...editing, content, error: null }) === null
              ? null
              : (() => {
                  const error = displayedRuleError({ ...editing, content, error: null });
                  return error === null ? null : (
                    <p role="alert" className="text-xs text-[var(--zoc-error)]">
                      Line {String(error.line)}, column {String(error.column)}: {error.message}
                    </p>
                  );
                })()}
            <DialogFooter>
              <Button variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button onClick={() => void save()} disabled={saving}>
                {saving ? "Saving…" : "Save source"}
              </Button>
            </DialogFooter>
          </div>
        )}

        {saveMessage === null ? null : (
          <p className="text-xs text-muted-foreground">{saveMessage}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function AppliedRulesSummary({ sources }: { readonly sources: readonly string[] }) {
  if (sources.length === 0) return null;
  return (
    <details
      className="shrink-0 border-b px-4 py-1 text-xs"
      style={{ borderColor: "var(--zoc-border)" }}
      data-zoc-applied-rules=""
    >
      <summary className="cursor-pointer text-muted-foreground">
        Rules applied · {String(sources.length)}
      </summary>
      <ul className="mt-1 list-inside list-disc font-mono text-[11px] text-muted-foreground">
        {sources.map((source) => (
          <li key={source}>{source}</li>
        ))}
      </ul>
    </details>
  );
}
