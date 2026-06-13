/**
 * Page Context Management
 *
 * Handles truncation, formatting, and injection of page content
 * into pi's conversation context.
 */

import type { PageContext } from "./types.js";
import type { BridgeConfig } from "./config.js";

/**
 * Truncate and prepare page context for injection into the LLM.
 * Keeps metadata, trims content to configured max length.
 */
export function preparePageContext(pageContext: PageContext, config: BridgeConfig): PageContext {
  const maxLen = config.maxPageContextLength;

  let textContent = pageContext.textContent ?? "";
  let content = pageContext.content ?? "";

  if (textContent.length > maxLen) {
    textContent = textContent.slice(0, maxLen) + "\n\n[... content truncated ...]";
  }
  if (content.length > maxLen) {
    content = content.slice(0, maxLen) + "\n\n[... content truncated ...]";
  }

  return {
    ...pageContext,
    textContent,
    content,
    length: textContent.length,
  };
}

/**
 * Format page context as a system message for the LLM.
 * This is injected as a user message or system prompt context.
 */
export function formatPageContext(pageContext: PageContext): string {
  const parts: string[] = [];
  parts.push(`📄 Current Page: ${pageContext.title}`);
  parts.push(`🔗 URL: ${pageContext.url}`);

  if (pageContext.byline) {
    parts.push(`✍️ Author: ${pageContext.byline}`);
  }
  if (pageContext.excerpt) {
    parts.push(`📝 Excerpt: ${pageContext.excerpt}`);
  }

  parts.push("");

  if (pageContext.selection) {
    parts.push(`📌 User Selection:\n${pageContext.selection}\n`);
  }

  if (pageContext.textContent) {
    parts.push(`📖 Page Content:\n${pageContext.textContent}`);
  } else if (pageContext.content) {
    parts.push(`📖 Page Content (HTML stripped for context):\n${pageContext.content.replace(/<[^>]*>/g, "")}`);
  }

  return parts.join("\n");
}

/**
 * Build the system prompt context about the current page.
 * This is mixed into the conversation for pi to see.
 */
export function buildPageSystemPrompt(pageContext: PageContext, config: BridgeConfig): string {
  const ctx = preparePageContext(pageContext, config);
  return formatPageContext(ctx);
}
