import {
  Files,
  Search,
  GitBranch,
  Bug,
  Database,
  ListTree,
  History,
  Blocks,
  FlaskConical,
  MessageSquare,
  Settings,
  Palette,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useApp, type ActivityView } from "@/lib/store";
import { cn } from "@/lib/utils";

interface Item {
  key: ActivityView | "showcase" | "extensions" | "testing";
  label: string;
  icon: typeof Files;
  shortcut?: string;
}

const TOP: Item[] = [
  { key: "files", label: "Explorer", icon: Files, shortcut: "⌘1" },
  { key: "search", label: "Search", icon: Search, shortcut: "⌘⇧F" },
  { key: "scm", label: "Source Control", icon: GitBranch, shortcut: "⌘⇧G" },
  { key: "debug", label: "Run and Debug", icon: Bug, shortcut: "⌘⇧D" },
  { key: "testing", label: "Testing", icon: FlaskConical },
  { key: "extensions", label: "Extensions", icon: Blocks },
  { key: "outline", label: "Outline", icon: ListTree },
  { key: "timeline", label: "Timeline", icon: History },
  { key: "indexer", label: "Indexer", icon: Database, shortcut: "⌘2" },
  { key: "sessions", label: "Sessions", icon: MessageSquare, shortcut: "⌘3" },
];

const BOTTOM: Item[] = [
  { key: "showcase", label: "Component showcase", icon: Palette },
  { key: "settings", label: "Settings", icon: Settings, shortcut: "⌘," },
];

export function ActivityBar() {
  const activity = useApp((s) => s.activity);
  const mainView = useApp((s) => s.mainView);
  const setActivity = useApp((s) => s.setActivity);
  const setMainView = useApp((s) => s.setMainView);
  const toggleSide = useApp((s) => s.toggleSide);
  const sidePanelOpen = useApp((s) => s.layout.sidePanelOpen);
  const git = useApp((s) => s.git);
  const taskRuns = useApp((s) => s.taskRuns);

  const scmCount = git
    ? git.staged.length + git.unstaged.length + git.untracked.length + git.conflicts.length
    : 0;
  const failingTasks = Object.values(taskRuns).filter((s) => s === "failed").length;

  const badgeFor = (key: Item["key"]): number => {
    if (key === "scm") return scmCount;
    if (key === "testing") return failingTasks;
    return 0;
  };

  const handleClick = (item: Item) => {
    if (item.key === "settings") {
      // Toggle: clicking Settings again returns to the editor instead of
      // leaving the user stuck on the settings page.
      setMainView(mainView === "settings" ? "editor" : "settings");
      return;
    }
    if (item.key === "showcase") {
      setMainView(mainView === "showcase" ? "editor" : "showcase");
      return;
    }
    if (item.key === "extensions") {
      // Extensions live in the Settings view (Phase 12).
      useApp.getState().openSettings("extensions");
      return;
    }
    if (item.key === "testing") {
      // Testing is the tests-first Tasks panel in the bottom dock (Phase 6).
      useApp.getState().setBottomTab("tasks");
      if (!useApp.getState().layout.bottomDockOpen) useApp.getState().toggleBottom();
      return;
    }
    if (item.key === activity && sidePanelOpen) {
      toggleSide();
      return;
    }
    if (!sidePanelOpen) toggleSide();
    setActivity(item.key);
    setMainView(item.key === "sessions" ? "sessions" : "editor");
  };

  return (
    <nav
      className="flex h-full w-12 shrink-0 flex-col items-center justify-between border-r border-border bg-[hsl(var(--surface))] py-2"
      aria-label="Primary"
    >
      <div className="flex w-full flex-col items-center gap-1">
        {TOP.map((item) => (
          <ActivityButton
            key={item.key}
            item={item}
            badge={badgeFor(item.key)}
            active={
              item.key === "sessions"
                ? mainView === "sessions" || (mainView === "editor" && item.key === activity && sidePanelOpen)
                : mainView === "editor" && item.key === activity && sidePanelOpen
            }
            onClick={() => handleClick(item)}
          />
        ))}
      </div>
      <div className="flex flex-col items-center gap-1">
        {BOTTOM.map((item) => (
          <ActivityButton
            key={item.key}
            item={item}
            active={
              (item.key === "settings" && mainView === "settings") ||
              (item.key === "showcase" && mainView === "showcase")
            }
            onClick={() => handleClick(item)}
          />
        ))}
      </div>
    </nav>
  );
}

function ActivityButton({
  item,
  active,
  onClick,
  badge = 0,
}: {
  item: Item;
  active: boolean;
  onClick: () => void;
  badge?: number;
}) {
  const Icon = item.icon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="relative flex w-full justify-center">
          {/* Purple left indicator bar */}
          {active && (
            <span className="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r bg-primary" />
          )}
          <button
            type="button"
            aria-label={badge > 0 ? `${item.label} (${badge})` : item.label}
            aria-pressed={active}
            onClick={onClick}
            className={cn(
              "flex h-[34px] w-[34px] items-center justify-center rounded-lg text-muted-foreground transition-colors",
              "hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active && "bg-[hsl(var(--primary)/0.12)] text-primary",
            )}
          >
            <Icon className="h-[18px] w-[18px]" />
          </button>
          {badge > 0 && (
            <span
              className="absolute right-1 top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold leading-none text-primary-foreground"
              aria-hidden
            >
              {badge > 99 ? "99+" : badge}
            </span>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent side="right">
        <div className="flex items-center gap-2">
          <span>{item.label}</span>
          {item.shortcut && (
            <span className="font-mono text-[10px] text-muted-foreground">{item.shortcut}</span>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
