/**
 * Knowledge graph metadata extraction from note content.
 *
 * Input is the Markdown produced by htmlToMarkdown (Turndown), which
 * backslash-escapes Markdown punctuation (`\[\[Link\]\]`, `#my\_tag`).
 * Escapes are removed before matching.
 */

/**
 * Normalise note Markdown for extraction: remove CommonMark backslash escapes
 * (`\[` -> `[`, `\_` -> `_`), then drop fenced and inline code.
 */
function prepare(content: string): string {
  return content
    .replace(/\\([!-/:-@[-`{-~])/g, "$1")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]+`/g, "")
    .normalize("NFC");
}

/**
 * Hex colour code (`#a1b2c3`, `#000`, `#ff0000cc`): 3, 6 or 8 hex digits
 * with at least one decimal digit, so words like `#bad` or `#cafe` stay tags.
 */
function isHexColor(value: string): boolean {
  return /^(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value) && /\d/.test(value);
}

/**
 * Hashtag: `#` not preceded by a word character, `/`, `&`, `#` or `\`
 * (so `foo#bar`, `&#123;` and `##` don't match), then Unicode letters,
 * digits, `_` and `-`.
 */
const TAG_PATTERN = /(?<![\p{L}\p{N}\p{M}_/&#\\])#([\p{L}\p{N}_][\p{L}\p{N}\p{M}_-]*)/gu;

/**
 * Extract hashtags from content, lowercased and deduplicated.
 * Ignores code, URL fragments, hex colours and purely numeric tags (`#42`).
 */
export function extractTags(content: string): string[] {
  // Drop URLs first so their `#fragment` parts are not read as tags.
  const text = prepare(content).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "");
  const tags: string[] = [];
  for (const match of text.matchAll(TAG_PATTERN)) {
    const tag = match[1].replace(/-+$/, "").toLowerCase();
    if (!tag || /^\d+$/.test(tag) || isHexColor(tag)) continue;
    tags.push(tag);
  }
  return [...new Set(tags)];
}

/**
 * Extract wiki-style [[links]] from content.
 * `[[Title|alias]]` and `[[Title#heading]]` resolve to `Title`.
 * Ignores links inside code blocks.
 */
export function extractOutlinks(content: string): string[] {
  const links: string[] = [];
  for (const match of prepare(content).matchAll(/\[\[([^[\]\n]+)\]\]/g)) {
    const target = match[1].split("|")[0].split("#")[0].trim();
    if (target) links.push(target);
  }
  return [...new Set(links)];
}

export interface NoteMetadata {
  tags: string[];
  outlinks: string[];
}

/**
 * Extract all metadata (tags and outlinks) from content.
 */
export function extractMetadata(content: string): NoteMetadata {
  return {
    tags: extractTags(content),
    outlinks: extractOutlinks(content),
  };
}
