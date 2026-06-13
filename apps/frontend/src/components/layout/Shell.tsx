import { useCallback } from "react";
import { Group, Panel, Separator, type Layout } from "react-resizable-panels";
import { ActivityBar } from "./ActivityBar";
import { TopBar } from "./TopBar";
import { SidePanel } from "./SidePanel";
import { BottomDock } from "./BottomDock";
import { EditorArea } from "@/features/editor/EditorArea";
import { AgentPanel } from "@/features/agent/AgentPanel";
import { SessionsView } from "@/features/sessions/SessionsView";
import { SettingsView } from "@/features/settings/SettingsView";
import { DiffReviewView } from "@/features/diff/DiffReviewView";
import { ShowcaseView } from "@/features/showcase/ShowcaseView";
import { CommandPalette } from "@/features/palette/CommandPalette";
import { useApp } from "@/lib/store";
import { useGlobalShortcuts } from "@/lib/key-bindings";
import { useViewport } from "@/lib/use-viewport";
import { Toaster } from "@/components/ui/toast";

const HANDLE_H = "h-full w-[3px] bg-transparent transition-colors hover:bg-primary/40";
const HANDLE_V = "h-[3px] w-full bg-transparent transition-colors hover:bg-primary/40";

function pct(value: number): string {
  return `${value}%`;
}

export function Shell() {
  useGlobalShortcuts();
  const layout = useApp((s) => s.layout);
  const mainView = useApp((s) => s.mainView);
  const setLayoutSizes = useApp((s) => s.setLayoutSizes);
  const vp = useViewport();

  // Panels are sized as percentages of the window (resolution-adaptive) and
  // collapse automatically on narrow windows. The center editor stays mounted
  // across toggles so its scroll/cursor state is preserved.
  const showSide = layout.sidePanelOpen && !vp.hideSide;
  const showRight = layout.rightPanelOpen && !vp.hideRight;
  const showBottom = layout.bottomDockOpen;

  const handleHorizontal = useCallback(
    (l: Layout) => {
      const next: Partial<{ sidePanelSize: number; rightPanelSize: number }> = {};
      if (typeof l.side === "number") next.sidePanelSize = Math.round(l.side);
      if (typeof l.right === "number") next.rightPanelSize = Math.round(l.right);
      if (Object.keys(next).length > 0) setLayoutSizes(next);
    },
    [setLayoutSizes],
  );

  const handleVertical = useCallback(
    (l: Layout) => {
      if (typeof l.bottom === "number") {
        setLayoutSizes({ bottomDockSize: Math.round(l.bottom) });
      }
    },
    [setLayoutSizes],
  );

  return (
    <div className="flex h-dvh max-h-dvh min-h-0 w-screen min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <TopBar />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ActivityBar />
        <Group
          orientation="horizontal"
          className="min-h-0 min-w-0 flex-1"
          onLayoutChanged={handleHorizontal}
        >
          {showSide && (
            <>
              <Panel
                id="side"
                defaultSize={pct(layout.sidePanelSize)}
                minSize="240px"
                maxSize="34%"
                className="min-h-0 min-w-0 border-r border-border"
              >
                <SidePanel />
              </Panel>
              <Separator className={HANDLE_H} />
            </>
          )}
          <Panel id="center" minSize="480px" className="min-h-0 min-w-0">
            <Group orientation="vertical" className="h-full min-h-0 min-w-0" onLayoutChanged={handleVertical}>
              <Panel id="main" minSize="320px" className="min-h-0 min-w-0">
                <MainViewRenderer view={mainView} />
              </Panel>
              {showBottom && (
                <>
                  <Separator className={HANDLE_V} />
                  <Panel
                    id="bottom"
                    defaultSize={pct(layout.bottomDockSize)}
                    minSize="180px"
                    maxSize="52%"
                    className="min-h-0 min-w-0"
                  >
                    <BottomDock />
                  </Panel>
                </>
              )}
            </Group>
          </Panel>
          {showRight && (
            <>
              <Separator className={HANDLE_H} />
              <Panel
                id="right"
                defaultSize={pct(layout.rightPanelSize)}
                minSize="360px"
                maxSize="42%"
                className="min-h-0 min-w-0 border-l border-border"
              >
                <AgentPanel />
              </Panel>
            </>
          )}
        </Group>
      </div>
      <CommandPalette />
      <Toaster theme="dark" position="bottom-right" />
    </div>
  );
}

function MainViewRenderer({ view }: { view: string }) {
  switch (view) {
    case "settings":
      return <SettingsView />;
    case "sessions":
      return <SessionsView />;
    case "diff":
      return <DiffReviewView />;
    case "showcase":
      return <ShowcaseView />;
    case "editor":
    default:
      return <EditorArea />;
  }
}
