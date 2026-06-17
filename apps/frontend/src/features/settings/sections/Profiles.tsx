import { useEffect, useState } from "react";
import { Check, Download, Upload } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { useApp } from "@/lib/store";
import {
  BUILTIN_PROFILES,
  activeProfileId,
  applyProfile,
  exportProfile,
  importProfile,
  type ProfileId,
} from "@/lib/profiles";
import { subscribeSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";

/**
 * Profiles (Phase 10): one-click bundles of settings, plus a portable
 * import/export of the current user settings + keybinding overrides.
 */
export function ProfilesSection() {
  const [active, setActive] = useState<ProfileId>(() => activeProfileId());
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const applyEffectiveSettings = useApp((s) => s.applyEffectiveSettings);

  useEffect(() => subscribeSettings(() => setActive(activeProfileId())), []);

  const apply = (id: ProfileId) => {
    applyProfile(id);
    setActive(id);
    applyEffectiveSettings({ includeMode: true });
    toast.success(`Applied ${id} profile`);
  };

  const copyExport = async () => {
    const json = exportProfile();
    try {
      await navigator.clipboard?.writeText(json);
      toast.success("Profile copied to clipboard");
    } catch {
      // Clipboard may be unavailable — surface the JSON in the import box so it
      // can still be copied manually.
      setImportText(json);
      setImportOpen(true);
      toast.info("Clipboard unavailable", { description: "Profile JSON shown below." });
    }
  };

  const doImport = () => {
    try {
      importProfile(importText);
      applyEffectiveSettings({ includeMode: true });
      setImportOpen(false);
      setImportText("");
      toast.success("Profile imported");
    } catch {
      toast.error("Import failed", { description: "The JSON couldn't be parsed." });
    }
  };

  return (
    <div className="space-y-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Profiles</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Apply a starting set of settings, then fine-tune. Export to share or back up.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={copyExport}>
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Export
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setImportOpen((v) => !v)}>
            <Upload className="mr-1.5 h-3.5 w-3.5" />
            Import
          </Button>
        </div>
      </header>

      {importOpen && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Import profile JSON</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              rows={6}
              placeholder='{ "version": 1, "settings": { … }, "keybindings": { … } }'
              className="font-mono text-xs"
              spellCheck={false}
            />
            <div className="flex justify-end">
              <Button size="sm" disabled={!importText.trim()} onClick={doImport}>
                <Check className="mr-1.5 h-3.5 w-3.5" />
                Apply import
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {BUILTIN_PROFILES.map((p) => {
          const isActive = p.id === active;
          return (
            <Card
              key={p.id}
              className={cn("transition-colors", isActive && "border-primary/60 bg-primary/[0.04]")}
            >
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between text-sm">
                  {p.name}
                  {isActive && (
                    <span className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-primary">
                      <Check className="h-3 w-3" /> Active
                    </span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground">{p.description}</p>
                <Button
                  size="sm"
                  variant={isActive ? "secondary" : "default"}
                  className="w-full"
                  onClick={() => apply(p.id)}
                >
                  {isActive ? "Re-apply" : "Apply"}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
