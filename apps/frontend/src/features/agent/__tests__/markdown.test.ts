import { describe, expect, it } from "vitest";
import {
  FOLLOW_UP_PREFIX,
  headingLevel,
  headingText,
  looksLikePath,
  normalizePathToken,
  splitInline,
  splitMarkdownBlocks,
} from "../markdown";

describe("splitMarkdownBlocks", () => {
  it("separates prose from fenced code", () => {
    const blocks = splitMarkdownBlocks("Here you go:\n```ts\nconst a = 1;\n```\nDone.");
    expect(blocks.map((b) => b.kind)).toEqual(["text", "code", "text"]);
    expect(blocks[1]).toMatchObject({ language: "ts", code: "const a = 1;", closed: true });
  });

  it("treats an unterminated fence as a streaming code block", () => {
    const blocks = splitMarkdownBlocks("Try:\n```python\nprint(1)");
    expect(blocks[1]).toMatchObject({ kind: "code", language: "python", closed: false });
  });

  it("records a missing language as null", () => {
    const [block] = splitMarkdownBlocks("```\nplain\n```");
    expect(block).toMatchObject({ kind: "code", language: null });
  });

  it("preserves blank lines and indentation inside code", () => {
    const [block] = splitMarkdownBlocks("```\nif x:\n\n    y()\n```");
    expect(block.kind === "code" && block.code).toBe("if x:\n\n    y()");
  });

  it("drops whitespace-only prose", () => {
    expect(splitMarkdownBlocks("   \n\n  ")).toEqual([]);
  });

  it("handles multiple code blocks", () => {
    const blocks = splitMarkdownBlocks("```a\n1\n```\ntext\n```b\n2\n```");
    expect(blocks.filter((b) => b.kind === "code")).toHaveLength(2);
  });
});

describe("headings", () => {
  it("reports the level and strips the markers", () => {
    expect(headingLevel("## Title")).toBe(2);
    expect(headingText("## Title")).toBe("Title");
    expect(headingLevel("###### Deep")).toBe(6);
    expect(headingLevel("####### Too deep")).toBe(0);
    expect(headingLevel("#NoSpace")).toBe(0);
    expect(headingLevel("plain")).toBe(0);
  });
});

describe("looksLikePath", () => {
  it("accepts source-file paths", () => {
    for (const p of ["src/app.ts", "app.py", "./a/b/c.rs", "packages/x/index.tsx"]) {
      expect(looksLikePath(p), p).toBe(true);
    }
  });

  it("rejects prose that merely contains a dot", () => {
    for (const p of ["e.g.", "1.5", "Node.js", "", "two words.ts", "no-extension"]) {
      expect(looksLikePath(p), p).toBe(false);
    }
  });

  it("tolerates trailing punctuation", () => {
    expect(looksLikePath("src/app.ts.")).toBe(true);
    expect(normalizePathToken("src/app.ts.")).toBe("src/app.ts");
    expect(normalizePathToken("(src/app.ts)")).toBe("(src/app.ts");
  });
});

describe("splitInline", () => {
  it("extracts inline code, bold and italic", () => {
    const spans = splitInline("use `foo()` and **bar** or *baz*");
    expect(spans.filter((s) => s.kind === "code").map((s) => s.text)).toEqual(["foo()"]);
    expect(spans.filter((s) => s.kind === "bold").map((s) => s.text)).toEqual(["bar"]);
    expect(spans.filter((s) => s.kind === "italic").map((s) => s.text)).toEqual(["baz"]);
  });

  it("links bare paths but leaves backticked ones as code", () => {
    const bare = splitInline("edit src/app.ts now");
    expect(bare.some((s) => s.kind === "path" && s.text === "src/app.ts")).toBe(true);

    const quoted = splitInline("edit `src/app.ts` now");
    expect(quoted.some((s) => s.kind === "path")).toBe(false);
    expect(quoted.some((s) => s.kind === "code" && s.text === "src/app.ts")).toBe(true);
  });

  it("round-trips the original text", () => {
    const line = "call `run()` in src/app.ts then **stop**";
    const rebuilt = splitInline(line)
      .map((s) => {
        if (s.kind === "code") return `\`${s.text}\``;
        if (s.kind === "bold") return `**${s.text}**`;
        if (s.kind === "italic") return `*${s.text}*`;
        return s.text;
      })
      .join("");
    expect(rebuilt).toBe(line);
  });

  it("returns nothing for an empty line", () => {
    expect(splitInline("")).toEqual([]);
  });
});

describe("FOLLOW_UP_PREFIX", () => {
  it("matches the documented wording", () => {
    expect(FOLLOW_UP_PREFIX).toBe("Regarding your previous answer: ");
  });
});
