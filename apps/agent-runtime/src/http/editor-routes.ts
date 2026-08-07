/**
 * The two editor inference routes — zoc-agent-chat-rebuild R6.2, 9.7.
 *
 * Feature: zoc-agent-chat-rebuild, task 9.7 (R6.2).
 *
 * ```
 * POST /v1/completions   → 200 text/event-stream
 *                          event: token  data: {"text": "…"}   (n, in order)
 *                          event: done   data: {}              (exactly one)
 * POST /v1/inline-edit   → 200 text/event-stream
 *                          event: token  data: {"text": "…"}   (n, in order)
 *                          event: done   data: {"text": "…"}   (exactly one,
 *                                        carrying the fence-stripped replacement)
 * ```
 *
 * **Neither opens a Run.** No `seq` is allocated, no `RunRecord` is created, and the
 * permission gate is not consulted — because neither touches the workspace. They
 * live here rather than on Workspace_Services for the one reason R6.2 gives: both
 * are provider inference calls, and provider inference happens in this process.
 *
 * **Both fail quiet, and that is a contract rather than laziness.** Any model
 * outcome — no provider configured, an error before the first token, an error
 * halfway through — ends with exactly one `done` and no error frame. An editor
 * ghost-text provider has nowhere to put an error: a toast on every keystroke that
 * missed is worse than no completion, and `completions-client.ts` swallows failures
 * for the same reason. Tokens already emitted stay emitted.
 *
 * **No `apiKey` or `baseUrl` on either body, unlike the Gateway's shapes.** R7.8
 * puts credential resolution inside the runtime, so the two fields the Python
 * requests carry are absent here and the key comes from the vault through the
 * injected {@link EditorRoutesDeps.generate}. This is the one deliberate divergence
 * from "preserve the existing shape", and it is the direction the requirement
 * forces.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import {
  COMPLETION_MAX_TOKENS,
  COMPLETION_TEMPERATURE,
  CompletionCache,
  INLINE_EDIT_MAX_TOKENS,
  INLINE_EDIT_TEMPERATURE,
  buildFallbackPrompt,
  buildFimPrompt,
  buildInlineEditPrompt,
  completionStopSequences,
  modelSupportsFim,
  stripCodeFences,
} from "../agent/editor-inference.ts";
import { SSE_HEADERS } from "../agent/writer.ts";
import type { Router } from "./routes.ts";
import { readJsonBody, validate } from "./validate.ts";

/** The editor sends at most a screenful of context; 256 kB is generous for it. */
const EDITOR_BODY_LIMIT = 256 * 1024;

/** Shared by both bodies: which model to ask, without the credential. */
const modelSelection = {
  provider: z.string().max(128).nullish(),
  model: z.string().max(256).nullish(),
};

/**
 * Both bodies are closed, unlike the Python requests they replace.
 *
 * `completions.py` and `inline.py` both declare `extra="ignore"`, so the Gateway
 * accepts an `apiKey` and a `baseUrl` and uses them. Closing the schema here turns
 * "the runtime ignores your credential" into "the runtime refuses it", which is
 * R7.8 enforced rather than intended. It costs nothing today — nothing calls these
 * routes until 22.11 and 22.12 repoint the editor at them — and it means the
 * clients written then cannot be written wrong.
 */
const completionBodySchema = z.strictObject({
  prefix: z.string().max(100_000),
  suffix: z.string().max(100_000),
  language: z.string().max(128).default(""),
  filePath: z.string().max(4096).default(""),
  ...modelSelection,
});

const inlineEditBodySchema = z.strictObject({
  instruction: z.string().min(1).max(10_000),
  code: z.string().max(200_000).default(""),
  prefix: z.string().max(100_000).default(""),
  suffix: z.string().max(100_000).default(""),
  language: z.string().max(128).default(""),
  filePath: z.string().max(4096).default(""),
  ...modelSelection,
});

export interface EditorGenerateRequest {
  readonly prompt: string;
  readonly provider: string | null;
  readonly modelId: string | null;
  readonly temperature: number;
  readonly maxOutputTokens: number;
  readonly stopSequences: readonly string[];
  /** Aborted when the editor closes the connection mid-generation. */
  readonly signal: AbortSignal;
}

export interface EditorRoutesDeps {
  /**
   * Stream the model's text for one prompt.
   *
   * Yields chunks in emission order and may throw or yield nothing; both are
   * ordinary outcomes here and both end as a single `done`. The seam is a plain
   * async iterable rather than the AI SDK's stream type so the routes are testable
   * with a generator function and no provider.
   */
  generate(request: EditorGenerateRequest): AsyncIterable<string>;
  /** Shared across requests, so a repeated keystroke is not a repeated call. */
  cache?: CompletionCache;
  now?: () => number;
}

function tokenFrame(text: string): string {
  return `event: token\ndata: ${JSON.stringify({ text })}\n\n`;
}

function doneFrame(payload: Record<string, unknown>): string {
  return `event: done\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function registerEditorRoutes(router: Router, deps: EditorRoutesDeps): void {
  const cache = deps.cache ?? new CompletionCache();
  const now = deps.now ?? (() => Date.now());

  router.post("/v1/completions", async ({ req, res }) => {
    const body = validate(
      completionBodySchema,
      await readJsonBody(req, EDITOR_BODY_LIMIT),
      "completion request",
    );
    const modelId = (body.model ?? "").trim();
    const key = { prefix: body.prefix, suffix: body.suffix, modelId };

    // Written before anything can fail, so every path below has exactly one
    // terminal to reach and none of them has to remember to open the stream.
    res.writeHead(200, SSE_HEADERS);

    const cached = cache.get(key, now());
    if (cached !== null) {
      res.write(tokenFrame(cached));
      res.end(doneFrame({}));
      return;
    }

    const prompt = modelSupportsFim(modelId)
      ? buildFimPrompt(body.prefix, body.suffix)
      : buildFallbackPrompt(body.prefix, body.suffix, body.language);

    const collected = await drain(res, req, {
      prompt,
      provider: body.provider ?? null,
      modelId: body.model ?? null,
      temperature: COMPLETION_TEMPERATURE,
      maxOutputTokens: COMPLETION_MAX_TOKENS,
      stopSequences: completionStopSequences(body.language),
      generate: deps.generate,
    });

    // Stored only when the generation ran to completion and produced something.
    //
    // **Deviation from the Gateway, taken deliberately.** `completions.py` joins
    // whatever chunks arrived and caches them whether or not the worker raised, so a
    // provider that dies after two tokens leaves `const ` in the cache and serves it
    // back for the next thirty seconds — a wrong ghost completion the user cannot
    // refresh away, because every subsequent keystroke at the same position is a
    // cache hit. Its `try/finally` shape is why it does that, not a rule anything
    // states; R14.1 only says "store iff non-empty".
    if (collected.complete && collected.text.length > 0) {
      cache.put(key, collected.text, now());
    }
    res.end(doneFrame({}));
  });

  router.post("/v1/inline-edit", async ({ req, res }) => {
    const body = validate(
      inlineEditBodySchema,
      await readJsonBody(req, EDITOR_BODY_LIMIT),
      "inline edit request",
    );

    res.writeHead(200, SSE_HEADERS);

    const collected = await drain(res, req, {
      prompt: buildInlineEditPrompt({
        instruction: body.instruction,
        code: body.code,
        prefix: body.prefix,
        suffix: body.suffix,
        language: body.language,
      }),
      provider: body.provider ?? null,
      modelId: body.model ?? null,
      temperature: INLINE_EDIT_TEMPERATURE,
      maxOutputTokens: INLINE_EDIT_MAX_TOKENS,
      // No stop sequence: a replacement may legitimately contain a blank line, and
      // `\n\n` would truncate it mid-function. Fences are stripped afterwards
      // instead, which is what the Gateway's inline path does too.
      stopSequences: [],
      generate: deps.generate,
    });

    // The `done` carries the whole replacement, fence-stripped — the tokens were
    // for the typing animation, this is the value Monaco applies. Stripping only
    // here is deliberate: a fence's opening line arrives in its own chunk, so a
    // per-chunk strip would have nothing to match against.
    res.end(doneFrame({ text: stripCodeFences(collected.text) }));
  });
}

/**
 * Run one generation to completion, writing a `token` frame per non-empty chunk.
 *
 * Returns the concatenated text and never throws. The `catch` is the fail-quiet
 * rule: whatever went wrong, the caller still writes its single `done`, and the
 * chunks that did arrive are still the caller's to use.
 */
async function drain(
  res: ServerResponse,
  req: IncomingMessage,
  options: Omit<EditorGenerateRequest, "signal"> & {
    readonly generate: EditorRoutesDeps["generate"];
  },
): Promise<{ readonly text: string; readonly complete: boolean }> {
  const controller = new AbortController();
  // The editor cancels aggressively — every keystroke supersedes the request before
  // it — so a completion whose reader has gone must stop costing tokens.
  const abort = (): void => controller.abort();
  req.on("close", abort);

  const chunks: string[] = [];
  let complete = false;
  try {
    const { generate, ...request } = options;
    for await (const chunk of generate({ ...request, signal: controller.signal })) {
      if (controller.signal.aborted) break;
      if (chunk.length === 0) continue;
      chunks.push(chunk);
      res.write(tokenFrame(chunk));
    }
    complete = !controller.signal.aborted;
  } catch {
    // Fail quiet (R16 on the Gateway side): no error frame, tokens already sent
    // stay sent, and the caller's `done` is still the one terminal.
  } finally {
    req.off("close", abort);
  }
  return { text: chunks.join(""), complete };
}
