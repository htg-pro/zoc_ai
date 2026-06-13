import type { Story } from "@ladle/react";
import { Button } from "./button";
import { Input } from "./input";
import { Textarea } from "./textarea";
import { Badge } from "./badge";
import { Card } from "./card";
import { Separator } from "./separator";
import { Switch } from "./switch";
import { Label } from "./label";
import { Checkbox } from "./checkbox";
import { Tabs, TabsList, TabsTrigger } from "./tabs";
import { Tooltip, TooltipTrigger, TooltipContent } from "./tooltip";
import { Kbd } from "./kbd";

export default { title: "Primitives" };

export const Buttons: Story = () => (
  <div className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center gap-2">
      <Button>Primary</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="outline">Outline</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="destructive">Destructive</Button>
      <Button disabled>Disabled</Button>
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm">Small</Button>
      <Button>Default</Button>
      <Button size="lg">Large</Button>
    </div>
  </div>
);

export const Inputs: Story = () => (
  <div className="flex max-w-md flex-col gap-3">
    <div className="space-y-1">
      <Label htmlFor="email">Email</Label>
      <Input id="email" placeholder="you@example.com" />
    </div>
    <div className="space-y-1">
      <Label htmlFor="msg">Message</Label>
      <Textarea id="msg" placeholder="Tell the agent what to do…" />
    </div>
    <div className="flex items-center gap-2">
      <Checkbox id="agree" />
      <Label htmlFor="agree">Apply to all files</Label>
    </div>
    <div className="flex items-center gap-2">
      <Switch id="auto" defaultChecked />
      <Label htmlFor="auto">Auto-approve safe tools</Label>
    </div>
  </div>
);

export const Badges: Story = () => (
  <div className="flex flex-wrap gap-2">
    <Badge>Default</Badge>
    <Badge variant="secondary">Secondary</Badge>
    <Badge variant="outline">Outline</Badge>
    <Badge variant="success">+42</Badge>
    <Badge variant="destructive">−8</Badge>
  </div>
);

export const Cards: Story = () => (
  <div className="grid max-w-2xl grid-cols-2 gap-3">
    <Card className="p-4">
      <h3 className="text-sm font-semibold">Indexing</h3>
      <p className="mt-1 text-xs text-muted-foreground">3,214 chunks · 128 files</p>
      <Separator className="my-3" />
      <Button size="sm" variant="outline">Reindex</Button>
    </Card>
    <Card className="p-4">
      <h3 className="text-sm font-semibold">Permissions</h3>
      <p className="mt-1 text-xs text-muted-foreground">Approvals required for shell + writes.</p>
    </Card>
  </div>
);

export const TabsAndTooltip: Story = () => (
  <div className="flex max-w-md flex-col gap-4">
    <Tabs defaultValue="a">
      <TabsList>
        <TabsTrigger value="a">Inline</TabsTrigger>
        <TabsTrigger value="b">Split</TabsTrigger>
      </TabsList>
    </Tabs>
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size="sm">
          Hover me <Kbd className="ml-2">⌘K</Kbd>
        </Button>
      </TooltipTrigger>
      <TooltipContent>Open command palette</TooltipContent>
    </Tooltip>
  </div>
);
