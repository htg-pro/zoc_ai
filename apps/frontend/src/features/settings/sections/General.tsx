import { useEffect, useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { useApp } from "@/lib/store";
import {
  effectiveSettings,
  effectiveSource,
  resetSetting,
  searchSettings,
  setSetting,
  subscribeSettings,
  type SettingScope,
  type SettingSpec,
} from "@/lib/settings";
import { cn } from "@/lib/utils";

/**
 * Registry-driven preferences (Phase 10). Edits write to the selected scope —
 * User (applies everywhere) or Workspace (overrides User for this project) —
 * and immediately re-apply to the running app.
 */
export function GeneralSection({ query = "" }: { query?: string }) {
  const [scope, setScope] = useState<SettingScope>("user");
  const [, setTick] = useState(0);
  const applyEffectiveSettings = useApp((s) => s.applyEffectiveSettings);

  useEffect(() => subscribeSettings(() => setTick((n) => n + 1)), []);

  const effective = effectiveSettings();
  const specs = useMemo(() => searchSettings(query), [query]);
  const groups = useMemo(() => groupByCategory(specs), [specs]);

  const update = (key: string, value: boolean | string | number) => {
    setSetting(scope, key, value);
    applyEffectiveSettings();
  };
  const reset = (key: string) => {
    resetSetting(scope, key);
    applyEffectiveSettings();
  };

  return (
    <div className="space-y-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            User settings apply everywhere; workspace settings override them for this project.
          </p>
        </div>
        <Tabs value={scope} onValueChange={(v) => setScope(v as SettingScope)}>
          <TabsList className="h-8">
            <TabsTrigger value="user" className="text-xs">
              User
            </TabsTrigger>
            <TabsTrigger value="workspace" className="text-xs">
              Workspace
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </header>

      {specs.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No settings match “{query}”.
        </p>
      )}

      {groups.map(([category, items]) => (
        <Card key={category}>
          <CardHeader>
            <CardTitle>{category}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            {items.map((spec) => (
              <SettingRow
                key={spec.key}
                spec={spec}
                value={effective[spec.key]}
                source={effectiveSource(spec.key)}
                onChange={(v) => update(spec.key, v)}
                onReset={() => reset(spec.key)}
              />
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function SettingRow({
  spec,
  value,
  source,
  onChange,
  onReset,
}: {
  spec: SettingSpec;
  value: boolean | string | number;
  source: "default" | SettingScope;
  onChange: (v: boolean | string | number) => void;
  onReset: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Label className="text-[13px]">{spec.label}</Label>
          {source !== "default" && (
            <span
              className={cn(
                "rounded px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide",
                source === "workspace"
                  ? "bg-primary/15 text-primary"
                  : "bg-accent text-muted-foreground",
              )}
            >
              {source}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{spec.description}</p>
        <code className="text-[10px] text-muted-foreground/70">{spec.key}</code>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <SettingControl spec={spec} value={value} onChange={onChange} />
        {source !== "default" && (
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            title="Reset to default"
            aria-label={`Reset ${spec.label}`}
            onClick={onReset}
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

function SettingControl({
  spec,
  value,
  onChange,
}: {
  spec: SettingSpec;
  value: boolean | string | number;
  onChange: (v: boolean | string | number) => void;
}) {
  if (spec.type === "boolean") {
    return <Switch checked={value === true} onCheckedChange={(v) => onChange(v)} />;
  }
  if (spec.type === "enum") {
    return (
      <Select value={String(value)} onValueChange={(v) => onChange(v)}>
        <SelectTrigger className="h-8 w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(spec.options ?? []).map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  if (spec.type === "number") {
    return (
      <Input
        type="number"
        className="h-8 w-24"
        value={String(value)}
        min={spec.min}
        max={spec.max}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isNaN(n)) onChange(n);
        }}
      />
    );
  }
  return (
    <Input
      className="h-8 w-44"
      value={String(value)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function groupByCategory(specs: SettingSpec[]): [string, SettingSpec[]][] {
  const map = new Map<string, SettingSpec[]>();
  for (const spec of specs) {
    const list = map.get(spec.category) ?? [];
    list.push(spec);
    map.set(spec.category, list);
  }
  return Array.from(map.entries());
}
