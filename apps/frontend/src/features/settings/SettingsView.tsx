import { useEffect, useState } from "react";
import {
  Blocks,
  Cpu,
  Database,
  KeyRound,
  Keyboard,
  Palette,
  Plug,
  Search,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  UserCog,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { useApp } from "@/lib/store";
import { GeneralSection } from "./sections/General";
import { ProvidersSection } from "./sections/Providers";
import { ModelsSection } from "./sections/Models";
import { IndexerSection } from "./sections/Indexer";
import { PermissionsSection } from "./sections/Permissions";
import { AppearanceSection } from "./sections/Appearance";
import { KeybindingsSection } from "./sections/Keybindings";
import { ProfilesSection } from "./sections/Profiles";
import { McpSection } from "./sections/Mcp";
import { ExtensionsSection } from "./sections/Extensions";
import { TrustSection } from "./sections/Trust";
import { cn } from "@/lib/utils";

type Tab =
  | "general"
  | "providers"
  | "models"
  | "indexer"
  | "permissions"
  | "trust"
  | "appearance"
  | "keybindings"
  | "profiles"
  | "mcp"
  | "extensions";

const TABS: { key: Tab; label: string; Icon: typeof Cpu }[] = [
  { key: "general", label: "Settings", Icon: SlidersHorizontal },
  { key: "providers", label: "Providers", Icon: KeyRound },
  { key: "models", label: "Models", Icon: Cpu },
  { key: "indexer", label: "Indexer", Icon: Database },
  { key: "permissions", label: "Permissions", Icon: ShieldCheck },
  { key: "trust", label: "Trust & Safety", Icon: ShieldAlert },
  { key: "appearance", label: "Appearance", Icon: Palette },
  { key: "keybindings", label: "Keybindings", Icon: Keyboard },
  { key: "profiles", label: "Profiles", Icon: UserCog },
  { key: "mcp", label: "MCP Servers", Icon: Plug },
  { key: "extensions", label: "Extensions", Icon: Blocks },
];

const TAB_KEYS = new Set<string>(TABS.map((t) => t.key));

export function SettingsView() {
  const [tab, setTab] = useState<Tab>("general");
  const [query, setQuery] = useState("");
  const settingsSection = useApp((s) => s.settingsSection);
  const openSettings = useApp((s) => s.openSettings);

  // Honor a deep-link (e.g. the "Show Extensions" command), once.
  useEffect(() => {
    if (settingsSection && TAB_KEYS.has(settingsSection)) {
      setTab(settingsSection as Tab);
      openSettings(undefined);
    }
  }, [settingsSection, openSettings]);

  return (
    <div className="flex h-full bg-background">
      <aside className="w-56 shrink-0 border-r border-border p-2">
        <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Settings
        </div>
        <div className="relative px-1 pb-2">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (e.target.value) setTab("general");
            }}
            placeholder="Search settings"
            className="h-8 pl-8 text-xs"
          />
        </div>
        <nav className="flex flex-col gap-0.5">
          {TABS.map(({ key, label, Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={cn(
                "flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent",
                tab === key && "bg-accent text-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </nav>
      </aside>
      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-3xl px-8 py-8">
          {tab === "general" && <GeneralSection query={query} />}
          {tab === "providers" && <ProvidersSection />}
          {tab === "models" && <ModelsSection />}
          {tab === "indexer" && <IndexerSection />}
          {tab === "permissions" && <PermissionsSection />}
          {tab === "trust" && <TrustSection />}
          {tab === "appearance" && <AppearanceSection />}
          {tab === "keybindings" && <KeybindingsSection />}
          {tab === "profiles" && <ProfilesSection />}
          {tab === "mcp" && <McpSection />}
          {tab === "extensions" && <ExtensionsSection />}
        </div>
      </ScrollArea>
    </div>
  );
}
