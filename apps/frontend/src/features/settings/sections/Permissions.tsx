import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { PermissionGrant, PermissionScope } from "@zoc-studio/shared-types";
import { useApp } from "@/lib/store";

const SCOPES: { scope: PermissionScope; label: string; desc: string; defaultGranted: boolean }[] = [
  {
    scope: "read_fs",
    label: "Read filesystem",
    desc: "Let the agent inspect workspace files.",
    defaultGranted: true,
  },
  {
    scope: "write_fs",
    label: "Write filesystem",
    desc: "Let the agent apply diffs without per-edit approval.",
    defaultGranted: false,
  },
  {
    scope: "run_command",
    label: "Run shell commands",
    desc: "Let the agent execute commands. Destructive commands always prompt.",
    defaultGranted: false,
  },
  {
    scope: "network",
    label: "Network access",
    desc: "Allow agent tools to make outbound HTTP requests.",
    defaultGranted: true,
  },
];

export function PermissionsSection() {
  const grants = useApp((s) => s.permissionGrants);
  const loadPermissions = useApp((s) => s.loadPermissions);
  const setPermissions = useApp((s) => s.setPermissions);
  const toolDescriptors = useApp((s) => s.toolDescriptors);
  const loadToolDescriptors = useApp((s) => s.loadToolDescriptors);
  const toolGrants = useApp((s) => s.toolGrants);
  const loadToolGrants = useApp((s) => s.loadToolGrants);
  const revokeTool = useApp((s) => s.revokeTool);
  const [pending, setPending] = useState<PermissionScope | null>(null);
  const [pendingTool, setPendingTool] = useState<string | null>(null);

  useEffect(() => {
    void loadPermissions();
    void loadToolDescriptors();
    void loadToolGrants();
  }, [loadPermissions, loadToolDescriptors, loadToolGrants]);

  const activeToolGrants = useMemo(
    () => toolGrants.filter((g) => g.granted),
    [toolGrants],
  );

  const revoke = async (tool: string) => {
    setPendingTool(tool);
    try {
      await revokeTool(tool);
    } finally {
      setPendingTool(null);
    }
  };

  const toolDescriptionByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const tool of toolDescriptors) {
      if (tool.description) m.set(tool.name, tool.description);
    }
    return m;
  }, [toolDescriptors]);

  const grantMap = useMemo(() => {
    const m = new Map<PermissionScope, boolean>();
    for (const g of grants) m.set(g.scope, g.granted);
    return m;
  }, [grants]);

  // Map each scope to the backend tools that depend on it, derived from the
  // live tool catalog (`/v1/tools`). In mock mode the catalog is empty, so
  // these lists gracefully render nothing.
  const toolsByScope = useMemo(() => {
    const m = new Map<PermissionScope, string[]>();
    for (const tool of toolDescriptors) {
      for (const scope of tool.requires_scopes) {
        const list = m.get(scope) ?? [];
        list.push(tool.name);
        m.set(scope, list);
      }
    }
    for (const [scope, list] of m) {
      m.set(scope, [...list].sort((a, b) => a.localeCompare(b)));
    }
    return m;
  }, [toolDescriptors]);

  const toggle = async (scope: PermissionScope, granted: boolean) => {
    setPending(scope);
    try {
      const next: PermissionGrant[] = [{ scope, granted }];
      await setPermissions(next);
    } finally {
      setPending(null);
    }
  };

  return (
    <TooltipProvider delayDuration={150}>
    <div className="space-y-4">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Permissions</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Coarse-grained capabilities granted to the agent. Each tool call still respects per-call approval prompts.
        </p>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>Capability grants</CardTitle>
          <CardDescription>Saved per session and remembered between restarts.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {SCOPES.map((s) => {
            const checked = grantMap.has(s.scope) ? !!grantMap.get(s.scope) : s.defaultGranted;
            const tools = toolsByScope.get(s.scope) ?? [];
            return (
              <div key={s.scope} className="flex items-start justify-between gap-4">
                <div>
                  <Label className="text-sm">{s.label}</Label>
                  <p className="text-xs text-muted-foreground">{s.desc}</p>
                  {tools.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      <span className="text-xs text-muted-foreground">Unlocks:</span>
                      {tools.map((name) => {
                        const description = toolDescriptionByName.get(name);
                        const chip = (
                          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                            {name}
                          </code>
                        );
                        if (!description) return <span key={name}>{chip}</span>;
                        return (
                          <Tooltip key={name}>
                            <TooltipTrigger asChild>
                              <button type="button" className="cursor-help">
                                {chip}
                              </button>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs">{description}</TooltipContent>
                          </Tooltip>
                        );
                      })}
                    </div>
                  )}
                </div>
                <Switch
                  checked={checked}
                  disabled={pending === s.scope}
                  onCheckedChange={(v) => void toggle(s.scope, v)}
                />
              </div>
            );
          })}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Per-tool overrides</CardTitle>
          <CardDescription>
            Tools you approved individually from an approval prompt. These bypass the
            scope toggles above for that one tool. Revoke to fall back to scope checks.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {activeToolGrants.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No per-tool grants yet. Use “Allow this tool” on an approval prompt to add one.
            </p>
          ) : (
            activeToolGrants.map((g) => (
              <div key={g.tool} className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                    {g.tool}
                  </code>
                  {g.once && (
                    <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-amber-400">
                      once
                    </span>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[11px]"
                  disabled={pendingTool === g.tool}
                  onClick={() => void revoke(g.tool)}
                >
                  Revoke
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
    </TooltipProvider>
  );
}
