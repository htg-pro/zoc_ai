import type {
  DiffPatch,
  IndexStatus,
  Message,
  Plan,
  ProviderDescriptor,
  Session,
  ToolCall,
} from "@llama-studio/shared-types";

export interface FileNode {
  id: string;
  name: string;
  path: string;
  kind: "file" | "dir";
  children?: FileNode[];
  language?: string;
}

export const MOCK_TREE: FileNode[] = [
  {
    id: "root",
    name: "llama-studio",
    path: "/",
    kind: "dir",
    children: [
      {
        id: "src",
        name: "src",
        path: "/src",
        kind: "dir",
        children: [
          { id: "app", name: "App.tsx", path: "/src/App.tsx", kind: "file", language: "typescript" },
          { id: "main", name: "main.tsx", path: "/src/main.tsx", kind: "file", language: "typescript" },
          {
            id: "components",
            name: "components",
            path: "/src/components",
            kind: "dir",
            children: [
              { id: "btn", name: "Button.tsx", path: "/src/components/Button.tsx", kind: "file", language: "typescript" },
              { id: "ipt", name: "Input.tsx", path: "/src/components/Input.tsx", kind: "file", language: "typescript" },
            ],
          },
        ],
      },
      {
        id: "services",
        name: "services",
        path: "/services",
        kind: "dir",
        children: [
          { id: "agt", name: "agent.py", path: "/services/agent.py", kind: "file", language: "python" },
        ],
      },
      { id: "readme", name: "README.md", path: "/README.md", kind: "file", language: "markdown" },
      { id: "pkg", name: "package.json", path: "/package.json", kind: "file", language: "json" },
    ],
  },
];

export const MOCK_FILE_CONTENT: Record<string, { language: string; content: string }> = {
  "/src/App.tsx": {
    language: "typescript",
    content: `import { Shell } from "@/components/layout/Shell";

export function App() {
  return <Shell />;
}
`,
  },
  "/src/main.tsx": {
    language: "typescript",
    content: `import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
`,
  },
  "/services/agent.py": {
    language: "python",
    content: `from fastapi import FastAPI

app = FastAPI()

@app.get("/health")
def health():
    return {"status": "ok"}
`,
  },
  "/README.md": {
    language: "markdown",
    content: `# Zoc AI\n\nA local agentic coding desktop app.\n`,
  },
  "/package.json": {
    language: "json",
    content: `{\n  "name": "llama-studio",\n  "private": true\n}\n`,
  },
  "/src/components/Button.tsx": {
    language: "typescript",
    content: `export function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {\n  return <button {...props} />;\n}\n`,
  },
  "/src/components/Input.tsx": {
    language: "typescript",
    content: `export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {\n  return <input {...props} />;\n}\n`,
  },
};

const nowIso = (offset = 0) => new Date(Date.now() - offset).toISOString();

export const MOCK_PLAN: Plan = {
  id: "plan-1",
  goal: "Add a settings screen with provider configuration",
  created_at: nowIso(60_000),
  steps: [
    { id: "s1", title: "Scan existing settings module", status: "done", attempt: 1, done: true },
    { id: "s2", title: "Draft Providers tab layout", status: "done", attempt: 1, done: true },
    { id: "s3", title: "Add secure-store wiring", status: "running", attempt: 1, done: false },
    { id: "s4", title: "Add unit tests for SettingsForm", status: "pending", attempt: 0, done: false },
    { id: "s5", title: "Update docs", status: "pending", attempt: 0, done: false },
  ],
};

export const MOCK_TOOL_CALL: ToolCall = {
  id: "tc-1",
  name: "fs.write",
  arguments: { path: "/src/features/settings/SettingsView.tsx", bytes: 4823 },
  status: "succeeded",
  result: { written: 4823, sha: "9f1b…" },
  started_at: nowIso(8_000),
  finished_at: nowIso(2_000),
};

export const MOCK_DIFF: DiffPatch = {
  id: "d-1",
  file_path: "/src/features/settings/SettingsView.tsx",
  summary: "Add Providers section with API key fields",
  unified_diff: `--- a/src/features/settings/SettingsView.tsx
+++ b/src/features/settings/SettingsView.tsx
@@ -1,3 +1,12 @@
-export function SettingsView() {
-  return <div>TODO</div>;
+import { ProvidersSection } from "./sections/Providers";
+import { ModelsSection } from "./sections/Models";
+
+export function SettingsView() {
+  return (
+    <div className="space-y-6 p-6">
+      <ProvidersSection />
+      <ModelsSection />
+    </div>
+  );
 }
`,
};

export const MOCK_DIFF_2: DiffPatch = {
  id: "d-2",
  file_path: "/src/features/settings/sections/Providers.tsx",
  summary: "New file: providers section",
  unified_diff: `--- /dev/null
+++ b/src/features/settings/sections/Providers.tsx
@@ -0,0 +1,8 @@
+export function ProvidersSection() {
+  return (
+    <section>
+      <h2>Providers</h2>
+    </section>
+  );
+}
`,
};

export const MOCK_MESSAGES: Message[] = [
  {
    id: "m1",
    role: "user",
    content: "Add a settings screen with provider configuration and API key management.",
    created_at: nowIso(120_000),
  },
  {
    id: "m2",
    role: "assistant",
    content:
      "Got it. I'll add a sectioned settings view, wire the providers form, and keep secrets in the secure store. Drafting a plan now…",
    created_at: nowIso(115_000),
  },
  {
    id: "m3",
    role: "assistant",
    content:
      "Drafted a 5-step plan. Step 1 is done — I scanned the existing module and found no prior settings screen.",
    created_at: nowIso(60_000),
  },
];

export const MOCK_SESSIONS: Session[] = [
  {
    id: "sess-1",
    title: "Add settings screen",
    status: "active",
    workspace_root: "/home/me/llama-studio",
    provider: "llamacpp",
    model: "qwen2.5-coder-32b",
    created_at: nowIso(3_600_000),
    updated_at: nowIso(60_000),
    messages: MOCK_MESSAGES,
    plan: MOCK_PLAN,
    tool_calls: [MOCK_TOOL_CALL],
  },
  {
    id: "sess-2",
    title: "Refactor agent loop",
    status: "idle",
    workspace_root: "/home/me/llama-studio",
    provider: "openai",
    model: "gpt-4o-mini",
    created_at: nowIso(86_400_000),
    updated_at: nowIso(7_200_000),
    messages: [],
    plan: null,
    tool_calls: [],
  },
  {
    id: "sess-3",
    title: "Onboarding flow polish",
    status: "closed",
    workspace_root: "/home/me/llama-studio",
    provider: "anthropic",
    model: "claude-3-5-sonnet",
    created_at: nowIso(86_400_000 * 3),
    updated_at: nowIso(86_400_000 * 2),
    messages: [],
    plan: null,
    tool_calls: [],
  },
  {
    id: "sess-4",
    title: "retry Mellum2-12B-A2.5B-Thinking",
    status: "active",
    workspace_root: "/home/me/zoom-website",
    provider: "llamacpp",
    model: "Mellum2-12B-A2.5B-Thinking.Q4_K_M.gguf",
    created_at: nowIso(8 * 3_600_000),
    updated_at: nowIso(15 * 60_000),
    messages: [],
    plan: null,
    tool_calls: [],
  },
  {
    id: "sess-5",
    title: "Codex A-Z demo portfolio workflow",
    status: "idle",
    workspace_root: "/home/me/zoom-website",
    provider: "llamacpp",
    model: "Qwopus3.5-9B-Coder-MTP.Q6_K.gguf",
    created_at: nowIso(10 * 3_600_000),
    updated_at: nowIso(3 * 3_600_000),
    messages: [],
    plan: null,
    tool_calls: [],
  },
  {
    id: "sess-6",
    title: "retry Qwopus3.5-9B-Coder-MTP",
    status: "idle",
    workspace_root: "/home/me/zoom-website",
    provider: "llamacpp",
    model: "Qwopus3.5-9B-Coder-MTP.Q6_K.gguf",
    created_at: nowIso(11 * 3_600_000),
    updated_at: nowIso(7 * 3_600_000),
    messages: [],
    plan: null,
    tool_calls: [],
  },
  {
    id: "sess-7",
    title: "retry gemma-4-e2b-it.Q8_0",
    status: "idle",
    workspace_root: "/home/me/zoom-website",
    provider: "llamacpp",
    model: "gemma-4-e2b-it.Q8_0.gguf",
    created_at: nowIso(12 * 3_600_000),
    updated_at: nowIso(8 * 3_600_000),
    messages: [],
    plan: null,
    tool_calls: [],
  },
  {
    id: "sess-8",
    title: "retry MiniCPM5-1B-F16",
    status: "idle",
    workspace_root: "/home/me/zoom-website",
    provider: "llamacpp",
    model: "MiniCPM5-1B.F16.gguf",
    created_at: nowIso(13 * 3_600_000),
    updated_at: nowIso(8 * 3_600_000),
    messages: [],
    plan: null,
    tool_calls: [],
  },
  {
    id: "sess-9",
    title: "matrix gemma-4-E4B-it-UD-Q8_K_XL",
    status: "idle",
    workspace_root: "/home/me/zoom-website",
    provider: "llamacpp",
    model: "gemma-4-E4B-it-UD.Q8_K_XL.gguf",
    created_at: nowIso(14 * 3_600_000),
    updated_at: nowIso(9 * 3_600_000),
    messages: [],
    plan: null,
    tool_calls: [],
  },
  {
    id: "sess-10",
    title: "matrix Mellum2-12B-A2.5B-Thinking",
    status: "idle",
    workspace_root: "/home/me/zoom-website",
    provider: "llamacpp",
    model: "Mellum2-12B-A2.5B-Thinking.Q4_K_M.gguf",
    created_at: nowIso(86_400_000 + 6 * 3_600_000),
    updated_at: nowIso(86_400_000 + 6 * 3_600_000),
    messages: [],
    plan: null,
    tool_calls: [],
  },
  {
    id: "sess-11",
    title: "Codex portfolio build validation",
    status: "idle",
    workspace_root: "/home/me/zoom-website",
    provider: "llamacpp",
    model: "Qwopus3.5-9B-Coder-MTP.Q6_K.gguf",
    created_at: nowIso(86_400_000 + 8 * 3_600_000),
    updated_at: nowIso(86_400_000 + 8 * 3_600_000),
    messages: [],
    plan: null,
    tool_calls: [],
  },
  {
    id: "sess-12",
    title: "Zoom website auto workflow",
    status: "idle",
    workspace_root: "/home/me/zoom-website",
    provider: "llamacpp",
    model: "Qwopus3.5-9B-Coder-MTP.Q6_K.gguf",
    created_at: nowIso(86_400_000 + 10 * 3_600_000),
    updated_at: nowIso(86_400_000 + 10 * 3_600_000),
    messages: [],
    plan: null,
    tool_calls: [],
  },
];

/** Sessions pre-pinned by default in non-live (mock) mode. */
export const MOCK_PINNED_SESSION_IDS: string[] = ["sess-4", "sess-5"];

/** Pre-seeded file VCS status for the mock workspace, matching the mockups. */
export const MOCK_FILE_STATUS: Record<string, "A" | "M" | "D"> = {
  "/src/App.tsx": "M",
  "/src/index.css": "M",
  "/src/main.tsx": "M",
  "/package.json": "M",
  "/README.md": "M",
  "/src/components/Dashboard.tsx": "A",
  "/src/components/SessionCard.tsx": "A",
};

export const MOCK_INDEX_STATUS: IndexStatus = {
  workspace_root: "/home/me/llama-studio",
  file_count: 1284,
  chunk_count: 5217,
  last_indexed_at: nowIso(45_000),
  watching: true,
  embedder: {
    kind: "llamacpp",
    model: "nomic-embed-text",
    dim: 768,
    is_fallback: false,
  },
};

export const MOCK_PROVIDERS: ProviderDescriptor[] = [
  // NOTE: the `llamacpp` provider intentionally has no entry here. Local
  // models come from the user-managed `LocalModel` list in
  // apps/frontend/src/lib/local-models.ts — the ModelPicker pulls them
  // straight from there. Listing a fake `qwen2.5-coder-32b` here used to
  // make the picker offer a model that wasn't actually on disk, and the
  // selection was a silent no-op because the desktop shell had no way to
  // load it into VRAM.
  {
    kind: "openai",
    display_name: "OpenAI",
    base_url: null,
    requires_api_key: true,
    models: [
      {
        provider: "openai",
        model_id: "gpt-4o-mini",
        display_name: "GPT-4o mini",
        capability: {
          context_window: 128000,
          supports_tools: true,
          supports_vision: true,
          supports_streaming: true,
          supports_embeddings: false,
        },
      },
      {
        provider: "openai",
        model_id: "gpt-4o",
        display_name: "GPT-4o",
        capability: {
          context_window: 128000,
          supports_tools: true,
          supports_vision: true,
          supports_streaming: true,
          supports_embeddings: false,
        },
      },
    ],
  },
  {
    kind: "anthropic",
    display_name: "Anthropic",
    base_url: null,
    requires_api_key: true,
    models: [
      {
        provider: "anthropic",
        model_id: "claude-3-5-sonnet",
        display_name: "Claude 3.5 Sonnet",
        capability: {
          context_window: 200000,
          supports_tools: true,
          supports_vision: true,
          supports_streaming: true,
          supports_embeddings: false,
        },
      },
    ],
  },
];
