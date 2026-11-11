/**
 * Text chunker with recursive character splitting that respects natural boundaries.
 * Prioritizes splitting at: paragraphs > sentences > words > characters
 */

/**
 * Separators in priority order - prefer splitting at larger boundaries first
 */
export const SEPARATORS = [
  "\n\n", // Paragraph
  "\n", // Line
  ". ", // Sentence (period)
  "! ", // Sentence (exclamation)
  "? ", // Sentence (question)
  "; ", // Clause
  ", ", // Phrase
  " ", // Word
  "", // Character (fallback)
] as const;

export interface ChunkOptions {
  /** Maximum size of each chunk in characters */
  chunkSize: number;
  /** Number of characters to overlap between chunks */
  overlap: number;
}

export interface ChunkResult {
  /** The text content of this chunk */
  content: string;
  /** Zero-based index of this chunk */
  index: number;
  /** Total number of chunks */
  totalChunks: number;
  /** Start position in original text */
  startPos: number;
  /** End position in original text (exclusive) */
  endPos: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  chunkSize: 500,
  overlap: 100,
};

/**
 * Find the best split point at or before the target position.
 * Looks back at most 50 characters (never before `minPos`) and returns the
 * position right after the highest-priority separator found, closest to target.
 *
 * @param text - The full text to search in
 * @param target - The maximum split position
 * @param minPos - Lower bound for the search window (default 0)
 * @returns The best split position (after the separator), or target if none
 */
export function findSplitPoint(text: string, target: number, minPos = 0): number {
  const searchWindow = Math.max(0, Math.min(50, Math.floor((target - minPos) / 2)));
  const searchStart = target - searchWindow;
  const searchText = text.slice(searchStart, target);

  for (const sep of SEPARATORS) {
    if (sep === "") continue; // Character fallback = target itself
    const idx = searchText.lastIndexOf(sep);
    if (idx !== -1) {
      return searchStart + idx + sep.length;
    }
  }

  return target;
}

/** True if `pos` falls between the two halves of a UTF-16 surrogate pair. */
function splitsSurrogatePair(text: string, pos: number): boolean {
  if (pos <= 0 || pos >= text.length) return false;
  const prev = text.charCodeAt(pos - 1);
  const next = text.charCodeAt(pos);
  return prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
}

/**
 * Split text into overlapping chunks that respect natural boundaries.
 *
 * Invariants: every chunk is at most `chunkSize` UTF-16 units, consecutive
 * chunks overlap by `overlap` units (less only when needed to make progress or
 * to avoid splitting a surrogate pair), and chunks cover the whole text.
 *
 * @param text - The text to chunk
 * @param options - Chunk size and overlap options
 * @returns Array of chunk results
 */
export function chunkText(
  text: string,
  options: ChunkOptions = DEFAULT_CHUNK_OPTIONS
): ChunkResult[] {
  const { chunkSize, overlap } = options;

  if (text.trim().length === 0) {
    return [];
  }

  if (text.length <= chunkSize) {
    return [{ content: text, index: 0, totalChunks: 1, startPos: 0, endPos: text.length }];
  }

  const chunks: ChunkResult[] = [];
  let startPos = 0;

  while (true) {
    let endPos = Math.min(startPos + chunkSize, text.length);

    if (endPos < text.length) {
      // Split no earlier than past the overlap, so the next chunk always advances
      endPos = findSplitPoint(text, endPos, startPos + overlap);
      if (splitsSurrogatePair(text, endPos) && endPos - 1 > startPos) endPos -= 1;
    }

    chunks.push({
      content: text.slice(startPos, endPos),
      index: chunks.length,
      totalChunks: 0, // Set after all chunks are created
      startPos,
      endPos,
    });

    if (endPos >= text.length) break;

    startPos = Math.max(startPos + 1, endPos - overlap);
    if (splitsSurrogatePair(text, startPos)) startPos += 1;
  }

  for (const chunk of chunks) {
    chunk.totalChunks = chunks.length;
  }

  return chunks;
}
