/**
 * Streaming-markdown repair — zoc-agent-chat-rebuild R8.1, R8.5, task 15.2.
 *
 * A pure function that closes the delimiters a truncated markdown document left open, so a
 * half-arrived fence renders as a code block rather than flashing three literal backticks
 * and then reflowing when the rest arrives.
 *
 * **This exists because `streamdown` was rejected.** design.md:376 records the reason —
 * `mermaid` as a hard runtime dependency, ~75 MB per install, and a `tailwind-merge` major
 * bump across every existing component — and names its one genuinely valuable feature,
 * repairing unterminated markdown mid-stream, as the thing to reimplement here.
 *
 * ## The invariant, stated precisely
 *
 * **The repair appends delimiters and nothing else.** It never inserts, deletes, or reorders
 * a character of content, and every character it appends is markdown syntax rather than text
 * a reader sees. That is what makes Property 4's content-preservation claim true, and it is
 * why the function only ever *closes* — a repair that guessed at a link's missing URL, or
 * trimmed a dangling delimiter, would be editing the model's output.
 *
 * Two consequences worth stating because they look like omissions:
 *
 *   - **A dangling `[` becomes a complete link to nowhere**, `](#)`. Deleting the bracket
 *     would remove a character the model emitted; leaving it renders a literal `[` that
 *     disappears a delta later. Closing it keeps the label as the label, and the href is
 *     replaced the moment the real one arrives.
 *   - **Nothing is repaired inside a fence.** Backticks, asterisks, and brackets in code are
 *     content, and "closing" them would append syntax into a code block — visible, wrong,
 *     and exactly backwards.
 */

/** The two fence characters CommonMark allows, and the minimum run length. */
const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;

interface OpenFence {
  /** The run that opened it — a closer must be at least this long, of the same char. */
  readonly marker: string;
  /** Whether the opening line ended with a newline, so the closer knows if one is needed. */
  readonly indent: string;
}

/**
 * Split into lines, keeping the information about whether the text ends mid-line.
 *
 * `split("\n")` alone loses the difference between `"a\n"` and `"a"`, and that difference is
 * exactly what decides whether a closing fence needs a newline in front of it.
 */
function lines(text: string): { readonly rows: string[]; readonly endsWithNewline: boolean } {
  const rows = text.split("\n");
  const endsWithNewline = rows.length > 1 && rows[rows.length - 1] === "";
  if (endsWithNewline) rows.pop();
  return { rows, endsWithNewline };
}

/** Whether `line` closes `fence` — same character, at least as long, nothing after it. */
function closesFence(line: string, fence: OpenFence): boolean {
  const match = FENCE_RE.exec(line);
  if (match === null) return false;
  const run = match[2] ?? "";
  const rest = (match[3] ?? "").trim();
  // An info string on a closing fence is not a close; it opens a new one in CommonMark.
  return rest.length === 0 && run[0] === fence.marker[0] && run.length >= fence.marker.length;
}

/**
 * The fence still open at the end of the text, or null.
 *
 * A single fence rather than a stack, because CommonMark has no nested fenced blocks: inside
 * a fence every line is content until a matching closer, so the first unclosed fence is the
 * only one that can be open. A stack here would be a data structure modelling a language
 * feature that does not exist.
 */
function openFenceOf(rows: readonly string[]): OpenFence | null {
  let open: OpenFence | null = null;
  for (const row of rows) {
    if (open !== null) {
      if (closesFence(row, open)) open = null;
      continue;
    }
    const match = FENCE_RE.exec(row);
    if (match !== null) open = { marker: match[2] ?? "```", indent: match[1] ?? "" };
  }
  return open;
}

/** What one line of prose left unterminated. */
interface InlineState {
  /** Backtick-run length of an unclosed code span, or 0. */
  readonly codeRun: number;
  /** Emphasis delimiters opened and not closed, innermost last. */
  readonly emphasis: readonly string[];
  /** True when a `[` has no matching `]`. */
  readonly openLabel: boolean;
  /** True when a `](` has no matching `)`. */
  readonly openTarget: boolean;
}

/**
 * Scan one line's inline constructs.
 *
 * Deliberately not a markdown parser. It tracks the four things that produce a *visible*
 * flash when truncated — an unclosed code span, emphasis, a link label, a link target — and
 * ignores everything else, because a construct whose truncation is invisible needs no repair
 * and a repair applied to it is a repair that can be wrong.
 *
 * **Emphasis is matched by delimiter *run*, not by a longest-first token, and the difference
 * is idempotence.** A run of three asterisks closing a `**` spends two of them and leaves one
 * literal — CommonMark's own delimiter-run rule. Treating `***` as one indivisible token
 * instead makes `A **bold***` look like an unclosed `***` inside an unclosed `**`, so the
 * repair appends `**`, producing `A **bold*****`, and repeats forever. Pairing is still only
 * against an identical character, which undercounts the interleaved case `*a **b* c**`;
 * undercounting is the safe direction, because a missed repair shows a literal asterisk for
 * one delta whereas a wrong one appends syntax the model never wrote.
 *
 * **A delimiter with nothing after it is literal, not open**, and that rule is load-bearing
 * too. In CommonMark a code span needs content between its runs and an emphasis run needs a
 * following character, so `` ` `` alone and `*` alone are text. Worse, appending a closer to
 * them *merges into the run*: `` ` `` + `` ` `` reads as one two-backtick opener, so the next
 * repair appends two more. Reporting the empty case as closed is what stops a lone delimiter
 * growing on every delta.
 */
function scanInline(line: string): InlineState {
  let index = 0;
  let codeRun = 0;
  /** Where the still-open code span's opening run ended, for the empty-span check. */
  let codeOpenedAt = 0;
  /** Open emphasis delimiters, innermost last. */
  const emphasis: string[] = [];
  let openLabels = 0;
  let openTarget = false;

  while (index < line.length) {
    const char = line[index];

    if (char === "\\") {
      // An escape consumes the next character, so `\*` opens nothing.
      index += 2;
      continue;
    }

    if (char === "`") {
      let run = 0;
      while (index < line.length && line[index] === "`") {
        run += 1;
        index += 1;
      }
      if (codeRun === 0) {
        codeRun = run;
        codeOpenedAt = index;
      } else if (run === codeRun) {
        codeRun = 0;
      }
      continue;
    }

    // Inside a code span every other marker is content.
    if (codeRun > 0) {
      index += 1;
      continue;
    }

    if (char === "*" || char === "_") {
      // The whole run, then spend it: close as many open delimiters of the same character as
      // it covers, and open with whatever is left.
      let run = 0;
      while (index < line.length && line[index] === char) {
        run += 1;
        index += 1;
      }
      while (run > 0) {
        const top = emphasis[emphasis.length - 1];
        if (top === undefined || top[0] !== char || top.length > run) break;
        run -= top.length;
        emphasis.pop();
      }
      // A run at the very end of the line has nothing to emphasise, so it stays literal.
      if (run > 0 && index < line.length) emphasis.push(char.repeat(run));
      continue;
    }

    if (char === "[") {
      openLabels += 1;
      index += 1;
      continue;
    }
    if (char === "]") {
      if (openLabels > 0) openLabels -= 1;
      // `](` opens the target; a bare `]` closes a shortcut reference and opens nothing.
      if (line[index + 1] === "(") {
        openTarget = true;
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (char === ")" && openTarget) {
      openTarget = false;
      index += 1;
      continue;
    }

    index += 1;
  }

  return {
    codeRun: codeRun > 0 && codeOpenedAt === line.length ? 0 : codeRun,
    emphasis,
    openLabel: openLabels > 0,
    openTarget,
  };
}

/**
 * Close whatever a truncated markdown document left open.
 *
 * Appends only. The returned string starts with `text` character for character, so the
 * visible content is `text`'s visible content plus nothing — which is Property 4's
 * content-preservation claim, and the reason the function is written as "compute a suffix"
 * rather than "rewrite the document".
 *
 * Idempotent: repairing a repaired document appends nothing, because the first pass closed
 * every construct the scan can see and a closed construct is not open.
 */
export function repairStreamingMarkdown(text: string): string {
  if (text.length === 0) return text;

  const { rows, endsWithNewline } = lines(text);
  const fence = openFenceOf(rows);

  if (fence !== null) {
    // Inside a fence, every inline marker is content. The only repair is the closer, and it
    // has to start its own line.
    const prefix = endsWithNewline ? "" : "\n";
    return `${text}${prefix}${fence.indent}${fence.marker}`;
  }

  const lastRow = endsWithNewline ? "" : (rows[rows.length - 1] ?? "");
  if (lastRow.length === 0) return text;

  const state = scanInline(lastRow);
  let suffix = "";

  // Order matters and is the reverse of opening order: the target sits inside the label,
  // which sits inside any emphasis, which sits outside a code span. Closing outermost-first
  // would produce `**text)` — syntactically closed and visibly wrong.
  if (state.codeRun > 0) suffix += "`".repeat(state.codeRun);
  if (state.openTarget) suffix += ")";
  else if (state.openLabel) {
    // A label with no target yet. `](#)` rather than dropping the `[`: deleting a character
    // the model emitted is an edit, and a bare `[` renders as a literal that vanishes one
    // delta later.
    suffix += "](#)";
  }
  for (let index = state.emphasis.length - 1; index >= 0; index -= 1) {
    suffix += state.emphasis[index];
  }

  return suffix.length > 0 ? `${text}${suffix}` : text;
}

/**
 * The fenced blocks in a document, in order, with their source text.
 *
 * Exported for `CodeBlock`'s copy control (R8.5) and for Property 9, which asserts that
 * `n` fences produce `n` controls each carrying its own block's source. Derived here rather
 * than read back out of the DOM so the payload is the *source* text — the highlighted body a
 * user sees has been through Monaco and DOMPurify, and copying that would paste markup.
 */
export function fencedBlocks(
  text: string,
): ReadonlyArray<{ readonly language: string; readonly code: string; readonly closed: boolean }> {
  const { rows } = lines(text);
  const blocks: Array<{ language: string; code: string; closed: boolean }> = [];
  let open: OpenFence | null = null;
  let language = "";
  let body: string[] = [];

  for (const row of rows) {
    if (open === null) {
      const match = FENCE_RE.exec(row);
      if (match === null) continue;
      open = { marker: match[2] ?? "```", indent: match[1] ?? "" };
      // The info string's first word is the language; the rest is metadata nothing reads.
      language = (match[3] ?? "").trim().split(/\s+/)[0] ?? "";
      body = [];
      continue;
    }
    if (closesFence(row, open)) {
      blocks.push({ language, code: body.join("\n"), closed: true });
      open = null;
      continue;
    }
    body.push(row);
  }

  // A fence still open at the end of the stream is a real block — it is what the user is
  // watching arrive — so it is reported, flagged unclosed so the caller can withhold
  // highlighting until it settles.
  if (open !== null) blocks.push({ language, code: body.join("\n"), closed: false });
  return blocks;
}
