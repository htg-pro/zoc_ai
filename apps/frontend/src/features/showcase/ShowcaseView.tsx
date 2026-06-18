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
import { AgentRunFeedView } from "@/features/agent/AgentRunFeed";
import { ToolCallCard } from "@/features/agent/ToolCallCard";
import { DiffCard } from "@/features/agent/DiffCard";
import { MessageItem } from "@/features/agent/MessageItem";
import { MOCK_DIFF, MOCK_MESSAGES, MOCK_TOOL_CALL } from "@/lib/mock-data";
import type { ToolCall } from "@zoc-studio/shared-types";

const TOOL_STATES: ToolCall[] = (["pending", "running", "succeeded", "failed", "needs_approval"] as const).map((status, i) => ({
  ...MOCK_TOOL_CALL,
  id: `showcase-${i}`,
  status,
  name: `tool.${status}`,
  error: status === "failed" ? "fs.write: ENOENT '/tmp/x'" : null,
}));

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
          <div className="space-y-3">
            {MOCK_MESSAGES.map((m) => (
              <MessageItem key={m.id} message={m} />
            ))}
          </div>
        </Story>

        <Story title="Tool calls (all states)">
          <div className="space-y-2">
            {TOOL_STATES.map((t) => (
              <ToolCallCard key={t.id} call={t} />
            ))}
          </div>
        </Story>

        <Story title="Diff card">
          <DiffCard patch={MOCK_DIFF} />
        </Story>

        <Story title="Agent workflow timeline">
          <div className="max-w-sm">
            <AgentRunFeedView events={[]} />
          </div>
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
