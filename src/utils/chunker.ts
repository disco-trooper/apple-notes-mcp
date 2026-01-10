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
 * Find the best split point near the target position.
 * Searches for separators in priority order within a reasonable range.
 *
 * @param text - The full text to search in
 * @param target - The target position to split near
 * @returns The best split position (after the separator)
 */
export function findSplitPoint(text: string, target: number): number {
  // Search window: look backwards and forwards from target
  const searchWindow = Math.min(50, Math.floor(target / 2));
  const searchStart = Math.max(0, target - searchWindow);
  const searchEnd = Math.min(text.length, target + searchWindow);
  const searchText = text.slice(searchStart, searchEnd);

  // Try each separator in priority order
  for (const sep of SEPARATORS) {
    if (sep === "") continue; // Skip empty string fallback for now

    // Find all occurrences of separator in search window
    let bestPos = -1;
    let bestDistance = Infinity;

    let idx = 0;
    while ((idx = searchText.indexOf(sep, idx)) !== -1) {
      const absolutePos = searchStart + idx + sep.length;
      const distance = Math.abs(absolutePos - target);

      if (distance < bestDistance) {
        bestDistance = distance;
        bestPos = absolutePos;
      }
      idx += 1;
    }

    if (bestPos !== -1) {
      return bestPos;
    }
  }

  // No separator found, return target as-is
  return target;
}

/**
 * Split text into overlapping chunks that respect natural boundaries.
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

  // Handle empty or whitespace-only text
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }

  // If text fits in a single chunk, return it
  if (text.length <= chunkSize) {
    return [
      {
        content: text,
        index: 0,
        totalChunks: 1,
        startPos: 0,
        endPos: text.length,
      },
    ];
  }

  const chunks: ChunkResult[] = [];
  let startPos = 0;
  // Minimum step size to ensure progress and avoid tiny chunks
  const minStep = Math.max(1, chunkSize - overlap);

  while (startPos < text.length) {
    // Calculate target end position
    let endPos = Math.min(startPos + chunkSize, text.length);

    // If not at the end, find a good split point
    if (endPos < text.length) {
      const splitPoint = findSplitPoint(text, endPos);
      // Only use split point if it creates a reasonably sized chunk
      if (
        splitPoint > startPos + minStep / 2 &&
        splitPoint - startPos <= chunkSize * 1.2
      ) {
        endPos = splitPoint;
      }
    }

    // Extract chunk content
    const content = text.slice(startPos, endPos);

    chunks.push({
      content,
      index: chunks.length,
      totalChunks: 0, // Will be set after all chunks are created
      startPos,
      endPos,
    });

    // If we've reached the end, stop
    if (endPos >= text.length) {
      break;
    }

    // Move to next chunk - ensure minimum step for progress
    startPos = startPos + minStep;
  }

  // Set totalChunks on all chunks
  const totalChunks = chunks.length;
  for (const chunk of chunks) {
    chunk.totalChunks = totalChunks;
  }

  return chunks;
}
