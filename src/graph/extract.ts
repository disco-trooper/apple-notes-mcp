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
 * Hex colour code (`#fff`, `#a1b2c3`, `#ffffffcc`): 3, 4, 6 or 8 hex digits.
 * Words made only of hex letters (`#bad`, `#cafe`) are dropped too; in real
 * notes those are far more often colours than tags.
 */
function isHexColor(value: string): boolean {
  return /^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value);
}

/**
 * Hashtag: `#` not preceded by a word character, `/`, `&`, `#` or `\`
 * (so `foo#bar`, `&#123;` and `##` don't match), nor by `_` that follows a
 * word character (`foo_#bar`); a lone `_` is Turndown italics (`_#idea_`).
 * Then Unicode letters, digits, `_` and `-`.
 */
const TAG_PATTERN =
  /(?<![\p{L}\p{N}\p{M}/&#\\])(?<![\p{L}\p{N}\p{M}]_)#([\p{L}\p{N}_][\p{L}\p{N}\p{M}_-]*)/gu;

/**
 * Extract hashtags from content, lowercased and deduplicated.
 * Ignores code, URL fragments, hex colours, purely numeric tags (`#42`) and
 * single-character tags.
 */
export function extractTags(content: string): string[] {
  // Drop URLs first so their `#fragment` parts are not read as tags.
  const text = prepare(content).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "");
  const tags: string[] = [];
  for (const match of text.matchAll(TAG_PATTERN)) {
    const tag = match[1].replace(/[-_]+$/, "").toLowerCase();
    if (tag.length < 2 || /^\d+$/.test(tag) || isHexColor(tag)) continue;
    tags.push(tag);
  }
  return [...new Set(tags)];
}

/**
 * Extract wiki-style [[links]] from content.
 * `[[Title|alias]]` resolves to `Title`; `#` is kept because it may be part
 * of the title (`[[C# cheatsheet]]`). Use resolveLink to look targets up.
 * Ignores links inside code blocks.
 */
export function extractOutlinks(content: string): string[] {
  const links: string[] = [];
  // `[[x]](url)` is a Markdown link with a bracketed label, not a wiki link.
  for (const match of prepare(content).matchAll(/\[\[([^[\]\n]+)\]\](?!\()/g)) {
    const target = match[1].split("|")[0].trim();
    if (target) links.push(target);
  }
  return [...new Set(links)];
}

/**
 * Resolve an outlink against a lowercase-title map: the full target first
 * (`C# cheatsheet`), then the part before `#` (`Note#heading` -> `Note`).
 */
export function resolveLink<T>(link: string, byLowerTitle: Map<string, T>): T | undefined {
  const key = link.toLowerCase();
  const exact = byLowerTitle.get(key);
  if (exact !== undefined) return exact;
  const hash = key.indexOf("#");
  if (hash <= 0) return undefined;
  return byLowerTitle.get(key.slice(0, hash).trim());
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
