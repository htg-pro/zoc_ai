/**
 * Editor LSP lifecycle hook (design.md "Editor feature wiring").
 *
 * Constructs the `LSP_Client` + store-subscribed `LSP_Registry` once when the
 * editor mounts and tears them down on unmount. The registry reconciles running
 * language servers against `store.openFiles` (R2.2, R2.4); the client reports
 * per-server state into the status slice (R5.7) and clears it on shutdown
 * (R5.6). Providers register only on a connected server, gating the editor
 * language features (R4.5, R4.6).
 */
import { useEffect } from "react";
import { useApp } from "@/lib/store";
import { onFsChanged, fsStat } from "@/lib/tauri-bridge";
import { createDiagnosticsBridge } from "./lsp/diagnostics-bridge";
import { createLspClient } from "./lsp/lsp-client";
import { createLspRegistry } from "./lsp/lsp-registry";
import { ensureServicesInitialized } from "./lsp/monaco-services";

export function useLspLifecycle(): void {
  useEffect(() => {
    // Store actions are stable identities, so reading them once here keeps the
    // effect single-run (mount → unmount).
    const { setServerState, removeServer, setDiagnostics, clearDiagnostics } = useApp.getState();

    // §3.2: the LSP_Diagnostics_Bridge maps published diagnostics into the
    // per-URI `lsp:*` store entries and clears them for deleted files (R1, R5).
    const bridge = createDiagnosticsBridge({
      setDiagnostics,
      clearDiagnostics,
      getDiagnostics: () => useApp.getState().diagnostics,
      onFsChanged,
      fsStat: async (path) => {
        const stat = await fsStat(path);
        return stat ? { exists: stat.exists } : null;
      },
    });

    const client = createLspClient({
      ensureServicesInitialized, // uses the Monaco instance captured in MonacoView
      onServerState: setServerState, // writes the status slice (R5.7)
      onServerRemoved: removeServer, // clears the status entry (R5.6)
      onPublishDiagnostics: bridge.onPublishDiagnostics, // §3.2 R1
    });
    const registry = createLspRegistry(client); // subscribes to store.openFiles
    return () => {
      registry.dispose();
      bridge.dispose(); // R5.5: ignore fs events after teardown
    };
  }, []);
}
