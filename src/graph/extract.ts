/**
 * Knowledge graph metadata extraction from note content.
 */

/** Remove code blocks and inline code to avoid extracting metadata from code. */
function stripCodeBlocks(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, "") // fenced code blocks
    .replace(/`[^`]+`/g, ""); // inline code
}

/** Check if a string is a hex color code (e.g., fff, 000000, a1b2c3) */
function isHexColor(value: string): boolean {
  return /^[0-9a-fA-F]+$/.test(value);
}

/**
 * Extract hashtags from content.
 * Ignores tags inside code blocks and hex color codes.
 */
export function extractTags(content: string): string[] {
  const matches = stripCodeBlocks(content).match(/#[\w-]+/g) || [];
  const tags = matches
    .map((t) => t.slice(1).toLowerCase())
    .filter((t) => !isHexColor(t));
  return [...new Set(tags)];
}

/**
 * Extract wiki-style [[links]] from content.
 * Ignores links inside code blocks.
 */
export function extractOutlinks(content: string): string[] {
  const matches = stripCodeBlocks(content).match(/\[\[([^\]]+)\]\]/g) || [];
  const links = matches.map((m) => m.slice(2, -2));
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
