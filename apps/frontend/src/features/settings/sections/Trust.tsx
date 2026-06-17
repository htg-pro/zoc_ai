import { useEffect, useState } from "react";
import { Check, Plus, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  addToAllowlist,
  clearAuditLog,
  getAuditLog,
  getTrustConfig,
  removeFromAllowlist,
  setProtection,
  setRunMode,
  setTrust,
  subscribeTrust,
  type AllowlistKey,
  type ProtectionKey,
} from "@/lib/trust";
import type { RunMode } from "@/lib/permissions-engine";
import { cn } from "@/lib/utils";

const RUN_MODES: { value: RunMode; label: string; hint: string }[] = [
  { value: "ask", label: "Ask every time", hint: "Prompt before every privileged action." },
  { value: "allowlist", label: "Allowlist", hint: "Auto-run allowlisted commands; prompt otherwise." },
  { value: "sandboxed", label: "Sandboxed when possible", hint: "Auto-run sandboxable actions; prompt otherwise." },
  { value: "all", label: "Run everything", hint: "Auto-run all (destructive actions still confirm)." },
];

const PROTECTIONS: { key: ProtectionKey; label: string; hint: string }[] = [
  { key: "protectDeletions", label: "File deletion protection", hint: "Confirm before deleting files." },
  { key: "protectDotfiles", label: "Dotfile protection", hint: "Confirm before editing .env and other dotfiles." },
  { key: "protectExternal", label: "External file protection", hint: "Confirm before touching paths outside the workspace." },
];

/**
 * Workspace Trust & Safety (develop.md Phase 13). Sets the trust state, run
 * mode, allowlists, and protections that the unified permission engine uses,
 * and shows the permission audit log.
 */
export function TrustSection() {
  const [, setTick] = useState(0);
  useEffect(() => subscribeTrust(() => setTick((n) => n + 1)), []);

  const config = getTrustConfig();
  const audit = getAuditLog();
  const restricted = config.trust === "restricted";

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Trust &amp; Safety</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Control what the agent, terminal, tasks, and plugins may do in this workspace.
        </p>
      </header>

      <Card className={cn(restricted ? "border-warning/50" : "border-emerald-500/40")}>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            {restricted ? (
              <ShieldAlert className="h-4 w-4 text-warning" />
            ) : (
              <ShieldCheck className="h-4 w-4 text-emerald-400" />
            )}
            Workspace Trust
          </CardTitle>
          <CardDescription>
            {restricted
              ? "Restricted — terminal, tasks, and plugin actions are blocked until you trust this workspace."
              : "Trusted — privileged actions run according to the run mode below."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            size="sm"
            variant={restricted ? "default" : "secondary"}
            onClick={() => setTrust(restricted ? "trusted" : "restricted")}
          >
            {restricted ? "Trust workspace" : "Restrict workspace"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Run mode</CardTitle>
          <CardDescription>How privileged actions are gated when trusted.</CardDescription>
        </CardHeader>
        <CardContent>
          <Select value={config.runMode} onValueChange={(v) => setRunMode(v as RunMode)}>
            <SelectTrigger className="h-8 w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RUN_MODES.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="mt-2 text-xs text-muted-foreground">
            {RUN_MODES.find((m) => m.value === config.runMode)?.hint}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Protections</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          {PROTECTIONS.map((p) => (
            <div key={p.key} className="flex items-center justify-between gap-4">
              <div>
                <Label className="text-[13px]">{p.label}</Label>
                <p className="text-xs text-muted-foreground">{p.hint}</p>
              </div>
              <Switch
                checked={config[p.key]}
                onCheckedChange={(v) => setProtection(p.key, v)}
                aria-label={p.label}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      <AllowlistEditor
        title="Command allowlist"
        description="Terminal/task commands that auto-run (exact or prefix match)."
        list={config.commandAllowlist}
        listKey="commandAllowlist"
        placeholder="e.g. npm run build"
      />
      <AllowlistEditor
        title="MCP allowlist"
        description="MCP tools that skip the approval card."
        list={config.mcpAllowlist}
        listKey="mcpAllowlist"
        placeholder="e.g. search_docs"
      />
      <AllowlistEditor
        title="Network allowlist"
        description="Hosts the agent may reach."
        list={config.networkAllowlist}
        listKey="networkAllowlist"
        placeholder="e.g. api.github.com"
      />

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm">Audit Log ({audit.length})</CardTitle>
          {audit.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => clearAuditLog()}>
              Clear
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {audit.length === 0 ? (
            <p className="text-xs text-muted-foreground">No permission decisions recorded yet.</p>
          ) : (
            <ul className="max-h-56 space-y-0.5 overflow-y-auto font-mono text-[11px]">
              {audit
                .slice()
                .reverse()
                .map((e, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <span className="shrink-0 opacity-60">
                      {new Date(e.ts).toLocaleTimeString()}
                    </span>
                    <Badge
                      variant={
                        e.effect === "allow"
                          ? "success"
                          : e.effect === "deny"
                            ? "destructive"
                            : "warning"
                      }
                      className="shrink-0 text-[9px] uppercase"
                    >
                      {e.effect}
                    </Badge>
                    <span className="shrink-0 text-muted-foreground">{e.kind}</span>
                    <span className="min-w-0 truncate">{e.name}</span>
                  </li>
                ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AllowlistEditor({
  title,
  description,
  list,
  listKey,
  placeholder,
}: {
  title: string;
  description: string;
  list: string[];
  listKey: AllowlistKey;
  placeholder: string;
}) {
  const [value, setValue] = useState("");
  const add = () => {
    addToAllowlist(listKey, value);
    setValue("");
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex gap-2">
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder={placeholder}
            className="h-8"
          />
          <Button size="sm" disabled={!value.trim()} onClick={add}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add
          </Button>
        </div>
        {list.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {list.map((entry) => (
              <span
                key={entry}
                className="inline-flex items-center gap-1 rounded border border-border bg-accent/50 px-2 py-0.5 font-mono text-[11px]"
              >
                <Check className="h-3 w-3 text-emerald-400" />
                {entry}
                <button
                  type="button"
                  aria-label={`Remove ${entry}`}
                  onClick={() => removeFromAllowlist(listKey, entry)}
                  className="ml-0.5 text-muted-foreground hover:text-destructive"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Nothing allowlisted.</p>
        )}
      </CardContent>
    </Card>
  );
}
