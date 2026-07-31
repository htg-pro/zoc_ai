/**
 * Property 8: Rendered model output is inert. Validates R8.6.
 * Property 9: Fenced blocks and copy controls correspond one-to-one. Validates R8.5.
 *
 * Both are asserted against the **rendered DOM**, not against the pipeline's configuration. A
 * test that checked `skipHtml` was passed would prove a prop was set; these check what a user
 * actually gets, which is the only form in which "inert" means anything.
 *
 * Property 8's generator is the interesting part. The payloads are real injection shapes —
 * `<script>`, an `onerror` handler, a `javascript:` href, an off-origin `img` — planted inside
 * ordinary markdown at ordinary positions, because an attack that only works in a document
 * consisting solely of the payload is not the case that matters. Each is drawn against every
 * fixture body, so the assertion holds for a payload beside a fence, inside a list, and next
 * to a link.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import fc from "fast-check";

import { AnswerRow } from "@/features/chat/AnswerRow";
import { UserTurnRow } from "@/features/chat/UserTurnRow";
import { fencedBlocks } from "@/features/chat/markdown/repair";
import { MARKDOWN_BODIES } from "./arbitraries";

const RUNS = { numRuns: 100 } as const;

afterEach(cleanup);

/**
 * Injection payloads, each a real shape rather than a synthetic one.
 *
 * The list is the union of what R8.6 enumerates — a `script` element, an attribute whose name
 * begins with `on`, a `javascript:` URL, an off-origin `src`/`href` — plus the two markdown
 * forms that reach the same places without a tag: a link whose target is a script URL, and an
 * image whose source is remote.
 */
const PAYLOADS = [
  "<script>globalThis.__zocPwned = true;</script>",
  '<img src="x" onerror="globalThis.__zocPwned = true">',
  '<a href="javascript:globalThis.__zocPwned = true">click</a>',
  '<iframe src="https://evil.invalid/frame"></iframe>',
  '<svg onload="globalThis.__zocPwned = true"></svg>',
  "[click](javascript:globalThis.__zocPwned=true)",
  "[click](JaVaScRiPt:alert(1))",
  "[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  "![tracker](https://evil.invalid/pixel.gif)",
  '<div style="background:url(javascript:alert(1))">x</div>',
  "<style>body{display:none}</style>",
  '<form action="https://evil.invalid"><input name="a"></form>',
] as const;

/** A payload spliced into a real document at a real position. */
const poisoned: fc.Arbitrary<string> = fc
  .tuple(fc.constantFrom(...MARKDOWN_BODIES), fc.constantFrom(...PAYLOADS), fc.nat({ max: 3 }))
  .map(([body, payload, where]) => {
    switch (where) {
      case 0:
        return `${payload}\n\n${body}`;
      case 1:
        return `${body}\n\n${payload}`;
      case 2:
        return `${body}\n\n${payload}\n\n${body}`;
      default:
        return `- item\n- ${payload}\n\n${body}`;
    }
  });

/** Origins a rendered `src` or `href` may point at (R8.6's allowed set). */
const ALLOWED_HOSTS: readonly string[] = ["zoc.invalid", "localhost", "127.0.0.1"];

interface Violation {
  readonly kind: string;
  readonly detail: string;
}

/**
 * Every way R8.6 can be violated, checked against one rendered subtree.
 *
 * Returned as a list rather than asserted inline so a failure names *which* clause broke and
 * with what — a bare `toBe(true)` on a container that failed four ways is a failure a reader
 * has to reproduce before they can read it.
 */
function violationsIn(container: HTMLElement): Violation[] {
  const found: Violation[] = [];

  // `svg` is absent from this list on purpose, and the reason is worth stating: the copy
  // control's own lucide icon is an `<svg>`, so a blanket ban would fail on the surface's own
  // chrome rather than on model output. What matters about a model-authored `svg` is that it
  // cannot carry a handler or a remote reference — and the `on*` and `src`/`href` sweeps below
  // cover exactly that, for every element including this one.
  for (const tag of ["script", "iframe", "object", "embed", "style", "form"]) {
    for (const node of container.querySelectorAll(tag)) {
      found.push({ kind: `<${tag}>`, detail: node.outerHTML.slice(0, 120) });
    }
  }

  for (const element of container.querySelectorAll("*")) {
    for (const attribute of element.attributes) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();

      if (name.startsWith("on")) {
        found.push({ kind: `on* attribute`, detail: `${name}="${value.slice(0, 60)}"` });
      }

      if (name !== "href" && name !== "src") continue;

      // A scheme-relative or absolute-path URL resolves against the app's own document.
      if (value.startsWith("/") || value.startsWith("#") || value.startsWith("?")) continue;

      let parsed: URL;
      try {
        parsed = new URL(value, "https://zoc.invalid/");
      } catch {
        found.push({ kind: "unparseable url", detail: `${name}="${value.slice(0, 60)}"` });
        continue;
      }

      if (!["https:", "http:", "mailto:"].includes(parsed.protocol)) {
        found.push({ kind: "url scheme", detail: `${name}="${value.slice(0, 60)}"` });
        continue;
      }
      if (name === "src" && !ALLOWED_HOSTS.includes(parsed.hostname)) {
        // An `src` the model chose is an outbound request the user did not ask for.
        found.push({ kind: "off-origin src", detail: `${parsed.host}` });
      }
    }
  }

  return found;
}

describe("Feature: zoc-agent-chat-rebuild, Property 8: rendered model output is inert", () => {
  it("renders no script, no on* attribute, no javascript: url, and no off-origin src", () => {
    fc.assert(
      fc.property(poisoned, fc.boolean(), (markdown, streaming) => {
        cleanup();
        const { container } = render(<AnswerRow text={markdown} streaming={streaming} />);
        const violations = violationsIn(container);
        expect(violations, violations.map((v) => `${v.kind}: ${v.detail}`).join("; ")).toEqual([]);
      }),
      RUNS,
    );
  });

  it("executes nothing, which is the claim behind the structural checks", () => {
    // The structural assertions above are the property; this is the observable consequence,
    // and it catches an execution path they do not enumerate.
    const scope = globalThis as { __zocPwned?: boolean };
    fc.assert(
      fc.property(poisoned, (markdown) => {
        cleanup();
        delete scope.__zocPwned;
        render(<AnswerRow text={markdown} />);
        expect(scope.__zocPwned).toBeUndefined();
      }),
      RUNS,
    );
  });

  it("keeps the visible words of a refused construct", () => {
    // Inertness must not be achieved by discarding content. A link the surface will not make
    // navigable still reads, and an image renders its alt text — so the model's meaning
    // survives even where its markup does not.
    const { container } = render(
      <AnswerRow text="See [the docs](javascript:alert(1)) and ![a diagram](https://evil.invalid/d.png)." />,
    );
    expect(container.textContent).toContain("the docs");
    expect(container.textContent).toContain("a diagram");
    expect(container.querySelector("[data-zoc-unsafe-link]")).not.toBeNull();
    expect(container.querySelector("[data-zoc-image-placeholder]")).not.toBeNull();
  });

  it("renders a safe link as a real link, so the policy is not just a refusal", () => {
    // Without this the property above passes for a component that refused every link.
    const { container } = render(<AnswerRow text="See [the docs](https://example.invalid/d)." />);
    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe("https://example.invalid/d");
    expect(anchor?.getAttribute("rel")).toContain("noopener");
  });

  it("renders a user turn as text, never as markup", () => {
    // A user turn takes no markdown pass at all, so its inertness is structural. Asserted
    // because the *reason* is easy to lose: someone routing it through `MarkdownBody` for
    // consistency would reinterpret the user's own text.
    const { container } = render(
      <UserTurnRow text={"<script>globalThis.__zocPwned = true;</script> and **not bold**"} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("strong")).toBeNull();
    // The characters survive exactly, including the asterisks.
    expect(container.querySelector("[data-zoc-user-text]")?.textContent).toContain("**not bold**");
  });
});

describe("Feature: zoc-agent-chat-rebuild, Property 9: fenced blocks and copy controls correspond one-to-one", () => {
  /**
   * Documents with a known number of fences, built rather than sampled.
   *
   * The count has to be *known* for the property to be checkable, and deriving it from the
   * generated string with the same function the component uses would make the test agree with
   * itself. So the blocks are constructed and the expected count is their length.
   */
  const withFences = fc
    .array(
      fc.record({
        language: fc.constantFrom("ts", "python", "", "rust", "not-a-language"),
        code: fc.array(fc.string({ maxLength: 24 }), { minLength: 1, maxLength: 4 }),
      }),
      { minLength: 0, maxLength: 5 },
    )
    .map((blocks) => ({
      blocks,
      markdown: blocks
        .map(
          (block) => `Prose before.\n\n\`\`\`${block.language}\n${block.code.join("\n")}\n\`\`\`\n`,
        )
        .join("\nBetween.\n\n"),
    }));

  it("renders exactly one copy control per fenced block", () => {
    fc.assert(
      fc.property(withFences, ({ blocks, markdown }) => {
        cleanup();
        const { container } = render(<AnswerRow text={markdown} />);
        expect(container.querySelectorAll("[data-zoc-copy-control]")).toHaveLength(blocks.length);
        expect(container.querySelectorAll("[data-zoc-code-block]")).toHaveLength(blocks.length);
      }),
      RUNS,
    );
  });

  it("gives each control its own block's source as its payload", () => {
    // The half that makes the count meaningful. `n` controls each carrying the *first* block's
    // text would satisfy a count-only assertion and be useless to a user.
    fc.assert(
      fc.property(withFences, ({ blocks, markdown }) => {
        cleanup();
        const { container } = render(<AnswerRow text={markdown} />);
        const payloads = [...container.querySelectorAll("[data-zoc-copy-control]")].map((control) =>
          control.getAttribute("data-copy-payload"),
        );
        expect(payloads).toEqual(blocks.map((block) => block.code.join("\n")));
      }),
      RUNS,
    );
  });

  it("agrees with `fencedBlocks` about how many fences a document has", () => {
    // The rendering and the pure function are two readings of one document, and 15.2's
    // `CodeBlock` and 18.x's plan rows will both consume the second. A disagreement means one
    // of them is wrong about a fence, which is invisible until a copy control goes missing.
    fc.assert(
      fc.property(withFences, ({ blocks, markdown }) => {
        expect(fencedBlocks(markdown)).toHaveLength(blocks.length);
      }),
      RUNS,
    );
  });

  it("labels an untagged fence `code` rather than leaving it blank", () => {
    const { container } = render(<AnswerRow text={"```\nplain\n```"} />);
    expect(container.querySelector("[data-zoc-code-block]")?.getAttribute("data-language")).toBe(
      "code",
    );
    // And the control's accessible name carries it, so six blocks are not six identical
    // "Copy" buttons to a screen reader.
    expect(container.querySelector("[data-zoc-copy-control]")?.getAttribute("aria-label")).toBe(
      "Copy code block",
    );
  });

  it("does not mistake inline code for a fence", () => {
    // The one distinction `react-markdown` communicates only through a class name, and getting
    // it wrong turns every inline `x` into a full-width card with its own copy control.
    const { container } = render(<AnswerRow text="Use `npm run build` to build." />);
    expect(container.querySelectorAll("[data-zoc-copy-control]")).toHaveLength(0);
    expect(container.querySelector("[data-zoc-inline-code]")?.textContent).toBe("npm run build");
  });

  it("renders a still-open fence as a block, marked streaming", () => {
    // A fence the user is watching arrive is a real block — it is the thing on screen — so it
    // gets its label and its control immediately, and only highlighting waits.
    const { container } = render(<AnswerRow text={"```ts\nconst a = 1;"} streaming />);
    const block = container.querySelector("[data-zoc-code-block]");
    expect(block).not.toBeNull();
    expect(block?.getAttribute("data-streaming")).toBe("");
    expect(container.querySelector("[data-zoc-code-body]")?.hasAttribute("data-highlighted")).toBe(
      false,
    );
  });
});
