import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Blocks,
  ChevronRight,
  Command as CommandIcon,
  LayoutPanelLeft,
  Plus,
  Trash2,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import {
  clearPluginLogs,
  getPluginLogs,
  getPlugins,
  installPlugin,
  setPluginEnabled,
  subscribePlugins,
  uninstallPlugin,
  type InstalledPlugin,
} from "@/lib/plugins";
import { cn } from "@/lib/utils";

const EXAMPLE = `{
  "id": "hello-world",
  "name": "Hello World",
  "version": "1.0.0",
  "description": "A sample plugin.",
  "activationEvents": ["onStartup"],
  "contributes": {
    "commands": [{ "id": "hello.say", "title": "Hello: Say Hi" }],
    "views": [{ "id": "hello.view", "name": "Hello", "location": "sidebar" }]
  }
}`;

/**
 * Extensions / plugins (develop.md Phase 12). Install from a manifest, toggle
 * enable/disable (which adds/removes contributed commands + views), and read
 * the plugin host log. Folder/zip install + sandboxed code execution land in
 * the desktop shell; this surface drives the manifest lifecycle.
 */
export function ExtensionsSection() {
  const [, setTick] = useState(0);
  const [installOpen, setInstallOpen] = useState(false);
  const [manifestText, setManifestText] = useState("");
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => subscribePlugins(() => setTick((n) => n + 1)), []);

  const plugins = getPlugins();
  const logs = getPluginLogs();

  const doInstall = () => {
    const errs = installPlugin(manifestText, "folder");
    setErrors(errs);
    if (errs.length === 0) {
      setManifestText("");
      setInstallOpen(false);
      toast.success("Plugin installed");
    } else {
      toast.error("Install failed", { description: errs[0] });
    }
  };

  return (
    <div className="space-y-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Extensions</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Internal plugins that contribute commands, views, tasks, and more.
          </p>
        </div>
        <Button size="sm" onClick={() => setInstallOpen((v) => !v)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Install
        </Button>
      </header>

      <div className="flex items-start gap-2 rounded border border-border bg-accent/40 px-3 py-2 text-xs text-muted-foreground">
        <Blocks className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Installing from a local folder or <code className="text-xs">.zip</code>, sandboxed code
          execution, and Open VSX run in the desktop shell. Here you can install a manifest, manage
          contributions, and read the host log.
        </span>
      </div>

      {installOpen && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Install from manifest</CardTitle>
            <CardDescription>Paste a plugin manifest (package.json-style).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Textarea
              value={manifestText}
              onChange={(e) => setManifestText(e.target.value)}
              rows={10}
              placeholder={EXAMPLE}
              className="font-mono text-xs"
              spellCheck={false}
            />
            {errors.length > 0 && (
              <ul className="space-y-0.5 text-xs text-destructive">
                {errors.map((e, i) => (
                  <li key={i}>• {e}</li>
                ))}
              </ul>
            )}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setManifestText(EXAMPLE)}>
                Use example
              </Button>
              <Button size="sm" disabled={!manifestText.trim()} onClick={doInstall}>
                Install
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {plugins.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">No plugins installed</CardTitle>
            <CardDescription>Install a manifest to add commands and views.</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-3">
          {plugins.map((p) => (
            <PluginCard key={p.manifest.id} plugin={p} />
          ))}
        </div>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm">Plugin Host Log</CardTitle>
          {logs.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => clearPluginLogs()}>
              Clear
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {logs.length === 0 ? (
            <p className="text-xs text-muted-foreground">No host activity yet.</p>
          ) : (
            <ul className="max-h-48 space-y-0.5 overflow-y-auto font-mono text-[11px]">
              {logs.map((l, i) => (
                <li
                  key={i}
                  className={cn(
                    "flex gap-2",
                    l.level === "error" ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  <span className="shrink-0 opacity-60">
                    {new Date(l.ts).toLocaleTimeString()}
                  </span>
                  {l.pluginId && <span className="shrink-0 text-foreground">[{l.pluginId}]</span>}
                  <span className="min-w-0">{l.message}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function PluginCard({ plugin }: { plugin: InstalledPlugin }) {
  const { manifest, enabled, errored, error } = plugin;
  const contributes = manifest.contributes;
  const counts = useMemo(
    () =>
      [
        { label: "commands", n: contributes.commands.length, Icon: CommandIcon },
        { label: "views", n: contributes.views.length, Icon: LayoutPanelLeft },
        { label: "tasks", n: contributes.tasks.length, Icon: ChevronRight },
        { label: "themes", n: contributes.themes.length, Icon: ChevronRight },
        { label: "languages", n: contributes.languages.length, Icon: ChevronRight },
        { label: "snippets", n: contributes.snippets.length, Icon: ChevronRight },
      ].filter((c) => c.n > 0),
    [contributes],
  );

  return (
    <Card className={cn(!enabled && "opacity-60", errored && "border-destructive/50")}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-2">
            <Blocks className="h-3.5 w-3.5 text-muted-foreground" />
            {manifest.name}
            <span className="font-mono text-[10px] text-muted-foreground">v{manifest.version}</span>
            {errored && (
              <Badge variant="destructive" className="text-[9px] uppercase">
                <AlertTriangle className="mr-0.5 h-2.5 w-2.5" />
                Error
              </Badge>
            )}
          </span>
          <div className="flex items-center gap-2">
            <Switch
              checked={enabled}
              onCheckedChange={(v) => setPluginEnabled(manifest.id, v)}
              aria-label={`Enable ${manifest.name}`}
            />
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              aria-label={`Uninstall ${manifest.name}`}
              onClick={() => uninstallPlugin(manifest.id)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {manifest.description && (
          <p className="text-xs text-muted-foreground">{manifest.description}</p>
        )}
        {errored && error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[10px] text-muted-foreground">{manifest.id}</span>
          {counts.map((c) => (
            <Badge key={c.label} variant="secondary" className="text-[9px]">
              {c.n} {c.label}
            </Badge>
          ))}
        </div>
        {contributes.commands.length > 0 && (
          <div className="text-[11px] text-muted-foreground">
            Commands:{" "}
            {contributes.commands.map((c) => c.title).join(", ")}
          </div>
        )}
        {contributes.views.length > 0 && (
          <div className="text-[11px] text-muted-foreground">
            Views: {contributes.views.map((v) => v.name).join(", ")}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
