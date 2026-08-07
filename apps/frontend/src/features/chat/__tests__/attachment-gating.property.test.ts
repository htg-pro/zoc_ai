/** Property 69: attachment gating follows capability, limit, and persistence (R29.3/R29.5/R29.6). */
/** Feature: zoc-agent-chat-rebuild, Property 69 (R29.3, R29.5, R29.6). */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  attachmentFilePart,
  attachmentGate,
  attachmentsFromParts,
  type ComposerAttachment,
} from "../composer/attachment-model";
import { restoreTranscript } from "../transcript-persistence";
import type { ZocUIMessage } from "../wire/ui-message";

const attachmentArb = fc
  .record({
    id: fc.uuid(),
    kind: fc.constantFrom<ComposerAttachment["kind"]>("image", "document"),
    name: fc.string({ minLength: 1, maxLength: 80 }),
    size: fc.integer({ min: 0, max: 10 * 1024 * 1024 }),
    text: fc.string({ maxLength: 300 }),
  })
  .map(
    ({ id, kind, name, size, text }): ComposerAttachment => ({
      id,
      kind,
      name,
      mediaType: kind === "image" ? "image/png" : "text/plain",
      size,
      url: kind === "image" ? "data:image/png;base64,AA==" : "data:text/plain;base64,AA==",
      ...(kind === "document" ? { text } : {}),
      estimatedTokens: kind === "document" ? Math.max(1, Math.ceil(text.length / 4)) : 0,
    }),
  );

describe("Property 69: attachment gating follows model capability and size limit", () => {
  it("blocks images exactly for text-only models and rejects sizes exactly above the limit", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<ComposerAttachment["kind"]>("image", "document"),
        fc.nat({ max: 30 * 1024 * 1024 }),
        fc.nat({ max: 20 * 1024 * 1024 }),
        fc.boolean(),
        (kind, size, sizeLimit, supportsImages) => {
          const gate = attachmentGate({ kind, size, sizeLimit, supportsImages });
          expect(gate.reasons.includes("image_unsupported")).toBe(
            kind === "image" && !supportsImages,
          );
          expect(gate.reasons.includes("too_large")).toBe(size > sizeLimit);
          expect(gate.accepted).toBe(!(kind === "image" && !supportsImages) && size <= sizeLimit);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("retains the complete attachment set through persisted transcript restoration", () => {
    fc.assert(
      fc.property(fc.array(attachmentArb, { maxLength: 12 }), (attachments) => {
        const message = {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "Inspect these" }, ...attachments.map(attachmentFilePart)],
        } as ZocUIMessage;
        const stored = JSON.parse(JSON.stringify([message])) as unknown[];
        const restored = restoreTranscript(stored).messages[0];
        expect(restored).toBeDefined();
        expect(attachmentsFromParts(restored?.parts ?? [])).toEqual(attachments);
      }),
      { numRuns: 150 },
    );
  });
});
