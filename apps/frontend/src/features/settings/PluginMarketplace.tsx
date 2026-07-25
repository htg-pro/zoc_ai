import { useCallback, useEffect, useMemo, useState } from "react";
import { BadgeCheck, Puzzle, RefreshCw, Star, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  filterPlugins,
  manifestFromArtifact,
  MAX_PLUGIN_ARCHIVE_BYTES,
  parseRegistry,
  type RegistryPlugin,
} from "@/lib/plugin-registry";
import {
  getPlugins,
  installPlugin,
  setPluginEnabled,
  subscribePlugins,
  uninstallPlugin,
  type InstalledPlugin,
} from "@/lib/plugins";

const REGISTRY_URL = "https://registry.zoc.studio/plugins.json";

async function loadRegistry(): Promise<RegistryPlugin[]> {
  try {
    const res = await fetch(REGISTRY_URL);
    if (res.ok) {
      const list = parseRegistry(await res.text());
      if (list.length > 0) return list;
    }
  } catch {
    /* fall through to the bundled offline copy */
  }
  try {
    const res = await fetch("/plugins.json");
    if (res.ok) return parseRegistry(await res.text());
  } catch {
    /* no registry available */
  }
  return [];
}

async function readPluginDownload(
  response: Response,
  onProgress: (percent: number | null) => void,
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  const total = Number.isFinite(declaredLength) && declaredLength > 0 ? declaredLength : null;
  if (total != null && total > MAX_PLUGIN_ARCHIVE_BYTES) {
    throw new Error("plugin download exceeds the 10 MiB limit");
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_PLUGIN_ARCHIVE_BYTES) {
      throw new Error("plugin download exceeds the 10 MiB limit");
    }
    onProgress(100);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_PLUGIN_ARCHIVE_BYTES) {
        await reader.cancel("plugin download too large");
        throw new Error("plugin download exceeds the 10 MiB limit");
      }
      chunks.push(value);
      onProgress(total == null ? null : Math.min(99, Math.round((received / total) * 100)));
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  onProgress(100);
  return bytes;
}

export function PluginMarketplace() {
  const [tab, setTab] = useState<"marketplace" | "installed">("marketplace");
  const [registry, setRegistry] = useState<RegistryPlugin[]>([]);
  const [query, setQuery] = useState("");
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refreshRegistry = useCallback(async () => {
    setRegistry(await loadRegistry());
  }, []);

  useEffect(() => {
    void refreshRegistry();
    setInstalled([...getPlugins()]);
    return subscribePlugins(() => setInstalled([...getPlugins()]));
  }, [refreshRegistry]);

  const filtered = useMemo(() => filterPlugins(registry, query), [registry, query]);
  const installedIds = useMemo(
    () => new Set(installed.map((p) => p.manifest.id)),
    [installed],
  );

  const install = useCallback(async (plugin: RegistryPlugin) => {
    setMessage(null);
    if (!plugin.downloadUrl) {
      setMessage(`${plugin.name}: this bundled listing has no install artifact.`);
      return;
    }
    setBusy(plugin.id);
    setProgress(0);
    try {
      const res = await fetch(plugin.downloadUrl);
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      const artifact = await readPluginDownload(res, setProgress);
      const { manifest, code, errors } = await manifestFromArtifact(artifact);
      if (!manifest) {
        setMessage(`Install failed: ${errors.join(" ")}`);
        return;
      }
      if (manifest.id !== plugin.id || manifest.version !== plugin.version) {
        throw new Error(
          `artifact identity mismatch (expected ${plugin.id}@${plugin.version}, received ${manifest.id}@${manifest.version})`,
        );
      }
      const installErrors = installPlugin(manifest, "zip", code);
      if (installErrors.length > 0) throw new Error(installErrors.join(" "));
      setMessage(`${manifest.name} installed and activated.`);
    } catch (err) {
      setMessage(`Install failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }, []);

  return (
    <div className="space-y-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Plugins</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Browse and install plugins. Each runs in an isolated worker sandbox.
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void refreshRegistry()}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          Refresh
        </Button>
      </header>

      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          variant={tab === "marketplace" ? "secondary" : "ghost"}
          onClick={() => setTab("marketplace")}
        >
          Marketplace
        </Button>
        <Button
          size="sm"
          variant={tab === "installed" ? "secondary" : "ghost"}
          onClick={() => setTab("installed")}
        >
          Installed ({installed.length})
        </Button>
      </div>

      {message && (
        <div className="rounded border border-border bg-accent/40 px-3 py-2 text-xs text-muted-foreground">
          {message}
        </div>
      )}

      {tab === "marketplace" ? (
        <div className="space-y-3">
          <input
            className="w-full rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:border-[var(--zoc-ember)]"
            placeholder="Search plugins by name or tag…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search plugins"
          />
          {filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No plugins found.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {filtered.map((p) => (
                <Card key={p.id} data-plugin-id={p.id}>
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center justify-between text-sm">
                      <span className="flex items-center gap-2">
                        <span className="flex h-5 w-5 items-center justify-center rounded bg-[var(--zoc-ember)]/15 text-[10px] font-semibold uppercase text-[var(--zoc-ember)]">
                          {p.name.charAt(0)}
                        </span>
                        {p.name}
                        {p.verified && (
                          <BadgeCheck
                            className="h-3.5 w-3.5 text-[var(--zoc-info)]"
                            aria-label="verified"
                          />
                        )}
                      </span>
                      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                        <Star className="h-3 w-3" />
                        {p.stars}
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-xs">
                    <p className="line-clamp-2 text-muted-foreground">{p.description}</p>
                    <p className="text-[10px] uppercase text-muted-foreground">by {p.author || "unknown"}</p>
                    <div className="flex flex-wrap gap-1">
                      {p.tags.map((t) => (
                        <Badge key={t} variant="secondary" className="text-[9px]">
                          {t}
                        </Badge>
                      ))}
                    </div>
                    <Button
                      size="sm"
                      className="w-full"
                      disabled={busy !== null || installedIds.has(p.id) || !p.downloadUrl}
                      title={!p.downloadUrl ? "No install artifact is published for this listing." : undefined}
                      onClick={() => void install(p)}
                    >
                      <Puzzle className="mr-1.5 h-3.5 w-3.5" />
                      {installedIds.has(p.id)
                        ? "Installed"
                        : busy === p.id
                          ? "Installing…"
                          : p.downloadUrl
                            ? "Install"
                            : "Unavailable"}
                    </Button>
                    {busy === p.id && (
                      <progress
                        className="h-1.5 w-full accent-[var(--zoc-ember)]"
                        max={100}
                        value={progress ?? undefined}
                        aria-label={`Installing ${p.name}`}
                      />
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="grid gap-3">
          {installed.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No plugins installed.</p>
          ) : (
            installed.map((p) => (
              <Card key={p.manifest.id} data-installed-id={p.manifest.id} className={p.errored ? "border-[var(--zoc-error)]/40" : undefined}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2">
                      <Puzzle className="h-3.5 w-3.5 text-muted-foreground" />
                      {p.manifest.name}
                      <span className="text-[10px] text-muted-foreground">v{p.manifest.version}</span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => setPluginEnabled(p.manifest.id, !p.enabled)}
                      >
                        {p.enabled ? "Disable" : "Enable"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[11px] text-[var(--zoc-error)]"
                        onClick={() => uninstallPlugin(p.manifest.id)}
                        aria-label={`Uninstall ${p.manifest.name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground">
                  {p.errored ? (
                    <span className="text-[var(--zoc-error)]">{p.error ?? "Plugin errored."}</span>
                  ) : (
                    p.manifest.description || "No description."
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </div>
      )}
    </div>
  );
}
