/**
 * The shared shell for the Chat_Surface stories — zoc-agent-chat-rebuild task 27.1 (R17.5, R22.6).
 *
 * Feature: zoc-agent-chat-rebuild, task 27.1 (R17.5, R22.6).
 *
 * Two components, both here for the same reason `story-fixtures.ts` is one module: the stories are a
 * comparison surface. If each of the eight files invented its own wrapper, its own caption style, and
 * its own spacing, a reviewer judging whether the answer tier reads heavier than the reasoning tier
 * would be judging the story files' CSS as much as the components'.
 *
 * `StoryFrame` also supplies `ChatMotionProvider`, which the Ladle global provider does not. Every
 * animating part of this surface uses Motion's `m` components under a `LazyMotion strict` tree, so a
 * story without the provider would show the static frame of a component whose whole point is the
 * transition — the caret, the run pill's spinner, the ember pulse on the permission dock.
 */
import type { ReactNode } from "react";

import { ChatMotionProvider } from "@/lib/reduced-motion-provider";
import { cn } from "@/lib/utils";

export interface StoryFrameProps {
  /** One sentence on what the reviewer is being asked to judge. Shown above the variants. */
  brief?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function StoryFrame({ brief, children, className }: StoryFrameProps) {
  return (
    <ChatMotionProvider budget={null}>
      <div className={cn("flex flex-col gap-6", className)}>
        {brief === undefined ? null : (
          <p style={{ color: "var(--zoc-text-secondary)", fontSize: "var(--zoc-text-body)" }}>
            {brief}
          </p>
        )}
        {children}
      </div>
    </ChatMotionProvider>
  );
}

export interface VariantProps {
  /** The state being shown — `default`, `streaming`, `failed`, `empty`. */
  label: string;
  /** Why this variant exists, when the label alone does not say it. */
  note?: ReactNode;
  /** Constrains the width, for a component whose layout depends on it. */
  width?: number | string;
  children: ReactNode;
}

/**
 * One labelled state.
 *
 * The label is above the component rather than beside it, so variants stack at a single width and a
 * reviewer comparing two rows is comparing their real rendered width rather than whatever a caption
 * column left over.
 */
export function Variant({ label, note, width, children }: VariantProps) {
  return (
    <section className="flex flex-col gap-2">
      <h3
        className="font-mono uppercase"
        style={{
          color: "var(--zoc-text-muted)",
          fontSize: "var(--zoc-text-label)",
          letterSpacing: "var(--zoc-tracking-label)",
        }}
      >
        {label}
      </h3>
      {note === undefined ? null : (
        <p style={{ color: "var(--zoc-text-faint)", fontSize: "var(--zoc-text-label)" }}>{note}</p>
      )}
      <div
        className="rounded-[var(--zoc-radius-card)] border border-[var(--zoc-border)] p-4"
        style={width === undefined ? undefined : { width, maxWidth: "100%" }}
      >
        {children}
      </div>
    </section>
  );
}
