/**
 * LSP_Diagnostics_Bridge (design.md §3.2, Requirements 1, 2, 5, 7).
 *
 * The net-new bridge that intercepts each `textDocument/publishDiagnostics`
 * notification the language client parses, maps every LSP diagnostic onto the
 * existing `Diagnostic` model (`@/lib/problem-matchers`), and writes them into
 * the existing `diagnostics` store under a per-URI `lsp:<uri>` key so LSP
 * findings coexist with the command-checker diagnostics without overwriting
 * each other.
 *
 * This module is split into a **pure core** (mapping + key helpers +
 * deleted-file key selection) and a small **effectful factory**
 * (`createDiagnosticsBridge`) that composes the pure core with injected store
 * actions and the `onFsChanged`/`fsStat` desktop seams. The pure core is
 * dependency-light so it is unit- and property-testable without Monaco, a DOM,
 * or a Tauri runtime.
 */

import type { Diagnostic, Severity } from "@/lib/problem-matchers";
import type { ServerName } from "./lsp-registry";

/**
 * The minimal shape of an LSP diagnostic as parsed by `vscode-languageclient`
 * before it reaches the `handleDiagnostics` middleware. Only the fields the
 * bridge maps are modeled; anything else on the wire object is ignored.
 */
export interface LspDiagnostic {
  range: { start: { line: number; character: number }; end?: unknown };
  /** 1 Error, 2 Warning, 3 Info, 4 Hint (LSP `DiagnosticSeverity`). */
  severity?: 1 | 2 | 3 | 4;
  message: string;
  source?: string;
  code?: string | number | { value: string | number };
}

/** R2.1: the per-URI store-key prefix, distinct from every Command_Checker key. */
export const LSP_SOURCE_PREFIX = "lsp:";

/** R2.1: the per-document store key for a URI (`lsp:<uri>`). */
export function lspSourceKey(uri: string): string {
  return `${LSP_SOURCE_PREFIX}${uri}`;
}

/** Whether a Diagnostics_Store key is an LSP per-URI entry (vs. a checker key). */
export function isLspSourceKey(key: string): boolean {
  return key.startsWith(LSP_SOURCE_PREFIX);
}

/**
 * R1.2/R1.3: map an LSP severity integer to a `Diagnostic` severity. A missing
 * (or unrecognized) severity defaults to `error`, so a diagnostic is never
 * silently downgraded or dropped.
 */
export function mapSeverity(sev?: number): Severity {
  switch (sev) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "info";
    case 4:
      return "hint";
    default:
      return "error";
  }
}

function decodeSegments(value: string): string {
  return value
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}

/**
 * R1.5: convert a `file:` document URI to an absolute filesystem path — the
 * inverse of `toMonacoModelUri` (`monaco-services.ts`). Handles POSIX
 * (`file:///a/b`), Windows (`file:///C:/a/b`), and UNC (`file://host/share`)
 * forms with percent-decoding. A non-`file:` URI (or one that cannot be
 * converted) is passed through unchanged so the diagnostic still renders and
 * groups deterministically rather than being dropped.
 */
export function uriToFsPath(uri: string): string {
  if (!uri.startsWith("file:")) return uri;

  let rest = uri.slice("file:".length);
  if (rest.startsWith("//")) rest = rest.slice(2);

  let authority = "";
  let pathPart: string;
  if (rest.startsWith("/")) {
    pathPart = rest;
  } else {
    const slash = rest.indexOf("/");
    if (slash === -1) {
      authority = rest;
      pathPart = "";
    } else {
      authority = rest.slice(0, slash);
      pathPart = rest.slice(slash);
    }
  }

  let path = decodeSegments(pathPart);
  // Windows drive letter: `/C:/a/b` → `C:/a/b`.
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);

  let decodedAuthority = authority;
  try {
    decodedAuthority = decodeURIComponent(authority);
  } catch {
    /* keep raw authority */
  }
  if (decodedAuthority) return `//${decodedAuthority}${path}`;
  return path;
}

/** R1.5/R1.7: render an LSP `code` (string, number, or `{ value }`) as a string. */
function codeToString(code: LspDiagnostic["code"]): string | undefined {
  if (code === undefined || code === null) return undefined;
  if (typeof code === "string") return code;
  if (typeof code === "number") return String(code);
  if (typeof code === "object" && "value" in code) return String(code.value);
  return undefined;
}

/**
 * R1.1/R1.4/R1.5/R1.6/R1.7: map one LSP diagnostic to one `Diagnostic` entry.
 *
 * - `line`/`column` are the LSP 0-based `range.start` plus one (1-based).
 * - `file` is the absolute path the notification `uri` identifies.
 * - `message` is verbatim.
 * - `source` is the diagnostic's own `source`, falling back to the Server_Name.
 * - `code` is `String(code)` when present, and left unset when absent.
 */
export function mapLspDiagnostic(
  server: ServerName,
  uri: string,
  d: LspDiagnostic,
): Diagnostic {
  const code = codeToString(d.code);
  const diagnostic: Diagnostic = {
    source: d.source && d.source.length > 0 ? d.source : server,
    file: uriToFsPath(uri),
    line: d.range.start.line + 1,
    column: d.range.start.character + 1,
    severity: mapSeverity(d.severity),
    message: d.message,
  };
  if (code !== undefined) diagnostic.code = code;
  return diagnostic;
}

/** R1.1: map every diagnostic in a publish notification (length preserved). */
export function mapPublishedDiagnostics(
  server: ServerName,
  uri: string,
  diags: readonly LspDiagnostic[],
): Diagnostic[] {
  return diags.map((d) => mapLspDiagnostic(server, uri, d));
}

/**
 * R5.2–R5.4 (pure): given the current store and a set of confirmed-deleted
 * paths, return the `lsp:*` keys to clear — exactly those whose entries carry a
 * diagnostic whose `file` is a deleted path. Never returns a Command_Checker
 * key, and never returns a key whose entries reference only still-existing
 * paths.
 */
export function lspKeysForDeletedFiles(
  diagnostics: Record<string, Diagnostic[]>,
  deletedPaths: ReadonlySet<string>,
): string[] {
  const keys: string[] = [];
  for (const [key, items] of Object.entries(diagnostics)) {
    if (!isLspSourceKey(key)) continue;
    if (items.some((d) => deletedPaths.has(d.file))) keys.push(key);
  }
  return keys;
}

// ── Effectful bridge ─────────────────────────────────────────────────────────

/** The injected store actions and desktop seams the bridge composes. */
export interface DiagnosticsBridgeDeps {
  setDiagnostics: (source: string, items: Diagnostic[]) => void;
  clearDiagnostics: (source?: string) => void;
  getDiagnostics: () => Record<string, Diagnostic[]>;
  onFsChanged: (cb: (paths: string[]) => void) => Promise<() => void>;
  fsStat: (path: string) => Promise<{ exists: boolean } | null>;
}

export interface DiagnosticsBridge {
  /** Wired as `LspClientDeps.onPublishDiagnostics` (R1, R2). */
  onPublishDiagnostics(
    server: ServerName,
    uri: string,
    diags: readonly LspDiagnostic[],
  ): void;
  /** R5.5: stop reacting to fs events and leave the store unchanged after. */
  dispose(): void;
}

/**
 * Compose the pure core with the store actions and the `onFsChanged`/`fsStat`
 * desktop seams (design.md §3.2).
 *
 * - `onPublishDiagnostics` writes under the single `lsp:<uri>` key — a
 *   non-empty publish replaces that URI's entry (R2.2), an empty publish clears
 *   it (R2.5); every other `lsp:*` entry and every Command_Checker entry is left
 *   untouched (R2.3/R2.4) because the store actions mutate one key.
 * - On construction the bridge subscribes to `onFsChanged` (R5.1). For each
 *   reported path it confirms deletion via `fsStat(path).exists === false`
 *   (a `null` stat — browser preview — cannot confirm deletion, R5.3), then
 *   clears exactly the `lsp:*` entries referencing a deleted path (R5.2/R5.4).
 * - `dispose()` invokes the `onFsChanged` unsubscribe and ignores any later
 *   event, leaving the store unchanged (R5.5).
 */
export function createDiagnosticsBridge(deps: DiagnosticsBridgeDeps): DiagnosticsBridge {
  let disposed = false;
  let unsubscribe: (() => void) | null = null;

  const handleFsChanged = (paths: string[]): void => {
    if (disposed || paths.length === 0) return;
    void (async () => {
      const deleted = new Set<string>();
      for (const path of paths) {
        let stat: { exists: boolean } | null = null;
        try {
          stat = await deps.fsStat(path);
        } catch {
          stat = null;
        }
        if (stat && stat.exists === false) deleted.add(path);
      }
      if (disposed || deleted.size === 0) return;
      for (const key of lspKeysForDeletedFiles(deps.getDiagnostics(), deleted)) {
        deps.clearDiagnostics(key);
      }
    })();
  };

  void Promise.resolve(deps.onFsChanged(handleFsChanged))
    .then((off) => {
      if (disposed) {
        off();
        return;
      }
      unsubscribe = off;
    })
    .catch(() => {
      /* no desktop runtime — fs cleanup is a no-op (R5.3) */
    });

  return {
    onPublishDiagnostics(server, uri, diags) {
      if (disposed) return;
      const key = lspSourceKey(uri);
      if (diags.length > 0) {
        deps.setDiagnostics(key, mapPublishedDiagnostics(server, uri, diags));
      } else {
        deps.clearDiagnostics(key);
      }
    },
    dispose() {
      disposed = true;
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    },
  };
}
