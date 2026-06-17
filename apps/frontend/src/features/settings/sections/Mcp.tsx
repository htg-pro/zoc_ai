import { useCallback, useEffect, useState } from "react";
import { Globe, Plug, RefreshCw, Terminal as TerminalIcon } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useApp } from "@/lib/store";
import { fsReadText, isTauri } from "@/lib/tauri-bridge";
import { joinPath } from "@/lib/paths";
import { loadMcpServers, type McpServer, type McpTransport } from "@/lib/mcp-config";

const TRANSPORT_ICON: Record<McpTransport, typeof Plug> = {
  stdio: TerminalIcon,
  sse: Globe,
  http: Globe,
};

/**
 * MCP host (develop.md Phase 11). Reads `.zoc/mcp.json` (workspace) and merges
 * with a user-level config, listing the configured servers, their transport,
 * and auto-approved tools. The live client connection lifecycle is deferred —
 * this surface configures and previews servers; tools route through the same
 * approval cards as built-in tools when connected.
 */
export function McpSection() {
  const workspaceRoot = useApp((s) => s.workspaceRoot);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setLoaded(false);
    let workspaceText: string | null = null;
    if (isTauri() && workspaceRoot) {
      workspaceText = await fsReadText(joinPath(joinPath(workspaceRoot, ".zoc"), "mcp.json"));
    }
    setServers(loadMcpServers(null, workspaceText));
    setLoaded(true);
  }, [workspaceRoot]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">MCP Servers</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Model Context Protocol servers from <code className="text-xs">.zoc/mcp.json</code>.
            Workspace config overrides user config.
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void load()}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          Reload
        </Button>
      </header>

      <div className="flex items-start gap-2 rounded border border-border bg-accent/40 px-3 py-2 text-xs text-muted-foreground">
        <Plug className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          The live MCP client (stdio / SSE / streamable HTTP transports, tool discovery, and OAuth)
          runs in the desktop shell and isn’t active in this preview. Configured servers and their
          auto-approve lists are shown here; connected tools appear in chat with approval cards.
        </span>
      </div>

      {!loaded ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
      ) : servers.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">No servers configured</CardTitle>
            <CardDescription>
              Create <code className="text-xs">.zoc/mcp.json</code> with an{" "}
              <code className="text-xs">mcpServers</code> map to add servers.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-3">
          {servers.map((s) => {
            const Icon = TRANSPORT_ICON[s.transport];
            return (
              <Card key={s.id} className={s.disabled ? "opacity-60" : undefined}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2">
                      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                      {s.id}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <Badge variant="secondary" className="text-[9px] uppercase">
                        {s.transport}
                      </Badge>
                      <Badge variant="outline" className="text-[9px] uppercase">
                        {s.scope}
                      </Badge>
                      {s.disabled && (
                        <Badge variant="outline" className="text-[9px] uppercase text-muted-foreground">
                          Disabled
                        </Badge>
                      )}
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-1.5 text-xs">
                  <code className="block truncate font-mono text-[11px] text-muted-foreground">
                    {s.transport === "stdio"
                      ? [s.command, ...s.args].join(" ")
                      : s.url}
                  </code>
                  {s.autoApprove.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="text-[10px] uppercase text-muted-foreground">Auto-approve:</span>
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
