/**
 * Plugin marketplace registry core (Part 5.2, pure/dependency-free).
 *
 * Parses the registry document, filters by name/tags, and validates a plugin
 * artifact's `manifest.json` (via an injected `extract` seam so real zip
 * extraction is pluggable and this stays unit-testable). Reuses
 * `parsePluginManifest` so install validation matches the plugin host.
 */
import { unzipSync } from "fflate";
import { parsePluginManifest, type ManifestParseResult } from "./plugin-manifest";

export interface RegistryPlugin {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  tags: string[];
  downloadUrl: string;
  stars: number;
  verified: boolean;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function normalize(raw: unknown): RegistryPlugin | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  const name = str(r.name);
  if (!id || !name) return null; // identity is required
  return {
    id,
    name,
    description: str(r.description),
    author: str(r.author),
    version: str(r.version, "0.0.0"),
    tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string") : [],
    downloadUrl: str(r.downloadUrl),
    stars: typeof r.stars === "number" && Number.isFinite(r.stars) ? r.stars : 0,
    verified: r.verified === true,
  };
}

/** Parse a registry document (JSON array), dropping invalid entries. */
export function parseRegistry(text: string): RegistryPlugin[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(doc)) return [];
  return doc.map(normalize).filter((p): p is RegistryPlugin => p !== null);
}

/** Case-insensitive filter by name or tag; empty query returns all (order kept). */
export function filterPlugins(list: RegistryPlugin[], query: string): RegistryPlugin[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter(
    (p) => p.name.toLowerCase().includes(q) || p.tags.some((t) => t.toLowerCase().includes(q)),
  );
}

/** A downloaded plugin artifact: a real zip or legacy raw manifest JSON. */
export type PluginArtifact = Uint8Array | string;

export interface ExtractedPluginArtifact {
  manifestText: string;
  code?: string;
}

export type ExtractPluginArtifact = (
  artifact: PluginArtifact,
) => Promise<ExtractedPluginArtifact | string | null> | ExtractedPluginArtifact | string | null;

export interface PluginArtifactParseResult extends ManifestParseResult {
  code?: string;
}

export const MAX_PLUGIN_ARCHIVE_BYTES = 10 * 1024 * 1024;
export const MAX_PLUGIN_UNCOMPRESSED_BYTES = 25 * 1024 * 1024;
export const MAX_PLUGIN_FILES = 256;
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_ENTRY_CODE_BYTES = 2 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });

function safeArchivePath(path: string): string | null {
  if (
    !path ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    /[\0-\x1f\x7f]/.test(path)
  ) {
    return null;
  }
  const withoutTrailingSlash = path.endsWith("/") ? path.slice(0, -1) : path;
  const parts = withoutTrailingSlash.split("/");
  if (
    withoutTrailingSlash === "" ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    return null;
  }
  return parts.join("/");
}

function entryPath(manifestPath: string, main: string): string | null {
  if (!main || main.includes("\\") || main.startsWith("/") || /^[A-Za-z]:/.test(main)) {
    return null;
  }
  const base = manifestPath.split("/").slice(0, -1);
  return safeArchivePath([...base, ...main.split("/")].join("/"));
}

function unzipSelected(
  artifact: Uint8Array,
  select: (safeName: string, originalSize: number) => boolean,
): Record<string, Uint8Array> {
  let files = 0;
  let totalSize = 0;
  return unzipSync(artifact, {
    filter: (entry) => {
      const safeName = safeArchivePath(entry.name);
      if (!safeName) throw new Error(`Unsafe path in plugin archive: ${entry.name}`);
      files += 1;
      totalSize += entry.originalSize;
      if (files > MAX_PLUGIN_FILES) throw new Error("Plugin archive contains too many files.");
      if (totalSize > MAX_PLUGIN_UNCOMPRESSED_BYTES) {
        throw new Error("Plugin archive expands beyond the allowed size.");
      }
      return select(safeName, entry.originalSize);
    },
  });
}

/** Extract and validate the root (or single top-level folder) manifest and entry code. */
export function extractPluginArtifact(artifact: PluginArtifact): ExtractedPluginArtifact {
  if (typeof artifact === "string") return { manifestText: artifact };
  if (artifact.byteLength > MAX_PLUGIN_ARCHIVE_BYTES) {
    throw new Error("Plugin archive exceeds the 10 MiB download limit.");
  }
  const isZip =
    artifact.byteLength >= 4 &&
    artifact[0] === 0x50 &&
    artifact[1] === 0x4b &&
    (artifact[2] === 0x03 || artifact[2] === 0x05 || artifact[2] === 0x07) &&
    (artifact[3] === 0x04 || artifact[3] === 0x06 || artifact[3] === 0x08);
  if (!isZip) return { manifestText: utf8.decode(artifact) };

  const manifestEntries = unzipSelected(
    artifact,
    (name, size) => name.split("/").at(-1) === "manifest.json" && size <= MAX_MANIFEST_BYTES,
  );
  const candidates = Object.keys(manifestEntries)
    .map((name) => safeArchivePath(name))
    .filter((name): name is string => name != null && name.split("/").at(-1) === "manifest.json")
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  if (candidates.length === 0) throw new Error("No manifest.json found in the plugin artifact.");
  const shallowestDepth = candidates[0].split("/").length;
  if (candidates.filter((name) => name.split("/").length === shallowestDepth).length > 1) {
    throw new Error("Plugin archive contains ambiguous manifest.json files.");
  }

  const manifestPath = candidates[0];
  const manifestBytes = manifestEntries[manifestPath];
  if (!manifestBytes) throw new Error("No manifest.json found in the plugin artifact.");
  const manifestText = utf8.decode(manifestBytes);
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(manifestText);
  } catch {
    return { manifestText };
  }
  const rawMain =
    rawManifest && typeof rawManifest === "object"
      ? (rawManifest as Record<string, unknown>).main
      : undefined;
  const declaredMain = typeof rawMain === "string" ? rawMain.trim() : undefined;
  const hasDeclaredMain = typeof declaredMain === "string" && declaredMain.length > 0;
  const main = hasDeclaredMain ? declaredMain : "index.js";

  const mainPath = entryPath(manifestPath, main);
  if (!mainPath) throw new Error(`Unsafe plugin main entry: ${main}`);
  const codeEntries = unzipSelected(
    artifact,
    (name, size) => name === mainPath && size <= MAX_ENTRY_CODE_BYTES,
  );
  const codeBytes = codeEntries[mainPath];
  if (!codeBytes) {
    if (hasDeclaredMain) {
      throw new Error(`Plugin main entry was not found or is too large: ${main}`);
    }
    return { manifestText };
  }
  return { manifestText, code: utf8.decode(codeBytes) };
}

/** Backward-compatible extraction seam name used by existing callers/tests. */
export const extractManifestText: ExtractPluginArtifact = extractPluginArtifact;

/** Extract, validate, and return a plugin manifest plus optional worker code. */
export async function manifestFromArtifact(
  artifact: PluginArtifact,
  extract: ExtractPluginArtifact = extractPluginArtifact,
): Promise<PluginArtifactParseResult> {
  let extracted: ExtractedPluginArtifact | string | null;
  try {
    extracted = await extract(artifact);
  } catch (error) {
    return {
      manifest: null,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
  const manifestText = typeof extracted === "string" ? extracted : extracted?.manifestText;
  if (manifestText == null || manifestText.trim() === "") {
    return { manifest: null, errors: ["No manifest.json found in the plugin artifact."] };
  }
  const parsed = parsePluginManifest(manifestText);
  return {
    ...parsed,
    ...(parsed.manifest && extracted !== null && typeof extracted === "object" && extracted.code
      ? { code: extracted.code }
      : {}),
  };
}
