import { useCallback, useEffect, useMemo, useState } from "react";
import { Globe, Plug, Plus, RefreshCw, Terminal as TerminalIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useApp } from "@/lib/store";
import { fsCreateDir, fsReadText, fsWriteText, isTauri } from "@/lib/tauri-bridge";
import { joinPath } from "@/lib/paths";
import {
  loadMcpServers,
  upsertWorkspaceServer,
  type McpServer,
  type McpTransport,
} from "@/lib/mcp-config";
import {
  fetchMcpServers,
  reloadMcp,
  testMcpServer,
  type McpRuntimeStatus,
  type McpServerStatus,
} from "@/lib/mcp-client";

const TRANSPORT_ICON: Record<McpTransport, typeof Plug> = {
  stdio: TerminalIcon,
  sse: Globe,
  http: Globe,
};

const STATUS_TONE: Record<McpRuntimeStatus, string> = {
  running: "text-[var(--zoc-success)]",
  stopped: "text-muted-foreground",
  error: "text-[var(--zoc-error)]",
};

interface DraftState {
  original: string | null; // id being edited, or null when adding
  id: string;
  transport: McpTransport;
  command: string;
  args: string;
  env: string;
  url: string;
  autoApprove: string;
  disabled: boolean;
}

function emptyDraft(): DraftState {
  return {
    original: null,
    id: "",
    transport: "stdio",
    command: "",
    args: "",
    env: "",
    url: "",
    autoApprove: "",
    disabled: false,
  };
}

function draftFromServer(server: McpServer): DraftState {
  return {
    original: server.id,
    id: server.id,
    transport: server.transport,
    command: server.command ?? "",
    args: server.args.join(" "),
    env: Object.entries(server.env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
    url: server.url ?? "",
    autoApprove: server.autoApprove.join(", "),
    disabled: server.disabled,
  };
}

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseArgs(value: string): string[] {
  return value.trim() ? value.trim().split(/\s+/) : [];
}

function parseEnv(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of value.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function draftToServer(draft: DraftState): McpServer {
  return {
    id: draft.id.trim(),
    transport: draft.transport,
    command: draft.transport === "stdio" ? draft.command.trim() : undefined,
    args: parseArgs(draft.args),
    env: parseEnv(draft.env),
    url: draft.transport === "stdio" ? undefined : draft.url.trim(),
    autoApprove: parseList(draft.autoApprove),
    disabled: draft.disabled,
    scope: "workspace",
  };
}

function draftToRaw(draft: DraftState): Record<string, unknown> {
  const server = draftToServer(draft);
  const raw: Record<string, unknown> = {
    id: server.id,
    transport: server.transport,
    autoApprove: server.autoApprove,
    disabled: server.disabled,
  };
  if (server.transport === "stdio") {
    raw.command = server.command ?? "";
    raw.args = server.args;
    raw.env = server.env;
  } else {
    raw.url = server.url ?? "";
    raw.type = server.transport;
  }
  return raw;
}

function serverFromStatus(status: McpServerStatus): McpServer {
  return {
    id: status.id,
    transport: status.transport,
    command: status.command ?? undefined,
    args: status.args,
    env: status.env,
    url: status.url ?? undefined,
    autoApprove: status.autoApprove,
    disabled: status.disabled,
    scope: status.scope,
  };
}

const inputClass =
  "w-full rounded border border-border bg-background px-2 py-1 text-xs font-mono outline-none focus:border-[var(--zoc-ember)]";

/**
 * MCP host management (Part 4, §4.1, R13). Lists servers from `.zoc/mcp.json`
 * merged with live runtime status from the gateway, and supports add/edit,
 * enable/disable, auto-approve edits (workspace-only writes + reload), and
 * an isolated "Test connection".
 */
export function McpSection() {
  const workspaceRoot = useApp((s) => s.workspaceRoot);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [statusById, setStatusById] = useState<Record<string, McpServerStatus>>({});
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  const mcpPath = useMemo(
    () => (workspaceRoot ? joinPath(joinPath(workspaceRoot, ".zoc"), "mcp.json") : null),
    [workspaceRoot],
  );

  const readWorkspaceText = useCallback(async (): Promise<string | null> => {
    if (isTauri() && mcpPath) return fsReadText(mcpPath);
    return null;
  }, [mcpPath]);

  const load = useCallback(async () => {
    setLoaded(false);
    const workspaceText = await readWorkspaceText();
    const workspaceServers = loadMcpServers(null, workspaceText);
    setServers(workspaceServers);
    try {
      const live = await fetchMcpServers();
      setStatusById(Object.fromEntries(live.map((s) => [s.id, s])));
      setServers(live.map(serverFromStatus));
    } catch {
      setStatusById({}); // gateway unavailable (e.g. browser dev) — config-only view
    }
    setLoaded(true);
  }, [readWorkspaceText]);

  useEffect(() => {
    void load();
  }, [load]);

  const persist = useCallback(
    async (draftToSave: DraftState): Promise<void> => {
      setMessage(null);
      const server = draftToServer(draftToSave);
      if (!server.id) {
        setMessage("A server id is required.");
        return;
      }
      if (server.transport === "stdio" && !server.command) {
        setMessage("A stdio server command is required.");
        return;
      }
      if (server.transport !== "stdio" && !server.url) {
        setMessage(`A ${server.transport} server URL is required.`);
        return;
      }
      if (!isTauri() || !mcpPath) {
        setMessage("Workspace file writes require the desktop app.");
        return;
      }
      const workspaceText = await readWorkspaceText();
      const next = upsertWorkspaceServer(workspaceText, server);
      if (workspaceRoot) {
        try {
          await fsCreateDir(joinPath(workspaceRoot, ".zoc"));
        } catch {
          // Existing directory is the normal path; fsCreateDir reports it as an error.
        }
      }
      const wrote = await fsWriteText(mcpPath, next);
      if (!wrote) {
        setMessage("Failed to write .zoc/mcp.json.");
        return;
      }
      try {
        await reloadMcp();
      } catch {
        setMessage("Saved, but the gateway reload failed. Displayed status was not refreshed.");
        return;
      }
      setDraft(null);
      await load();
    },
    [load, mcpPath, readWorkspaceText, workspaceRoot],
  );

  const toggleDisabled = useCallback(
    (server: McpServer) => {
      const d = draftFromServer(server);
      d.disabled = !server.disabled;
      void persist(d);
    },
    [persist],
  );

  const reloadRuntime = useCallback(async (): Promise<void> => {
    setMessage(null);
    try {
      const live = await reloadMcp();
      setStatusById(Object.fromEntries(live.map((s) => [s.id, s])));
      setServers(live.map(serverFromStatus));
      setLoaded(true);
    } catch {
      setMessage("Failed to reload MCP servers. Displayed status was not refreshed.");
    }
  }, []);

  const runTest = useCallback(async (draftToTest: DraftState): Promise<void> => {
    setTestResult("Testing…");
    try {
      const outcome = await testMcpServer(draftToRaw(draftToTest));
      if (outcome.outcome === "success") {
        setTestResult(`OK — ${outcome.toolCount} tool(s): ${outcome.bareNames.join(", ") || "none"}`);
      } else if (outcome.outcome === "unsupported") {
        setTestResult(`Unsupported transport (${outcome.transport}) for live test.`);
      } else {
        setTestResult(`Failed: ${outcome.reason}`);
      }
    } catch {
      setTestResult("Test failed: gateway unavailable.");
    }
  }, []);

  return (
    <div className="space-y-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">MCP Servers</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Model Context Protocol servers from <code className="text-xs">.zoc/mcp.json</code>.
            Edits are written to workspace config and applied via a live reload.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft(emptyDraft());
              setTestResult(null);
            }}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add server
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void reloadRuntime()}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Reload
          </Button>
        </div>
      </header>

      {message && (
        <div className="rounded border border-[var(--zoc-error)]/40 bg-[var(--zoc-error)]/10 px-3 py-2 text-xs text-[var(--zoc-error)]">
          {message}
        </div>
      )}

      {draft && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              {draft.original ? `Edit ${draft.original}` : "Add MCP server"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5 text-xs">
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1">
                <span className="text-muted-foreground">Server id</span>
                <input
                  className={inputClass}
                  value={draft.id}
                  disabled={draft.original !== null}
                  onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                  placeholder="my-server"
                />
              </label>
              <label className="space-y-1">
                <span className="text-muted-foreground">Transport</span>
                <select
                  className={inputClass}
                  value={draft.transport}
                  onChange={(e) => setDraft({ ...draft, transport: e.target.value as McpTransport })}
                >
                  <option value="stdio">stdio</option>
                  <option value="sse">sse</option>
                  <option value="http">http</option>
                </select>
              </label>
            </div>

            {draft.transport === "stdio" ? (
              <>
                <label className="block space-y-1">
                  <span className="text-muted-foreground">Command</span>
                  <input
                    className={inputClass}
                    value={draft.command}
                    onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                    placeholder="python"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-muted-foreground">Args (space-separated)</span>
                  <input
                    className={inputClass}
                    value={draft.args}
                    onChange={(e) => setDraft({ ...draft, args: e.target.value })}
                    placeholder="-m my_server"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-muted-foreground">Env (KEY=VALUE per line)</span>
                  <textarea
                    className={`${inputClass} h-14 resize-y`}
                    value={draft.env}
                    onChange={(e) => setDraft({ ...draft, env: e.target.value })}
                  />
                </label>
              </>
            ) : (
              <label className="block space-y-1">
                <span className="text-muted-foreground">URL</span>
                <input
                  className={inputClass}
                  value={draft.url}
                  onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                  placeholder="https://example.com/mcp"
                />
              </label>
            )}

            <label className="block space-y-1">
              <span className="text-muted-foreground">Auto-approve tools (comma-separated)</span>
              <input
                className={inputClass}
                value={draft.autoApprove}
                onChange={(e) => setDraft({ ...draft, autoApprove: e.target.value })}
                placeholder="tool_a, tool_b"
              />
            </label>

            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={draft.disabled}
                onChange={(e) => setDraft({ ...draft, disabled: e.target.checked })}
              />
              <span className="text-muted-foreground">Disabled</span>
            </label>

            {testResult && (
              <div className="rounded border border-border bg-accent/40 px-2 py-1 text-[11px] text-muted-foreground">
                {testResult}
              </div>
            )}

            <div className="flex items-center gap-2 pt-1">
              <Button size="sm" onClick={() => void persist(draft)}>
                Save &amp; reload
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void runTest(draft)}>
                Test connection
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {!loaded ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
      ) : servers.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No servers configured. Use “Add server” to create one.
        </p>
      ) : (
        <div className="grid gap-3">
          {servers.map((s) => {
            const Icon = TRANSPORT_ICON[s.transport];
            const status = statusById[s.id];
            const runtime: McpRuntimeStatus = status?.status ?? "stopped";
            return (
              <Card key={s.id} className={s.disabled ? "opacity-60" : undefined}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2">
                      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                      {s.id}
                      <span className={`text-[10px] uppercase ${STATUS_TONE[runtime]}`}>
                        ● {runtime}
                      </span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <Badge variant="secondary" className="text-[9px] uppercase">
                        {s.transport}
                      </Badge>
                      <Badge variant="outline" className="text-[9px] uppercase">
                        {s.scope}
                      </Badge>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => {
                          setDraft(draftFromServer(s));
                          setTestResult(null);
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => toggleDisabled(s)}
                      >
                        {s.disabled ? "Enable" : "Disable"}
                      </Button>
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-1.5 text-xs">
                  <code className="block truncate font-mono text-[11px] text-muted-foreground">
                    {s.transport === "stdio" ? [s.command, ...s.args].join(" ") : s.url}
                  </code>
                  {status?.errorReason && (
                    <p className="text-[11px] text-[var(--zoc-error)]">{status.errorReason}</p>
                  )}
                  {s.autoApprove.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="text-[10px] uppercase text-muted-foreground">
                        Auto-approve:
                      </span>
                      {s.autoApprove.map((t) => (
                        <Badge key={t} variant="secondary" className="text-[9px]">
                          {t}
                        </Badge>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
