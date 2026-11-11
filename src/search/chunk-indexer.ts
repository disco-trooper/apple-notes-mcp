/**
 * Note preparation and chunking for the Parent Document Retriever pattern.
 *
 * prepareNote() is the single content-prep step for BOTH index tables:
 * it redacts secrets and strips Base64 before anything is stored or sent
 * to an embedding provider.
 */

import { getChunkStore, type ChunkRecord } from "../db/lancedb.js";
import type { NoteDetails } from "../notes/read.js";
import { chunkText } from "../utils/chunker.js";
import { extractMetadata } from "../graph/extract.js";
import { DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP } from "../config/constants.js";
import { createDebugLogger } from "../utils/debug.js";
import { filterContent } from "../utils/content-filter.js";

const debug = createDebugLogger("CHUNK-INDEXER");

/** A note whose content has been filtered and is ready to embed. */
export interface PreparedNote {
  note: NoteDetails;
  /** Filtered content (Base64 removed, secrets redacted). */
  text: string;
  /** Tags extracted from the original content. */
  tags: string[];
  /** Wiki-link targets extracted from the original content. */
  outlinks: string[];
}

/**
 * Chunk row before embedding. Pick (not Omit): ChunkRecord has an index
 * signature, which makes Omit collapse every named field.
 */
export type UnembeddedChunk = Pick<
  ChunkRecord,
  | "chunk_id"
  | "note_id"
  | "note_title"
  | "folder"
  | "chunk_index"
  | "total_chunks"
  | "content"
  | "created"
  | "modified"
  | "tags"
  | "outlinks"
>;

/**
 * Filter a note's content for indexing.
 *
 * Returns null when nothing indexable remains (empty note, binary or mostly
 * encoded content). Short notes are kept: only an empty result is skipped.
 */
export function prepareNote(note: NoteDetails): PreparedNote | null {
  if (!note.content.trim()) {
    return null;
  }

  const filterResult = filterContent(note.content);
  if (filterResult.action === "skip" || !filterResult.cleanedContent) {
    debug(`Note "${note.title}" skipped: ${filterResult.reasons.join(", ")}`);
    return null;
  }
  if (filterResult.action === "filter") {
    debug(`Note "${note.title}" filtered: ${filterResult.reasons.join(", ")}`);
  }

  // Tags and links come from the original content so filtering cannot drop them.
  const { tags, outlinks } = extractMetadata(note.content);

  return { note, text: filterResult.cleanedContent, tags, outlinks };
}

/**
 * Split a prepared note into chunk rows (without vectors).
 */
export function chunkNote(prepared: PreparedNote): UnembeddedChunk[] {
  const { note, tags, outlinks } = prepared;
  const pieces = chunkText(prepared.text, {
    chunkSize: DEFAULT_CHUNK_SIZE,
    overlap: DEFAULT_CHUNK_OVERLAP,
  });

  debug(`Note "${note.title}" chunked into ${pieces.length} chunks`);

  return pieces.map((chunk) => ({
    chunk_id: `${note.id}_chunk_${chunk.index}`,
    note_id: note.id,
    note_title: note.title,
    folder: note.folder,
    chunk_index: chunk.index,
    total_chunks: chunk.totalChunks,
    content: chunk.content,
    created: note.created,
    modified: note.modified,
    tags,
    outlinks,
  }));
}

/**
 * Check if a chunk index exists.
 *
 * @returns true if chunk index has records, false otherwise
 */
export async function hasChunkIndex(): Promise<boolean> {
  return (await getChunkStore().count()) > 0;
}
