import type { ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import type { PaneNode, TerminalPane } from "@/lib/terminal-layout";

/**
 * Recursive multi-pane terminal renderer (Part 6.1). Renders the pane tree with
 * react-resizable-panels: a `SplitNode` becomes a resizable `PanelGroup`, and a
 * `TerminalPane` leaf hosts whatever `renderPane` returns (the xterm session
 * view). Leaf hosting is injected so this stays decoupled from the terminal
 * runtime.
 */
export interface TerminalPanesProps {
  node: PaneNode | null;
  focusedPaneId: string | null;
  renderPane: (pane: TerminalPane) => ReactNode;
  onFocusPane?: (paneId: string) => void;
}

export function TerminalPanes({
  node,
  focusedPaneId,
  renderPane,
  onFocusPane,
}: TerminalPanesProps): ReactNode {
  if (node === null) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        No terminal panes
      </div>
    );
  }
  if (node.kind === "pane") {
    const focused = node.id === focusedPaneId;
    return (
      <div
        data-pane={node.id}
        data-focused={focused}
        onMouseDown={() => onFocusPane?.(node.id)}
        className={`h-full w-full overflow-hidden ${focused ? "ring-1 ring-[var(--zoc-ember)]/50" : ""}`}
      >
        {renderPane(node)}
      </div>
    );
  }
  return (
    <Group
      orientation={node.direction === "row" ? "horizontal" : "vertical"}
      className="h-full w-full min-h-0 min-w-0"
    >
      <Panel id={node.a.id} minSize="15%" className="min-h-0 min-w-0">
        <TerminalPanes
          node={node.a}
          focusedPaneId={focusedPaneId}
          renderPane={renderPane}
          onFocusPane={onFocusPane}
        />
      </Panel>
      <Separator
        className={
          node.direction === "row"
            ? "w-px bg-border hover:bg-[var(--zoc-ember)]/60"
            : "h-px bg-border hover:bg-[var(--zoc-ember)]/60"
        }
      />
      <Panel id={node.b.id} minSize="15%" className="min-h-0 min-w-0">
        <TerminalPanes
          node={node.b}
          focusedPaneId={focusedPaneId}
          renderPane={renderPane}
          onFocusPane={onFocusPane}
        />
      </Panel>
    </Group>
  );
}
