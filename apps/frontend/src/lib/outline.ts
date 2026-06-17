/**
 * Document outline (develop.md Phase 9).
 *
 * A pure, dependency-free symbol extractor for the active file — powers the
 * breadcrumb "symbols" dropdown and Go-to-Symbol. It recognizes top-level
 * declarations across the languages this project uses (TS/JS, Python, Rust, Go).
 * For richer/semantic symbols Monaco's built-in TS worker is used in the editor;
 * this offline extractor keeps the outline working for every language and is
 * trivially testable.
 */

export type SymbolKind = "function" | "class" | "interface" | "type" | "const" | "method" | "struct" | "enum";

export interface OutlineSymbol {
  name: string;
  kind: SymbolKind;
  line: number; // 1-based
}

interface Rule {
  re: RegExp;
  kind: SymbolKind;
  group?: number;
}

const TS_RULES: Rule[] = [
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: "function" },
  { re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
  { re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
  { re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/, kind: "type" },
  { re: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "enum" },
  // const Foo = ( … ) =>  /  const Foo = function
  { re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)\s*(?::[^=]+)?=>|function\b)/, kind: "function" },
];

const PY_RULES: Rule[] = [
  { re: /^(\s*)def\s+([A-Za-z_]\w*)/, kind: "function", group: 2 },
  { re: /^class\s+([A-Za-z_]\w*)/, kind: "class" },
];

const RUST_RULES: Rule[] = [
  { re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: "function" },
  { re: /^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/, kind: "struct" },
  { re: /^\s*(?:pub\s+)?enum\s+([A-Za-z_]\w*)/, kind: "enum" },
  { re: /^\s*(?:pub\s+)?trait\s+([A-Za-z_]\w*)/, kind: "interface" },
];

const GO_RULES: Rule[] = [
  { re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: "function" },
  { re: /^\s*type\s+([A-Za-z_]\w*)\s+struct/, kind: "struct" },
  { re: /^\s*type\s+([A-Za-z_]\w*)\s+interface/, kind: "interface" },
];

function rulesFor(language: string): Rule[] {
  const l = language.toLowerCase();
  if (l === "python" || l === "py") return PY_RULES;
  if (l === "rust" || l === "rs") return RUST_RULES;
  if (l === "go") return GO_RULES;
  // default to TS/JS for ts/tsx/js/jsx and anything else
  return TS_RULES;
}

/** Extract a flat outline from source text. Stable, in document order. */
export function extractOutline(text: string, language: string): OutlineSymbol[] {
  const rules = rulesFor(language);
  const out: OutlineSymbol[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const rule of rules) {
      const m = rule.re.exec(line);
      if (m) {
        const name = m[rule.group ?? 1];
        if (name) out.push({ name, kind: rule.kind, line: i + 1 });
        break; // one symbol per line
      }
    }
  }
  return out;
}

/** Case-insensitive substring filter, used by Go-to-Symbol. */
export function filterOutline(symbols: OutlineSymbol[], query: string): OutlineSymbol[] {
  const q = query.trim().toLowerCase();
  if (!q) return symbols;
  return symbols.filter((s) => s.name.toLowerCase().includes(q));
}
