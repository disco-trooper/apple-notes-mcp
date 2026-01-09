/**
 * HTML to Markdown conversion for Apple Notes content.
 */

import TurndownService from "turndown";

// Initialize Turndown for HTML to Markdown conversion
const turndownService = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

// Add custom rule to handle Apple Notes attachment placeholders
turndownService.addRule("attachments", {
  filter: (node) => {
    // Apple Notes uses object tags for attachments
    return node.nodeName === "OBJECT" || node.nodeName === "IMG";
  },
  replacement: (_content, node) => {
    // Turndown uses its own Node type, cast to access attributes
    const element = node as unknown as {
      getAttribute: (name: string) => string | null;
    };
    const filename =
      element.getAttribute("data-filename") ||
      element.getAttribute("alt") ||
      element.getAttribute("src")?.split("/").pop() ||
      "unknown";
    return `[Attachment: ${filename}]`;
  },
});

/**
 * Convert HTML content to Markdown, handling Apple Notes specifics.
 */
export function htmlToMarkdown(html: string): string {
  if (!html) return "";

  // Pre-process: handle Apple Notes specific markup
  let processed = html;

  // Replace attachment objects with placeholder text before Turndown
  processed = processed.replace(
    /<object[^>]*data-filename="([^"]*)"[^>]*>.*?<\/object>/gi,
    "[Attachment: $1]"
  );

  // Handle inline images
  processed = processed.replace(
    /<img[^>]*(?:alt="([^"]*)")?[^>]*>/gi,
    (_match, alt) => {
      const filename = alt || "image";
      return `[Attachment: ${filename}]`;
    }
  );

  // Convert to Markdown
  const markdown = turndownService.turndown(processed);

  return markdown.trim();
}
