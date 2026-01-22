/**
 * Chunk indexer for Parent Document Retriever pattern.
 * Splits notes into overlapping chunks, generates embeddings, and stores in LanceDB.
 */

import { getEmbeddingBatch } from "../embeddings/index.js";
import { getChunkStore, type ChunkRecord } from "../db/lancedb.js";
import { getAllNotesWithFallback, type NoteDetails } from "../notes/read.js";
import { chunkText } from "../utils/chunker.js";
import { extractMetadata } from "../graph/extract.js";
import { DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP } from "../config/constants.js";
import { createDebugLogger } from "../utils/debug.js";
import { filterContent, shouldIndexContent } from "../utils/content-filter.js";

// Debug logging
const debug = createDebugLogger("CHUNK-INDEXER");

/**
 * Result of a chunk indexing operation.
 */
export interface ChunkIndexResult {
  /** Total number of notes processed */
  totalNotes: number;
  /** Total number of chunks created */
  totalChunks: number;
  /** Number of chunks indexed (with embeddings) */
  indexed: number;
  /** Time taken in milliseconds */
  timeMs: number;
  /** Notes that could not be read (locked, syncing, corrupted) */
  skippedNotes?: string[];
}

/** Chunk record for internal processing - explicit types to avoid index signature issues */
interface InternalChunkRecord {
  chunk_id: string;
  note_id: string;
  note_title: string;
  folder: string;
  chunk_index: number;
  total_chunks: number;
  content: string;
  vector: number[];
  created: string;
  modified: string;
  indexed_at: string;
  tags: string[];
  outlinks: string[];
}

/**
 * Convert a note into chunk records WITHOUT vectors.
 * Vectors are added later during batch embedding generation.
 *
 * Filters out Base64/binary content before chunking to improve search quality.
 *
 * @param note - The note to chunk
 * @returns Array of ChunkRecord with empty vectors
 */
export function chunkNote(note: NoteDetails): InternalChunkRecord[] {
  // Quick check - skip notes with mostly encoded content
  if (!shouldIndexContent(note.content)) {
    debug(`Note "${note.title}" skipped: contains mostly encoded/binary content`);
    return [];
  }

  // Filter content to remove Base64 blocks and redact secrets
  const filterResult = filterContent(note.content);

  if (filterResult.action === "skip") {
    debug(`Note "${note.title}" skipped: ${filterResult.reasons.join(", ")}`);
    return [];
  }

  const contentToChunk = filterResult.cleanedContent || note.content;

  if (filterResult.action === "filter") {
    debug(`Note "${note.title}" filtered: ${filterResult.reasons.join(", ")}`);
  }

  // Extract metadata from the ORIGINAL content (tags/links should be preserved)
  const { tags, outlinks } = extractMetadata(note.content);

  // Chunk the filtered content
  const chunks = chunkText(contentToChunk, {
    chunkSize: DEFAULT_CHUNK_SIZE,
    overlap: DEFAULT_CHUNK_OVERLAP,
  });

  // Return empty array for empty notes (chunkText handles this)
  if (chunks.length === 0) {
    debug(`Note "${note.title}" has no content to chunk`);
    return [];
  }

  debug(`Note "${note.title}" chunked into ${chunks.length} chunks`);

  // Convert to ChunkRecord format
  return chunks.map((chunk) => ({
    chunk_id: `${note.id}_chunk_${chunk.index}`,
    note_id: note.id,
    note_title: note.title,
    folder: note.folder,
    chunk_index: chunk.index,
    total_chunks: chunk.totalChunks,
    content: chunk.content,
    vector: [], // Empty - to be filled during embedding generation
    created: note.created,
    modified: note.modified,
    indexed_at: "", // Empty - to be set during batch processing
    tags,
    outlinks,
  }));
}

/**
 * Perform a full chunk index of all notes.
 *
 * Phases:
 * 1. Fetch all notes via getAllNotesWithFallback (with hybrid fallback)
 * 2. Chunk all notes using chunkNote
 * 3. Generate embeddings in batch using getEmbeddingBatch
 * 4. Combine chunks with vectors and set indexed_at
 * 5. Store via getChunkStore().indexChunks()
 *
 * @returns ChunkIndexResult with stats
 */
export async function fullChunkIndex(): Promise<ChunkIndexResult> {
  const startTime = Date.now();

  // Phase 1: Fetch all notes with hybrid fallback
  debug("Phase 1: Fetching all notes with fallback...");
  const { notes, skipped: skippedNotes } = await getAllNotesWithFallback();
  debug(`Fetched ${notes.length} notes, skipped ${skippedNotes.length}`);

  if (notes.length === 0) {
    return {
      totalNotes: 0,
      totalChunks: 0,
      indexed: 0,
      timeMs: Date.now() - startTime,
      skippedNotes: skippedNotes.length > 0 ? skippedNotes : undefined,
    };
  }

  // Phase 2: Chunk all notes
  debug("Phase 2: Chunking all notes...");
  const allChunks: InternalChunkRecord[] = [];
  for (const note of notes) {
    const noteChunks = chunkNote(note);
    allChunks.push(...noteChunks);
  }
  debug(`Created ${allChunks.length} chunks from ${notes.length} notes`);

  if (allChunks.length === 0) {
    return {
      totalNotes: notes.length,
      totalChunks: 0,
      indexed: 0,
      timeMs: Date.now() - startTime,
    };
  }

  // Phase 3: Generate embeddings in batch
  debug("Phase 3: Generating embeddings...");
  const chunkTexts: string[] = allChunks.map((chunk) => chunk.content);
  const vectors = await getEmbeddingBatch(chunkTexts);
  debug(`Generated ${vectors.length} embeddings`);

  // Phase 4: Combine chunks with vectors and set indexed_at
  debug("Phase 4: Combining chunks with vectors...");
  const indexedAt = new Date().toISOString();
  const completeChunks: ChunkRecord[] = allChunks.map((chunk, i) => ({
    ...chunk,
    vector: vectors[i],
    indexed_at: indexedAt,
  }));

  // Phase 5: Store in LanceDB
  debug("Phase 5: Storing chunks...");
  const chunkStore = getChunkStore();
  await chunkStore.indexChunks(completeChunks);
  debug(`Stored ${completeChunks.length} chunks`);

  const timeMs = Date.now() - startTime;
  debug(`Chunk indexing completed in ${timeMs}ms`);

  return {
    totalNotes: notes.length,
    totalChunks: allChunks.length,
    indexed: completeChunks.length,
    timeMs,
    skippedNotes: skippedNotes.length > 0 ? skippedNotes : undefined,
  };
}

/**
 * Check if a chunk index exists.
 *
 * @returns true if chunk index has records, false otherwise
 */
export async function hasChunkIndex(): Promise<boolean> {
  try {
    const chunkStore = getChunkStore();
    const count = await chunkStore.count();
    return count > 0;
  } catch {
    // Table doesn't exist or error - no index
    return false;
  }
}

/**
 * Update chunks for specific notes (used by smart refresh).
 * Deletes old chunks for these notes and creates new ones.
 *
 * @param notes - Notes to update chunks for
 * @returns Number of chunks created
 */
export async function updateChunksForNotes(notes: NoteDetails[]): Promise<number> {
  if (notes.length === 0) return 0;

  debug(`Updating chunks for ${notes.length} notes...`);

  // Chunk all notes
  const allChunks: InternalChunkRecord[] = [];
  for (const note of notes) {
    const noteChunks = chunkNote(note);
    allChunks.push(...noteChunks);
  }

  if (allChunks.length === 0) {
    debug("No chunks to update");
    return 0;
  }

  // Generate embeddings
  debug(`Generating embeddings for ${allChunks.length} chunks...`);
  const chunkTexts = allChunks.map((chunk) => chunk.content);
  const vectors = await getEmbeddingBatch(chunkTexts);

  // Combine with vectors
  const indexedAt = new Date().toISOString();
  const completeChunks: ChunkRecord[] = allChunks.map((chunk, i) => ({
    ...chunk,
    vector: vectors[i],
    indexed_at: indexedAt,
  }));

  // Delete old chunks for these notes and add new ones
  const chunkStore = getChunkStore();
  const noteIds = notes.map((n) => n.id);
  await chunkStore.deleteChunksByNoteIds(noteIds);
  await chunkStore.addChunks(completeChunks);

  debug(`Updated ${completeChunks.length} chunks for ${notes.length} notes`);
  return completeChunks.length;
}
