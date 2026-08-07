import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Kbd } from "@/components/ui/kbd";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Transcript } from "@/features/chat/Transcript";
import { DiffReview } from "@/features/chat/review/DiffReview";
import { FILE_LEVEL_DECISION } from "@/features/chat/store";
import { ToolTimeline } from "@/features/chat/timeline/ToolTimeline";
import type { ToolEntryModel } from "@/features/chat/timeline/tool-entry-model";
import type { ZocUIMessage } from "@/features/chat/wire/ui-message";
import type { DiffPart } from "@zoc-studio/shared-types";

/**
 * Chat_Surface fixtures for the visual catalogue (task 25.6).
 *
 * These replaced the legacy `RunCardView` / `normalizeEvents` / `ToolCallCard` / `DiffCard` /
 * `MessageItem` stories, whose modules 26.1 deletes. The run-card story is gone rather than ported:
 * the Chat_Surface's transcript *is* its run timeline, so the "Messages" story below covers it.
 *
 * Fixtures are literals rather than `lib/mock-data`'s `Message`/`ToolCall`/`DiffPatch` shapes,
 * because those are the legacy wire types and the rows here read `ZocUIMessage`/`ToolEntryModel`/
 * `DiffPart`.
 */
const DEMO_MESSAGES: ZocUIMessage[] = [
  { id: "m1", role: "user", parts: [{ type: "text", text: "Add a settings toggle" }] },
  {
    id: "m2",
    role: "assistant",
    parts: [
      {
        type: "reasoning",
        text: "The switch already exists in `components/ui`, so this is wiring.",
      },
      { type: "text", text: "Wired the existing `Switch` into `SettingsView`. One line of state." },
    ],
  },
];

const TOOL_ENTRIES: ToolEntryModel[] = (
  [
    ["running", "read", "fs.read"],
    ["succeeded", "write", "fs.write"],
    ["failed", "execute", "shell.run"],
    ["denied", "network", "http.fetch"],
  ] as const
).map(([state, kind, toolName], i) => ({
  toolCallId: `showcase-${i}`,
  toolName,
  kind,
  state,
  durationMs: 120 * (i + 1),
  ...(state === "succeeded" ? { metric: "+24 −11" } : {}),
  ...(state === "failed" || state === "denied"
    ? { error: { code: "ENOENT", message: "fs.write: ENOENT '/tmp/x'", retryable: true } }
    : {}),
}));

const DEMO_DIFF: DiffPart = {
  type: "diff",
  seq: 1,
  runId: "demo-run",
  messageId: "m2",
  ts: "2026-08-03T10:00:00.000Z",
  agentName: null,
  planId: "demo-plan",
  path: "apps/frontend/src/features/settings/SettingsView.tsx",
  action: "modify",
  sourcePath: null,
  language: "typescript",
  hunks: [
    {
      hunkId: "h1",
      oldStart: 10,
      oldLines: 1,
      newStart: 10,
      newLines: 2,
      patch: "-const before = 1;\n+const after = 1;\n+const extra = 2;\n",
    },
  ],
  baseDigest: "sha256:base",
  stale: false,
};

/** The story is a static picture, so every decision handler is a no-op. */
const NO_OP = () => {};

export function ShowcaseView() {
  return (
    <ScrollArea className="h-full bg-background">
      <div className="mx-auto max-w-5xl px-8 py-8 space-y-8">
        <header>
          <h1 className="text-lg font-semibold tracking-tight">Component showcase</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Visual catalog covering loading / empty / error / success states. Used in place of
            Storybook for now; the same components render in both modes.
          </p>
        </header>

        <Story title="Buttons">
          <div className="flex flex-wrap gap-2">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">Destructive</Button>
            <Button disabled>Disabled</Button>
            <Button size="sm">Small</Button>
            <Button size="lg">Large</Button>
          </div>
        </Story>

        <Story title="Inputs">
          <div className="grid max-w-md gap-3">
            <div>
              <Label>Label</Label>
              <Input placeholder="Type here…" />
            </div>
            <div>
              <Label>Disabled</Label>
              <Input placeholder="Disabled" disabled />
            </div>
            <div>
              <Label>Textarea</Label>
              <Textarea placeholder="Multi-line…" />
            </div>
            <div className="flex items-center gap-3">
              <Switch defaultChecked />
              <Checkbox defaultChecked />
              <Kbd>⌘K</Kbd>
              <Kbd>⇧</Kbd>
              <Badge>default</Badge>
              <Badge variant="success">ok</Badge>
              <Badge variant="warning">warn</Badge>
              <Badge variant="destructive">error</Badge>
            </div>
          </div>
        </Story>

        <Story title="Messages">
          <Transcript messages={DEMO_MESSAGES} streaming={false} />
        </Story>

        <Story title="Tool calls (all states)">
          <ToolTimeline entries={TOOL_ENTRIES} />
        </Story>

        <Story title="Diff review">
          <DiffReview
            diff={DEMO_DIFF}
            stale={false}
            decisions={{ h1: "accepted", [FILE_LEVEL_DECISION]: "undecided" }}
            isExpanded={() => true}
            onDecideHunk={NO_OP}
            onDecideFile={NO_OP}
            onExpandedChange={NO_OP}
          />
        </Story>

        <Story title="States: loading / empty / error">
          <div className="grid gap-3 md:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle>Loading</CardTitle>
                <CardDescription>Skeleton placeholder</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {[80, 60, 70].map((w, i) => (
                    <div
                      key={i}
                      className="h-3 animate-pulse rounded bg-muted"
                      style={{ width: `${w}%` }}
                    />
                  ))}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Empty</CardTitle>
                <CardDescription>Nothing to show yet</CardDescription>
              </CardHeader>
              <CardContent className="text-center text-xs text-muted-foreground">
                No items.
              </CardContent>
            </Card>
            <Card className="border-destructive/40">
              <CardHeader>
                <CardTitle className="text-destructive">Error</CardTitle>
                <CardDescription>Something went wrong</CardDescription>
              </CardHeader>
              <CardContent className="text-xs text-destructive">
                Failed to load: ECONNREFUSED 127.0.0.1:8765
              </CardContent>
            </Card>
          </div>
        </Story>

        <Separator />
        <footer className="pb-6 text-[11px] text-muted-foreground">
          Zoc AI · Phase 3 UI · light + dark themes share semantic tokens
        </footer>
      </div>
    </ScrollArea>
  );
}

function Story({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      <div className="rounded-lg border border-border bg-card/40 p-4">{children}</div>
    </section>
  );
}
