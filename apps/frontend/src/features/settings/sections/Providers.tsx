import { useEffect, useState, useSyncExternalStore } from "react";
import { Eye, EyeOff, KeyRound, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAgentClient } from "@/lib/agent-client";
import {
  getProvidersSnapshot,
  makeProviderId,
  parseModelList,
  removeProvider,
  subscribeProviders,
  upsertProvider,
  type ProviderConfig,
} from "@/lib/providers";
import { secureStore } from "@/lib/secure-store";
import { toast } from "@/components/ui/toast";

const apiKeyName = (id: string) => `provider.${id}.api_key`;

function formatClock(iso: string | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(t));
}

export function ProvidersSection() {
  const providers = useSyncExternalStore(subscribeProviders, getProvidersSnapshot, getProvidersSnapshot);
  const [adding, setAdding] = useState(false);

  return (
    <div className="space-y-4">
      <header className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Providers</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure cloud APIs (OpenAI, Google AI Studio, Groq, xAI, Anthropic) and add your own
            OpenAI-compatible endpoints. Keys are stored in the OS keychain. Models with a key
            configured appear in the chat model picker.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Add provider
        </Button>
      </header>

      {adding && <AddProviderCard onDone={() => setAdding(false)} />}

      <div className="grid gap-3">
        {providers.map((p) => (
          <ProviderCard key={p.id} provider={p} />
        ))}
      </div>
    </div>
  );
}

function AddProviderCard({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [models, setModels] = useState("");

  const create = () => {
    if (!name.trim() || !baseUrl.trim()) {
      toast.error("Name and base URL are required");
      return;
    }
    const provider: ProviderConfig = {
      id: makeProviderId(name),
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      requiresKey: true,
      builtin: false,
      models: parseModelList(models),
    };
    upsertProvider(provider);
    toast.success(`Added ${provider.name}`);
    onDone();
  };

  return (
    <Card className="border-primary/40">
      <CardHeader>
        <CardTitle className="text-sm">New custom provider</CardTitle>
        <CardDescription>Any OpenAI-compatible `/chat/completions` endpoint.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-1.5">
          <Label htmlFor="new-name">Name</Label>
          <Input id="new-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="My Provider" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="new-url">Base URL</Label>
          <Input id="new-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" className="font-mono" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="new-models">Models (comma or newline separated)</Label>
          <Input id="new-models" value={models} onChange={(e) => setModels(e.target.value)} placeholder="model-a, model-b" className="font-mono" />
        </div>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button size="sm" onClick={create}>
            <Plus className="mr-1 h-3 w-3" /> Add
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ProviderCard({ provider }: { provider: ProviderConfig }) {
  const [key, setKey] = useState("");
  const [url, setUrl] = useState(provider.baseUrl);
  const [modelsText, setModelsText] = useState(provider.models.map((m) => m.id).join(", "));
  const [reveal, setReveal] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<string | undefined>(provider.modelsFetchedAt);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await secureStore.get(apiKeyName(provider.id));
      if (!cancelled) {
        if (stored) setKey(stored);
        setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [provider.id]);

  const fetchModels = async () => {
    const baseUrl = url.trim() || provider.baseUrl;
    if (!baseUrl) {
      toast.error("Set a base URL first");
      return;
    }
    setFetching(true);
    try {
      const client = await getAgentClient();
      const models = await client.discoverModels(baseUrl, key.trim() || null);
      if (!models.length) {
        toast.message("No models returned", { description: "The provider returned an empty list." });
        return;
      }
      const now = new Date().toISOString();
      setModelsText(models.map((m) => m.id).join(", "));
      setFetchedAt(now);
      // Persist the live list + key so the chat picker reflects it immediately.
      if (key.trim()) await secureStore.set(apiKeyName(provider.id), key.trim());
      upsertProvider({
        ...provider,
        baseUrl,
        models: models.map((m) => ({ id: m.id, name: m.name, tools: true })),
        modelsFetchedAt: now,
      });
      toast.success(`Found ${models.length} model${models.length === 1 ? "" : "s"}`);
    } catch (err) {
      toast.error("Couldn't fetch models", { description: (err as Error).message });
    } finally {
      setFetching(false);
    }
  };

  const save = async () => {
    if (key.trim()) await secureStore.set(apiKeyName(provider.id), key.trim());
    else await secureStore.clear(apiKeyName(provider.id));
    upsertProvider({
      ...provider,
      baseUrl: url.trim() || provider.baseUrl,
      models: parseModelList(modelsText).length ? parseModelList(modelsText) : provider.models,
      modelsFetchedAt: fetchedAt,
    });
    toast.success(`Saved ${provider.name}`);
  };

  const del = () => {
    removeProvider(provider.id);
    void secureStore.clear(apiKeyName(provider.id));
    toast.message(`Removed ${provider.name}`);
  };

  const fetchedClock = formatClock(fetchedAt);
  const modelCount = parseModelList(modelsText).length;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
            {provider.name}
            {!provider.builtin && <Badge variant="secondary">custom</Badge>}
            {key && <Badge variant="success">configured</Badge>}
            {!key && loaded && <Badge variant="warning">no key</Badge>}
          </CardTitle>
          <CardDescription>
            {modelCount} model{modelCount === 1 ? "" : "s"}
            {fetchedClock ? ` · live, refreshed ${fetchedClock}` : " · default list"} · Bring your own API key.
          </CardDescription>
        </div>
        {!provider.builtin && (
          <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={del} aria-label="Delete provider">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-1.5">
          <Label htmlFor={`${provider.id}-url`}>Base URL</Label>
          <Input
            id={`${provider.id}-url`}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
            className="font-mono"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${provider.id}-key`}>API key</Label>
          <div className="relative">
            <Input
              id={`${provider.id}-key`}
              type={reveal ? "text" : "password"}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="sk-…"
              className="pr-9 font-mono"
            />
            <button
              type="button"
              aria-label={reveal ? "Hide key" : "Reveal key"}
              onClick={() => setReveal((r) => !r)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
        <div className="grid gap-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor={`${provider.id}-models`}>Models</Label>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              disabled={fetching}
              onClick={() => void fetchModels()}
              title="Query the provider's API for its current models"
            >
              <RefreshCw className={`mr-1 h-3 w-3 ${fetching ? "animate-spin" : ""}`} />
              {fetching ? "Fetching…" : "Fetch live models"}
            </Button>
          </div>
          <Input
            id={`${provider.id}-models`}
            value={modelsText}
            onChange={(e) => setModelsText(e.target.value)}
            placeholder="model-a, model-b"
            className="font-mono"
          />
          <p className="text-[11px] text-muted-foreground">
            {fetchedClock
              ? `Live from the provider, refreshed at ${fetchedClock}. These appear in the chat model picker.`
              : "Enter your key and click Fetch live models to load the provider's current models."}
          </p>
        </div>
        <div className="flex justify-end">
          <Button size="sm" onClick={save}>
            <Save className="mr-1 h-3 w-3" /> Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
