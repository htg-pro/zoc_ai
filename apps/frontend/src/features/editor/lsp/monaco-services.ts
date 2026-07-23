/**
 * One-time initialization of the `monaco-languageclient` VS Code service layer.
 *
 * `monaco-languageclient` v10 is built on `@codingame/monaco-vscode-api`. The
 * application therefore aliases `monaco-editor` to the matching Codingame
 * editor API and configures `@monaco-editor/react` to use that local module.
 * Initialization completes before the first editor is created, ensuring that
 * LSP providers and Monaco actions share one service registry and one Monaco
 * namespace.
 */
import type { OnMount } from "@monaco-editor/react";

type MonacoNamespace = Parameters<OnMount>[1];

let configuredMonaco: MonacoNamespace | null = null;
let capturedMonaco: MonacoNamespace | null = null;
let servicesPromise: Promise<void> | null = null;

/**
 * Record the namespace supplied to MonacoView's `onMount`. A mismatch means
 * the editor was created from a second Monaco build, in which case language
 * providers would register on the wrong instance.
 */
export function captureMonaco(monaco: MonacoNamespace): void {
  capturedMonaco ??= monaco;
  if (configuredMonaco !== null && configuredMonaco !== monaco) {
    console.warn(
      "monaco-lsp: the mounted editor is using a different Monaco instance; " +
        "language features may be unavailable.",
    );
  }
}

/** The Monaco namespace received from the mounted editor, if mounted. */
export function getCapturedMonaco(): MonacoNamespace | null {
  return capturedMonaco;
}

/**
 * Convert a workspace path into a canonical file URI for Monaco/LSP models.
 * Language servers return `file://` locations, so using the same URI scheme for
 * editor models is required for definition/reference navigation to find them.
 */
export function toMonacoModelUri(
  path: string,
  workspaceRoot: string | null = null,
): string {
  const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(path);
  if (!windowsAbsolute && /^[A-Za-z][A-Za-z\d+.-]*:/.test(path)) return path;

  const isAbsolute =
    path.startsWith("/") || windowsAbsolute || path.startsWith("\\\\");
  let resolved = path;
  if (!isAbsolute && workspaceRoot) {
    resolved = `${workspaceRoot.replace(/[\\/]+$/, "")}/${path.replace(/^[\\/]+/, "")}`;
  }

  const normalized = resolved.replace(/\\/g, "/");
  if (!normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized)) {
    return path;
  }

  if (normalized.startsWith("//")) {
    const [authority, ...segments] = normalized.slice(2).split("/");
    return `file://${encodeURIComponent(authority)}/${segments
      .map(encodeURIComponent)
      .join("/")}`;
  }

  const withLeadingSlash = /^[A-Za-z]:\//.test(normalized)
    ? `/${normalized}`
    : normalized;
  const encodedPath = withLeadingSlash
    .split("/")
    .map((segment) => (/^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join("/");
  return `file://${encodedPath}`;
}

/**
 * Initialize the shared VS Code services exactly once. Repeated callers receive
 * the same in-flight/settled promise, so multiple language servers cannot race
 * initialization.
 */
export function ensureServicesInitialized(): Promise<void> {
  servicesPromise ??= initServices();
  return servicesPromise;
}

async function initServices(): Promise<void> {
  try {
    const [{ loader }, monacoModule, { MonacoVscodeApiWrapper }] = await Promise.all([
      import("@monaco-editor/react"),
      import("monaco-editor"),
      import("monaco-languageclient/vscodeApiWrapper"),
    ]);

    const monaco = monacoModule as unknown as MonacoNamespace;
    configuredMonaco = monaco;
    loader.config({ monaco });

    const wrapper = new MonacoVscodeApiWrapper({
      $type: "classic",
      viewsConfig: { $type: "EditorService" },
    });
    await wrapper.start({ caller: "monaco-lsp-integration" });

    // The ESM-compatible editor API is intentionally minimal; load the Monaco
    // contributions that expose the requested built-in actions and keybindings.
    await Promise.all([
      import(
        "@codingame/monaco-vscode-api/vscode/vs/editor/contrib/gotoSymbol/browser/goToCommands"
      ),
      import(
        "@codingame/monaco-vscode-api/vscode/vs/editor/contrib/rename/browser/rename"
      ),
      // @ts-expect-error Pinned package ships this side-effect module with an empty .d.ts.
      import("@codingame/monaco-vscode-api/vscode/vs/editor/contrib/hover/browser/hoverContribution"),
    ]);
  } catch (err) {
    console.warn(
      "monaco-lsp: VS Code services failed to initialize; editor LSP features are unavailable.",
      err,
    );
    throw err;
  }
}

/** Test-only reset of the module singletons. */
export function __resetMonacoServicesForTests(): void {
  configuredMonaco = null;
  capturedMonaco = null;
  servicesPromise = null;
}
