import {
  Copyright,
  Cpu,
  ExternalLink,
  Github,
  Package,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

const APP_NAME = "Zoc AI";
const APP_TAGLINE = "Local-first, llama.cpp-powered agentic coding desktop app.";
const APP_DESCRIPTION =
  "Zoc AI pairs a VS Code-style workbench with an autonomous agent that plans, " +
  "edits, and verifies changes directly in your workspace. It ships as a Tauri v2 " +
  "desktop binary with a bundled FastAPI sidecar, and runs entirely on your machine.";
const REPO_URL = "https://github.com/htg-pro/zoc_ai";
const IDENTIFIER = "ai.zoc.studio";
const COPYRIGHT = "\u00A9 2026 Zoc AI contributors";

// Injected at build time from the canonical VERSION file (see vite.config.ts).
const VERSION = __APP_VERSION__;

export function AboutSection() {
  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">About</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Version, build, and project information.
        </p>
      </header>

      <Card>
        <CardContent className="flex items-start gap-4 pt-4">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Sparkles className="h-7 w-7" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold tracking-tight">{APP_NAME}</h2>
              <Badge variant="default">v{VERSION}</Badge>
              <Badge variant="warning">Preview</Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{APP_TAGLINE}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Overview</CardTitle>
        </CardHeader>
        <CardContent className="leading-relaxed text-muted-foreground">
          {APP_DESCRIPTION}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <DetailRow icon={Package} label="Version" value={`${VERSION} (preview)`} />
          <Separator />
          <DetailRow icon={Cpu} label="Application ID" value={IDENTIFIER} />
          <Separator />
          <DetailRow
            icon={ShieldCheck}
            label="Runtime"
            value="Tauri v2 · React 18 · FastAPI sidecar"
          />
          <Separator />
          <DetailRow icon={Copyright} label="Copyright" value={COPYRIGHT} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Project</CardTitle>
        </CardHeader>
        <CardContent>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-accent"
          >
            <Github className="h-4 w-4" />
            <span>htg-pro/zoc_ai</span>
            <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
          </a>
        </CardContent>
      </Card>
    </div>
  );
}

function DetailRow({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Package;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="h-4 w-4" />
        {label}
      </div>
      <span className="text-right text-sm font-medium text-foreground">{value}</span>
    </div>
  );
}
