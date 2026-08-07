/** Provider-native web-search tools and their shared availability instruction. */
/** Feature: zoc-agent-chat-rebuild, tasks 36.1-36.2 (R33.1, R33.2, R33.3, R33.4, R33.5, R33.8). */

import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";

import type { ToolDescriptor } from "./registry.ts";

/** Canonical permission/audit name, including for Google's differently named tool. */
export const WEB_SEARCH_PERMISSION_TOOL = "web_search";

/**
 * Appended when the selected provider cannot carry a search tool, or permission
 * omitted it. It states both the limitation and the expected model behaviour.
 */
export const NO_WEB_SEARCH_SENTENCE =
  "Web search is unavailable for this run. Do not claim to have searched the web; " +
  "answer from the provided context and say when current information cannot be verified.";

export const WEB_SEARCH_PROVIDER_IDS = ["openai", "anthropic", "google-ai-studio"] as const;

export type WebSearchProviderId = (typeof WEB_SEARCH_PROVIDER_IDS)[number];

export function supportsProviderWebSearch(providerId: string): providerId is WebSearchProviderId {
  return (WEB_SEARCH_PROVIDER_IDS as readonly string[]).includes(providerId);
}

/**
 * Return the provider's own server-executed tool under the identifier that
 * provider requires. Unsupported providers deliberately receive no placeholder.
 */
export function webSearchToolFor(providerId: string): ToolDescriptor | null {
  switch (providerId) {
    case "openai":
      return {
        name: "web_search",
        kind: "network",
        capability: "read",
        description: "Search the public web using OpenAI's provider-native search.",
        tool: openai.tools.webSearch({}),
      };
    case "anthropic":
      return {
        name: "web_search",
        kind: "network",
        capability: "read",
        description: "Search the public web using Anthropic's provider-native search.",
        tool: anthropic.tools.webSearch_20250305({ maxUses: 5 }),
      };
    case "google-ai-studio":
      return {
        name: "google_search",
        kind: "network",
        capability: "read",
        description: "Search the public web using Google Search grounding.",
        tool: google.tools.googleSearch({}),
      };
    default:
      return null;
  }
}

/** Add the unavailable fact once, even when a fallback also lacks search. */
export function withoutWebSearch(instructions: string): string {
  if (instructions.includes(NO_WEB_SEARCH_SENTENCE)) return instructions;
  return `${instructions}\n\n${NO_WEB_SEARCH_SENTENCE}`;
}
