/**
 * HTML to Markdown conversion for Apple Notes content.
 */

import TurndownService from "turndown";
import { parseTable } from "./tables.js";

/**
 * Escape pipe characters in cell content for Markdown table compatibility.
 * @param cell - Cell content to escape
 * @returns Cell content with pipes escaped as \|
 */
function escapeCell(cell: string): string {
  return cell.replace(/\|/g, "\\|");
}

/**
 * Convert table rows to Markdown table format.
 * First row is treated as header.
 *
 * @param rows - 2D array of strings, where rows[0] is the header row
 * @returns Markdown table string with header, separator, and body rows
 *
 * @example
 * tableToMarkdown([["Name", "Value"], ["foo", "bar"]])
 * // Returns:
 * // | Name | Value |
 * // |---|---|
 * // | foo | bar |
 */
function tableToMarkdown(rows: string[][]): string {
  if (rows.length === 0) return "";

  const header = `| ${rows[0].map(escapeCell).join(" | ")} |`;
  const separator = `|${rows[0].map(() => "---").join("|")}|`;
  const body = rows.slice(1).map((row) => `| ${row.map(escapeCell).join(" | ")} |`).join("\n");

  return body ? `${header}\n${separator}\n${body}` : `${header}\n${separator}`;
}

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

  // Convert tables to Markdown BEFORE attachment processing
  // (Tables are wrapped in <object> tags in Apple Notes)
  const tableRegex = /<object[^>]*>[\s\S]*?<table[\s\S]*?<\/table>[\s\S]*?<\/object>/gi;
  processed = processed.replace(tableRegex, (match) => {
    const tableData = parseTable(match);
    if (tableData.rows.length === 0) return match;
    return "\n\n" + tableToMarkdown(tableData.rows) + "\n\n";
  });

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
