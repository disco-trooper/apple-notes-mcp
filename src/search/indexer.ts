/**
 * Note indexing pipeline for semantic search.
 *
 * Supports:
 * - Full reindexing (drop all, reindex everything)
 * - Incremental indexing (only changed notes)
 * - Single note reindexing
 */

import { getEmbedding, getEmbeddingBatch } from "../embeddings/index.js";
import {
  getVectorStore,
  type NoteRecord,
  type IndexMetadataRecord,
} from "../db/lancedb.js";
import {
  getAllNotesWithFallback,
  getNoteByTitle,
} from "../notes/read.js";
import { createDebugLogger } from "../utils/debug.js";
import { truncateForEmbedding } from "../utils/text.js";
import { NoteNotFoundError } from "../errors/index.js";
import { extractMetadata } from "../graph/extract.js";
import { getEmbeddingBatchSize } from "../config/constants.js";
import {
  type IndexRunOptions,
  type IndexProgressEvent,
  throwIfCancelled,
} from "../indexing/contracts.js";

/**
 * Extract note title from folder/title key.
 * Handles nested folders correctly by taking the last segment.
 */
export function extractTitleFromKey(key: string): string {
  return key.split("/").at(-1) ?? key;
}

// Debug logging
const debug = createDebugLogger("INDEX");

/**
 * Result of an indexing operation.
 */
export interface IndexResult {
  /** Total notes processed */
  total: number;
  /** Notes successfully indexed */
  indexed: number;
  /** Notes that failed to index */
  errors: number;
  /** Time taken in milliseconds */
  timeMs: number;
  /** Breakdown for incremental indexing */
  breakdown?: {
    added: number;
    updated: number;
    deleted: number;
    skipped: number;
  };
  /** List of notes that failed to index (for debugging) */
  failedNotes?: string[];
  /** Notes skipped during fetch (locked, syncing, corrupted) */
  skippedNotes?: string[];
}

/**
 * Note data prepared for embedding.
 */
interface PreparedNote {
  id: string;
  title: string;
  content: string;
  truncatedContent: string;
  folder: string;
  created: string;
  modified: string;
  tags: string[];
  outlinks: string[];
}

/**
 * Prepare a note for embedding by extracting metadata and truncating content.
 * Returns null if the note content is empty.
 */
function prepareNoteForEmbedding(note: {
  id: string;
  title: string;
  content: string;
  folder: string;
  created: string;
  modified: string;
}): PreparedNote | null {
  if (!note.content.trim()) {
    return null;
  }

  const metadata = extractMetadata(note.content);

  return {
    id: note.id,
    title: note.title,
    content: note.content,
    truncatedContent: truncateForEmbedding(note.content),
    folder: note.folder,
    created: note.created,
    modified: note.modified,
    tags: metadata.tags,
    outlinks: metadata.outlinks,
  };
}

/**
 * Build a NoteRecord from a PreparedNote and its embedding vector.
 */
function buildNoteRecord(
  note: PreparedNote,
  vector: number[],
  indexedAt: string
): NoteRecord {
  return {
    id: note.id,
    title: note.title,
    content: note.content,
    vector,
    folder: note.folder,
    created: note.created,
    modified: note.modified,
    indexed_at: indexedAt,
    tags: note.tags,
    outlinks: note.outlinks,
  };
}

/**
 * Split array into chunks of specified size.
 */
function chunks<T>(array: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

function emitProgress(
  options: IndexRunOptions,
  stage: IndexProgressEvent["stage"],
  current: number,
  total: number,
  message: string
): void {
  options.onProgress?.({
    stage,
    current,
    total,
    message,
  });
}

/**
 * Perform full reindexing of all notes.
 * Drops existing index and rebuilds from scratch.
 *
 * Uses:
 * - Hybrid fallback for JXA fetch (single call → folder → note-by-note)
 * - Streaming batch embedding (process & store in chunks to reduce memory)
 */
export async function fullIndex(options: IndexRunOptions = {}): Promise<IndexResult> {
  const startTime = Date.now();
  debug("Starting full index...");

  throwIfCancelled(options.signal);
  emitProgress(options, "fetch", 0, 1, "Fetching notes");

  // Phase 1: Fetch all notes with hybrid fallback
  debug("Phase 1: Fetching all notes (with fallback)...");
  const { notes: allNotes, skipped: skippedNotes } = await getAllNotesWithFallback();
  debug(`Fetched ${allNotes.length} notes, ${skippedNotes.length} skipped`);
  emitProgress(options, "fetch", 1, 1, `Fetched ${allNotes.length} notes`);
  throwIfCancelled(options.signal);

  // Filter empty notes and prepare for embedding
  const preparedNotes = allNotes
    .map((note) => prepareNoteForEmbedding(note))
    .filter((note): note is PreparedNote => note !== null);

  debug(`Prepared ${preparedNotes.length} notes for embedding`);
  emitProgress(options, "prepare", preparedNotes.length, allNotes.length, "Prepared notes for embedding");
  throwIfCancelled(options.signal);

  const store = getVectorStore();

  // Phase 2: Stream process in batches
  const batchSize = getEmbeddingBatchSize();
  debug(`Phase 2: Processing ${preparedNotes.length} notes in batches of ${batchSize}...`);

  const batches = chunks(preparedNotes, batchSize);
  const indexedAt = new Date().toISOString();
  let totalIndexed = 0;
  let isFirstBatch = true;

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    throwIfCancelled(options.signal);

    const batch = batches[batchIdx];
    debug(`Batch ${batchIdx + 1}/${batches.length}: ${batch.length} notes`);
    emitProgress(
      options,
      "embed",
      batchIdx,
      batches.length,
      `Embedding batch ${batchIdx + 1}/${batches.length}`
    );

    // Generate embeddings for this batch
    const textsToEmbed = batch.map((n) => n.truncatedContent);
    let vectors: number[][];
    try {
      vectors = await getEmbeddingBatch(textsToEmbed);
    } catch (error) {
      debug(`Batch ${batchIdx + 1} embedding failed:`, error);
      throw error;
    }
    throwIfCancelled(options.signal);
    emitProgress(
      options,
      "embed",
      batchIdx + 1,
      batches.length,
      `Embedded batch ${batchIdx + 1}/${batches.length}`
    );

    // Build records
    const records = batch.map((note, i) =>
      buildNoteRecord(note, vectors[i], indexedAt)
    );

    // Store immediately (first batch creates table, subsequent append)
    if (isFirstBatch) {
      await store.index(records);
      isFirstBatch = false;
    } else {
      await store.addRecords(records);
    }
    throwIfCancelled(options.signal);

    totalIndexed += records.length;
    debug(`Batch ${batchIdx + 1} stored, total: ${totalIndexed}`);
    emitProgress(
      options,
      "persist",
      batchIdx + 1,
      batches.length,
      `Stored batch ${batchIdx + 1}/${batches.length}`
    );
  }

  // Phase 3: Rebuild FTS index (once at end)
  debug("Phase 3: Rebuilding FTS index...");
  if (totalIndexed > 0) {
    emitProgress(options, "rebuild-fts", 0, 1, "Rebuilding FTS index");
    await store.rebuildFtsIndex();
    emitProgress(options, "rebuild-fts", 1, 1, "FTS index rebuilt");
  }

  const timeMs = Date.now() - startTime;
  const emptySkipped = allNotes.length - preparedNotes.length;
  debug(`Full index complete: ${totalIndexed} indexed, ${emptySkipped} empty, ${skippedNotes.length} fetch-skipped, ${timeMs}ms`);
  emitProgress(options, "done", 1, 1, "Full index completed");

  return {
    total: allNotes.length + skippedNotes.length,
    indexed: totalIndexed,
    errors: 0,
    timeMs,
    skippedNotes: skippedNotes.length > 0 ? skippedNotes : undefined,
  };
}

/**
 * Perform incremental indexing.
 * Only processes notes that have changed since last index.
 * Uses batch fetch (getAllNotesWithFallback) instead of individual JXA calls.
 */
export async function incrementalIndex(options: IndexRunOptions = {}): Promise<IndexResult> {
  const startTime = Date.now();
  debug("Starting incremental index...");

  throwIfCancelled(options.signal);
  emitProgress(options, "fetch", 0, 1, "Fetching notes for incremental index");

  const store = getVectorStore();

  // Get existing indexed notes first
  let existingRecords: IndexMetadataRecord[];
  try {
    existingRecords = await store.getIndexMetadata();
  } catch (error) {
    // No existing index, fall back to full index
    debug("No existing index found, performing full index. Error:", error);
    return fullIndex(options);
  }

  // Phase 1: Fetch ALL notes with content in batch (hybrid fallback)
  debug("Phase 1: Fetching all notes with fallback...");
  const { notes: allNotesWithContent, skipped: skippedNotes } = await getAllNotesWithFallback();
  debug(`Fetched ${allNotesWithContent.length} notes, skipped ${skippedNotes.length}`);
  emitProgress(options, "fetch", 1, 1, `Fetched ${allNotesWithContent.length} notes`);
  throwIfCancelled(options.signal);

  // Build lookup maps
  const existingByKey = new Map<string, IndexMetadataRecord>();
  for (const record of existingRecords) {
    const key = `${record.folder}/${record.title}`;
    existingByKey.set(key, record);
  }

  const currentByKey = new Map<string, typeof allNotesWithContent[0]>();
  for (const note of allNotesWithContent) {
    const key = `${note.folder}/${note.title}`;
    currentByKey.set(key, note);
  }

  // Determine what needs to be done
  const toAdd: typeof allNotesWithContent = [];
  const toUpdate: typeof allNotesWithContent = [];
  const toDelete: string[] = [];
  const toSkip: string[] = [];

  // Check current notes
  for (const note of allNotesWithContent) {
    const key = `${note.folder}/${note.title}`;
    const existing = existingByKey.get(key);

    if (!existing) {
      toAdd.push(note);
    } else {
      // Compare modified date with indexed_at timestamp
      const currentModified = new Date(note.modified).getTime();
      const indexedAt = new Date(existing.indexed_at).getTime();

      if (currentModified > indexedAt) {
        toUpdate.push(note);
      } else {
        toSkip.push(key);
      }
    }
  }

  // Check for deleted notes
  for (const [key] of existingByKey) {
    if (!currentByKey.has(key)) {
      toDelete.push(key);
    }
  }

  debug(`Incremental: add=${toAdd.length}, update=${toUpdate.length}, delete=${toDelete.length}, skip=${toSkip.length}`);

  let errors = 0;
  const failedNotes: string[] = [...skippedNotes]; // Include skipped notes from fallback

  // Process additions and updates - notes already have content!
  const toProcess = [...toAdd, ...toUpdate];
  emitProgress(options, "prepare", toProcess.length, allNotesWithContent.length, "Prepared notes to process");

  if (toProcess.length > 0) {
    // Phase 2: Prepare notes for embedding (content already fetched)
    debug(`Phase 2: Preparing ${toProcess.length} notes...`);
    const preparedNotes: PreparedNote[] = [];

    for (const noteDetails of toProcess) {
      throwIfCancelled(options.signal);
      const prepared = prepareNoteForEmbedding(noteDetails);
      if (prepared) {
        preparedNotes.push(prepared);
      }
    }

    if (preparedNotes.length > 0) {
      // Phase 3: Generate embeddings in batch
      debug(`Phase 3: Generating ${preparedNotes.length} embeddings in batch...`);
      const preparedBatches = chunks(preparedNotes, getEmbeddingBatchSize());
      let persistedCount = 0;

      for (let batchIdx = 0; batchIdx < preparedBatches.length; batchIdx++) {
        throwIfCancelled(options.signal);

        const batch = preparedBatches[batchIdx];
        emitProgress(
          options,
          "embed",
          batchIdx,
          preparedBatches.length,
          `Embedding batch ${batchIdx + 1}/${preparedBatches.length}`
        );

        const textsToEmbed = batch.map((n) => n.truncatedContent);

        let vectors: number[][];
        try {
          vectors = await getEmbeddingBatch(textsToEmbed);
        } catch (error) {
          debug("Batch embedding failed:", error);
          throw error;
        }

        emitProgress(
          options,
          "embed",
          batchIdx + 1,
          preparedBatches.length,
          `Embedded batch ${batchIdx + 1}/${preparedBatches.length}`
        );

        // Phase 4: Update database
        debug("Phase 4: Updating database...");
        const indexedAt = new Date().toISOString();

        for (let i = 0; i < batch.length; i++) {
          throwIfCancelled(options.signal);

          const note = batch[i];
          const record = buildNoteRecord(note, vectors[i], indexedAt);

          try {
            await store.update(record);
          } catch (error) {
            debug(`Error updating ${note.title}:`, error);
            failedNotes.push(`${note.folder}/${note.title}`);
            errors++;
          }

          persistedCount += 1;
          emitProgress(
            options,
            "persist",
            persistedCount,
            preparedNotes.length,
            `Persisted ${persistedCount}/${preparedNotes.length} note updates`
          );
        }
      }
    }
  }

  // Process deletions
  for (let deleteIdx = 0; deleteIdx < toDelete.length; deleteIdx++) {
    const key = toDelete[deleteIdx];
    throwIfCancelled(options.signal);
    try {
      // Parse folder and title from key (e.g., "Work/Projects/My Note")
      const lastSlash = key.lastIndexOf("/");
      const folder = key.substring(0, lastSlash);
      const title = key.substring(lastSlash + 1);
      await store.deleteByFolderAndTitle(folder, title);
    } catch (error) {
      debug(`Error deleting ${key}:`, error);
      failedNotes.push(`DELETE: ${key}`);
      errors++;
    }

    emitProgress(
      options,
      "delete",
      deleteIdx + 1,
      Math.max(toDelete.length, 1),
      `Deleted ${deleteIdx + 1}/${toDelete.length} stale records`
    );
  }

  // Rebuild FTS index if any changes were made
  if (toAdd.length > 0 || toUpdate.length > 0 || toDelete.length > 0) {
    debug("Rebuilding FTS index after incremental changes");
    emitProgress(options, "rebuild-fts", 0, 1, "Rebuilding FTS index");
    await store.rebuildFtsIndex();
    emitProgress(options, "rebuild-fts", 1, 1, "FTS index rebuilt");
  }

  const timeMs = Date.now() - startTime;
  debug(`Incremental index complete: ${timeMs}ms`);
  emitProgress(options, "done", 1, 1, "Incremental index completed");

  return {
    total: allNotesWithContent.length,
    indexed: toAdd.length + toUpdate.length,
    errors,
    timeMs,
    breakdown: {
      added: toAdd.length,
      updated: toUpdate.length,
      deleted: toDelete.length,
      skipped: toSkip.length,
    },
    failedNotes: failedNotes.length > 0 ? failedNotes : undefined,
    skippedNotes: skippedNotes.length > 0 ? skippedNotes : undefined,
  };
}

/**
 * Reindex a single note by title.
 */
export async function reindexNote(title: string): Promise<void> {
  debug(`Reindexing single note: ${title}`);

  const noteDetails = await getNoteByTitle(title);
  if (!noteDetails) {
    throw new NoteNotFoundError(title);
  }

  const prepared = prepareNoteForEmbedding(noteDetails);
  if (!prepared) {
    throw new Error(`Note is empty: "${title}"`);
  }

  const vector = await getEmbedding(prepared.truncatedContent);
  const record = buildNoteRecord(prepared, vector, new Date().toISOString());

  const store = getVectorStore();
  await store.update(record);

  // Rebuild FTS index after single note update
  debug("Rebuilding FTS index after single note reindex");
  await store.rebuildFtsIndex();

  debug(`Reindexed: ${title}`);
}

/**
 * Index notes based on mode.
 */
export async function indexNotes(
  mode: "full" | "incremental" = "incremental",
  options: IndexRunOptions = {}
): Promise<IndexResult> {
  if (mode === "full") {
    return fullIndex(options);
  }
  return incrementalIndex(options);
}
