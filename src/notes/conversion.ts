/**
 * HTML to Markdown conversion for Apple Notes content.
 */

import TurndownService from "turndown";
import { parseTable } from "./tables.js";

/**
 * Convert table rows to Markdown table format.
 * First row is treated as header.
 *
 * @example
 * tableToMarkdown([["Name", "Value"], ["foo", "bar"]])
 * // | Name | Value |
 * // |---|---|
 * // | foo | bar |
 */
function tableToMarkdown(rows: string[][]): string {
  if (rows.length === 0) return "";

  // Cells bypass Turndown's text escaping, so run the same escaper here; then
  // escape pipes and keep in-cell line breaks as <br> so the row stays on one line.
  const toLine = (row: string[]) =>
    `| ${row
      .map((cell) => turndownService.escape(cell).replace(/\|/g, "\\|").replace(/\n/g, "<br>"))
      .join(" | ")} |`;
  const separator = `|${rows[0].map(() => "---").join("|")}|`;
  return [toLine(rows[0]), separator, ...rows.slice(1).map(toLine)].join("\n");
}

/**
 * The DOM surface our rules touch. tsconfig has no DOM lib, so Turndown's
 * `HTMLElement` node type is unavailable; this structural type covers it.
 */
interface ElementLike {
  nodeName: string;
  outerHTML: string;
  getAttribute(name: string): string | null;
  getElementsByTagName(name: string): ArrayLike<unknown>;
}

/**
 * Placeholder for an attachment (<object> without a table, or <img>).
 * `data:` URIs are skipped: their "filename" would be the whole base64 payload.
 */
function attachmentPlaceholder(element: ElementLike): string {
  const src = element.getAttribute("src");
  const srcName = src && !src.startsWith("data:") ? src.split("/").pop() : undefined;
  const name =
    element.getAttribute("data-filename") ||
    element.getAttribute("alt") ||
    srcName ||
    (element.nodeName === "IMG" ? "image" : "unknown");
  return `[Attachment: ${name}]`;
}

/** Apple Notes wraps tables in <object>; those are not attachments. */
function isAttachment(node: ElementLike): boolean {
  if (node.nodeName === "IMG") return true;
  return node.nodeName === "OBJECT" && node.getElementsByTagName("table").length === 0;
}

const turndownService = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  // Empty <object data-filename=…></object> is "blank" to Turndown and would
  // otherwise bypass the attachments rule.
  blankReplacement: (_content, node) => {
    const element = node as ElementLike;
    if (isAttachment(element)) return attachmentPlaceholder(element);
    return "isBlock" in node && node.isBlock ? "\n\n" : "";
  },
});

/*
 * Escaping: Turndown's default escaper backslash-escapes every `[`, `]` and `_`.
 * That turns `[[Wiki Link]]` into `\[\[Wiki Link\]\]` and `#my_tag` into
 * `#my\_tag`, so graph extraction (outlinks, tags) never sees them. We keep the
 * default escaping but leave `[[...]]` verbatim (unless followed by `(`, which
 * would make it a Markdown link `[[x]](url)`) and drop `\_` between word
 * characters (intraword `_` is never emphasis in CommonMark).
 */
const defaultEscape = turndownService.escape.bind(turndownService);
const WIKI_LINK = /(\[\[[^[\]\n]+\]\](?!\())/;
const INTRAWORD_UNDERSCORE = /(?<=[\p{L}\p{N}])((?:\\_)+)(?=[\p{L}\p{N}])/gu;

turndownService.escape = (text: string): string =>
  text
    .split(WIKI_LINK)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : defaultEscape(part).replace(INTRAWORD_UNDERSCORE, (run) => run.replace(/\\_/g, "_"))
    )
    .join("");

// Tables: render from the raw table HTML so cells keep their own line breaks
// and aren't run through Turndown's whitespace collapsing (cells are escaped
// in tableToMarkdown).
turndownService.addRule("tables", {
  filter: "table",
  replacement: (_content, node) => {
    const markdown = tableToMarkdown(parseTable((node as ElementLike).outerHTML).rows);
    return markdown ? `\n\n${markdown}\n\n` : "";
  },
});

turndownService.addRule("attachments", {
  filter: (node) => isAttachment(node),
  replacement: (_content, node) => attachmentPlaceholder(node as ElementLike),
});

/**
 * Convert HTML content to Markdown, handling Apple Notes specifics.
 */
export function htmlToMarkdown(html: string): string {
  if (!html) return "";
  return turndownService.turndown(html).trim();
}
