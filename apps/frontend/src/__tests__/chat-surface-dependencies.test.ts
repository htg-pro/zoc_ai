// Feature: zoc-agent-chat-rebuild, Task 12.2: the frontend dependencies the
// Chat_Surface needs.
// Requirements: 5.2 (`@ai-sdk/react` pinned to the ai-v6 line), 5.6 (one
// library per capability, each pinned), 19.6 (one animation library), and 4.4
// (the security overrides are preserved).
//
// The motion-layer half is asserted too, and as of task 26.5 it is asserted in
// both directions: the five superseded keyframes are gone from
// `src/styles/globals.css` and must stay gone, and the nine that survive are
// pinned because something live resolves to each. See the block below for why
// the count is five and not twelve.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";

/** Walk up from the test runner's cwd to `apps/frontend`, wherever it was invoked from. */
function findAppRoot(): string {
  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    const manifest = path.join(dir, "package.json");
    if (existsSync(manifest)) {
      const { name } = JSON.parse(readFileSync(manifest, "utf-8")) as { name?: string };
      if (name === "@zoc-studio/frontend") return dir;
    }
    if (existsSync(path.join(dir, "apps/frontend/package.json"))) {
      return path.join(dir, "apps/frontend");
    }
    dir = path.dirname(dir);
  }
  throw new Error(`could not locate apps/frontend from ${process.cwd()}`);
}

function findRepoRoot(from: string): string {
  let dir = from;
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`could not locate pnpm-workspace.yaml from ${from}`);
}

const appRoot = findAppRoot();
const repoRoot = findRepoRoot(appRoot);

type PackageManifest = {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

const pkg = JSON.parse(
  readFileSync(path.join(appRoot, "package.json"), "utf-8"),
) as PackageManifest;

const workspaceYaml = readFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "utf-8");
const globalsCss = readFileSync(path.join(appRoot, "src/styles/globals.css"), "utf-8");

/** Lint one snippet through the app's real flat config and return the R5.6 findings. */
async function motionBudgetFindings(source: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: appRoot });
  const [result] = await eslint.lintText(source, {
    filePath: path.join(appRoot, "src/features/chat/__motion-budget-probe.tsx"),
    warnIgnored: false,
  });
  return result.messages
    .filter((message) => message.ruleId === "no-restricted-imports")
    .map((message) => message.message);
}

describe("Chat_Surface frontend dependencies (task 12.2)", () => {
  describe("one library per capability, each pinned (R5.6)", () => {
    it("pins the animation library to an exact version", () => {
      expect(pkg.dependencies.motion).toBe("12.42.2");
    });

    it("pins the markdown renderer to an exact version", () => {
      expect(pkg.dependencies["react-markdown"]).toBe("10.1.0");
    });

    it("carries dompurify as a direct dependency at the overridden range", () => {
      // Promoted from a transitive override to a direct dependency: same range,
      // so no bytes and no lockfile entry are added.
      expect(pkg.dependencies.dompurify).toBe("^3.4.11");
    });

    it("keeps monaco-editor as the only syntax highlighter", () => {
      expect(pkg.dependencies["monaco-editor"]).toBe(
        "npm:@codingame/monaco-vscode-editor-api@25.1.2",
      );
      const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
      expect(names).not.toContain("shiki");
      expect(names).not.toContain("prismjs");
      expect(names).not.toContain("highlight.js");
    });

    it("adds no second animation or markdown library", () => {
      const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
      expect(names).not.toContain("framer-motion");
      expect(names).not.toContain("streamdown");
      expect(names).not.toContain("react-spring");
      expect(names).not.toContain("marked");
    });
  });

  describe("useChat comes from the ai-v6 line (R5.2)", () => {
    it("pins @ai-sdk/react to the exact ai-v6 dist-tag version, not a loose range", () => {
      // A loose `^3` resolves into the `ai@7` line and breaks the transport
      // against the `ai@6.0.235` runtime.
      expect(pkg.dependencies["@ai-sdk/react"]).toBe("3.0.237");
      expect(pkg.dependencies.ai).toBe("6.0.235");
    });
  });

  describe("lint tooling", () => {
    it("carries the maintained eslint-comments fork as a devDependency", () => {
      expect(pkg.devDependencies["@eslint-community/eslint-plugin-eslint-comments"]).toBeTruthy();
    });
  });

  describe("nothing already present was re-added", () => {
    it.each([
      "@tanstack/react-virtual",
      "cmdk",
      "fuse.js",
      "monaco-editor",
      "@radix-ui/react-collapsible",
    ])("keeps %s as a single runtime dependency", (name) => {
      expect(pkg.dependencies[name]).toBeTruthy();
      expect(pkg.devDependencies[name]).toBeUndefined();
    });

    it("keeps fast-check as a devDependency only", () => {
      expect(pkg.devDependencies["fast-check"]).toBeTruthy();
      expect(pkg.dependencies["fast-check"]).toBeUndefined();
    });

    it("declares no package in both dependency sets", () => {
      const duplicated = Object.keys(pkg.dependencies).filter(
        (name) => name in pkg.devDependencies,
      );
      expect(duplicated).toEqual([]);
    });
  });

  describe("security overrides are preserved (R4.4)", () => {
    it("keeps both workspace overrides", () => {
      expect(workspaceYaml).toContain('"dompurify@<3.4.9": "^3.4.11"');
      expect(workspaceYaml).toContain('"js-yaml@<4.2.0": "^4.2.0"');
    });
  });

  /**
   * Task 26.5 narrowed the motion layer, and this block is the inversion of the
   * table that used to guard it. The assertion that the legacy keyframes are
   * *gone* is worth more than the assertion that they are present: it is the
   * only thing that would catch a re-introduction.
   *
   * **Five, not twelve.** 26.2 listed twelve keyframes as legacy-panel-only.
   * Seven of them are not: six are the animations the Motion_System layer's
   * `.motion-*` classes resolve to — `lib/reduced-motion.ts` pins those class
   * names and Property 12.5 asserts the mapping — and `pulse-status` plus
   * `pulse-dot` also have live component callers (`SessionsView.tsx`,
   * `EditorArea.tsx`, `SidePanel.tsx`, and `MonacoView.tsx` via
   * `motion-caret-blink`). Deleting a keyframe out from under a class that
   * survives fails nothing, because CSS drops an unknown `animation-name`
   * silently — which is what the third test below exists to catch.
   */
  describe("the motion layer is narrowed to what survives (task 26.5)", () => {
    it.each([
      "zoc-pulse",
      "zoc-check-pop",
      "zoc-success-flash",
      "pulse-primary",
      "pulse-dot-green",
    ])("no longer defines the superseded %s keyframe", (name) => {
      expect(globalsCss).not.toContain(`@keyframes ${name} {`);
    });

    it.each([
      // Motion_System tokens (R6.1) — see `ANIMATED_CLASS` in lib/reduced-motion.ts.
      "orb-breathe",
      "shimmer",
      "fade-row",
      "caret-blink",
      "typing-dot",
      // Motion_System plus live component classes.
      "pulse-dot",
      "pulse-status",
      // Monaco and global chrome.
      "spin",
      "agent-edit-flash-fade",
    ])("still defines the %s keyframe, which something live resolves to", (name) => {
      expect(globalsCss).toContain(`@keyframes ${name} {`);
    });

    // The one that catches the silent half. A `.motion-*` class whose keyframe
    // was deleted still parses, still passes Property 12.5, and simply does not
    // animate — so no assertion about class names or about keyframe names alone
    // would notice. This closes the loop in both directions.
    it("defines every animation it names, and names every animation it defines", () => {
      const named = new Set(
        [...globalsCss.matchAll(/animation(?:-name)?:\s*([a-z][a-z0-9-]*)/g)]
          .map((m) => m[1])
          .filter((name) => name !== "none"),
      );
      const defined = new Set(
        [...globalsCss.matchAll(/@keyframes\s+([a-z][a-z0-9-]*)\s*\{/g)].map((m) => m[1]),
      );
      expect([...named].filter((name) => !defined.has(name))).toEqual([]);
      expect([...defined].filter((name) => !named.has(name))).toEqual([]);
    });
  });

  describe("the motion budget is enforced by lint (R5.6)", () => {
    it("permits the LazyMotion + m pattern", async () => {
      const findings = await motionBudgetFindings(
        'import { LazyMotion, domAnimation, m } from "motion/react";\n' +
          "export const ok = [LazyMotion, domAnimation, m];\n",
      );
      expect(findings).toEqual([]);
    }, 30_000);

    it("refuses the full motion component", async () => {
      const findings = await motionBudgetFindings(
        'import { motion } from "motion/react";\nexport const bad = motion;\n',
      );
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.join("\n")).toContain("LazyMotion");
    }, 30_000);

    it("refuses a namespace import that would defeat the budget", async () => {
      const findings = await motionBudgetFindings(
        'import * as everything from "motion";\nexport const bad = everything;\n',
      );
      expect(findings.length).toBeGreaterThan(0);
    }, 30_000);
  });
});
