import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

type Theme = "dark" | "light" | "system";

export function AppearanceSection() {
  const [theme, setTheme] = useState<Theme>("dark");
  const [dense, setDense] = useState(true);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    const apply = (t: Theme) => {
      if (t === "system") {
        const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
        root.classList.toggle("dark", dark);
      } else {
        root.classList.toggle("dark", t === "dark");
      }
    };
    apply(theme);
  }, [theme]);

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Appearance</h1>
        <p className="mt-1 text-sm text-muted-foreground">Theme, density, and motion.</p>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>Theme</CardTitle>
          <CardDescription>Dark is the default Llama Studio aesthetic.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="grid grid-cols-[8rem_1fr] items-center gap-3">
            <Label>Mode</Label>
            <Select value={theme} onValueChange={(v) => setTheme(v as Theme)}>
              <SelectTrigger className="h-8 w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="dark">Dark</SelectItem>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="system">System</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label>Compact density</Label>
              <p className="text-xs text-muted-foreground">Tighter spacing for power users.</p>
            </div>
            <Switch checked={dense} onCheckedChange={setDense} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label>Reduce motion</Label>
              <p className="text-xs text-muted-foreground">Disable subtle animations.</p>
            </div>
            <Switch checked={reduced} onCheckedChange={setReduced} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
