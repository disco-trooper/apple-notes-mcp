/**
 * Note indexing pipeline for semantic search.
 *
 * Supports:
 * - Full reindexing (drop all, reindex everything)
 * - Incremental indexing (only changed notes)
 * - Single note reindexing
 */

import { getEmbedding, getEmbeddingBatch } from "../embeddings/index.js";
import { getVectorStore, type NoteRecord } from "../db/lancedb.js";
import { getAllNotes, getAllNotesWithContent, getNoteByFolderAndTitle, getNoteByTitle, type NoteInfo } from "../notes/read.js";
import { createDebugLogger } from "../utils/debug.js";
import { truncateForEmbedding } from "../utils/text.js";
import { NoteNotFoundError } from "../errors/index.js";
import { extractMetadata } from "../graph/extract.js";

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
 * Perform full reindexing of all notes.
 * Drops existing index and rebuilds from scratch.
 * Uses single JXA call + batch embedding for maximum speed.
 */
export async function fullIndex(): Promise<IndexResult> {
  const startTime = Date.now();
  debug("Starting full index...");

  // Phase 1: Fetch all notes with content in single JXA call
  debug("Phase 1: Fetching all notes with content (single JXA call)...");
  const allNotes = await getAllNotesWithContent();
  debug(`Fetched ${allNotes.length} notes from Apple Notes`);

  // Filter empty notes and prepare for embedding
  const preparedNotes = allNotes
    .map(prepareNoteForEmbedding)
    .filter((note): note is PreparedNote => note !== null);

  debug(`Prepared ${preparedNotes.length} notes for embedding`);

  // Phase 2: Generate embeddings in batch (with concurrent API calls)
  debug("Phase 2: Generating embeddings in batch...");
  const textsToEmbed = preparedNotes.map(n => n.truncatedContent);

  let vectors: number[][];
  try {
    vectors = await getEmbeddingBatch(textsToEmbed);
  } catch (error) {
    debug("Batch embedding failed:", error);
    throw error;
  }

  debug(`Generated ${vectors.length} embeddings`);

  // Phase 3: Build records and store
  debug("Phase 3: Storing in database...");
  const indexedAt = new Date().toISOString();
  const records = preparedNotes.map((note, i) =>
    buildNoteRecord(note, vectors[i], indexedAt)
  );

  const store = getVectorStore();
  await store.index(records);

  const timeMs = Date.now() - startTime;
  const skipped = allNotes.length - preparedNotes.length;
  debug(`Full index complete: ${records.length} indexed, ${skipped} empty/skipped, ${timeMs}ms`);

  return {
    total: allNotes.length,
    indexed: records.length,
    errors: 0,
    timeMs,
  };
}

/**
 * Perform incremental indexing.
 * Only processes notes that have changed since last index.
 */
export async function incrementalIndex(): Promise<IndexResult> {
  const startTime = Date.now();
  debug("Starting incremental index...");

  const store = getVectorStore();

  // Get all notes from Apple Notes
  const currentNotes = await getAllNotes();
  debug(`Found ${currentNotes.length} notes in Apple Notes`);

  // Get existing indexed notes
  let existingRecords: NoteRecord[];
  try {
    existingRecords = await store.getAll();
  } catch (error) {
    // No existing index, fall back to full index
    debug("No existing index found, performing full index. Error:", error);
    return fullIndex();
  }

  // Build lookup maps
  const existingByTitle = new Map<string, NoteRecord>();
  for (const record of existingRecords) {
    const key = `${record.folder}/${record.title}`;
    existingByTitle.set(key, record);
  }

  const currentByTitle = new Map<string, NoteInfo>();
  for (const note of currentNotes) {
    const key = `${note.folder}/${note.title}`;
    currentByTitle.set(key, note);
  }

  // Determine what needs to be done
  const toAdd: NoteInfo[] = [];
  const toUpdate: NoteInfo[] = [];
  const toDelete: string[] = [];
  const toSkip: string[] = [];

  // Check current notes
  for (const note of currentNotes) {
    const key = `${note.folder}/${note.title}`;
    const existing = existingByTitle.get(key);

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
  for (const [key] of existingByTitle) {
    if (!currentByTitle.has(key)) {
      toDelete.push(key);
    }
  }

  debug(`Incremental: add=${toAdd.length}, update=${toUpdate.length}, delete=${toDelete.length}, skip=${toSkip.length}`);

  let errors = 0;
  const failedNotes: string[] = [];

  // Process additions and updates in batch
  const toProcess = [...toAdd, ...toUpdate];

  if (toProcess.length > 0) {
    // Phase 1: Fetch all note content
    debug(`Phase 1: Fetching ${toProcess.length} notes content...`);
    const preparedNotes: PreparedNote[] = [];

    for (const noteInfo of toProcess) {
      try {
        const noteDetails = await getNoteByFolderAndTitle(noteInfo.folder, noteInfo.title);
        if (!noteDetails) {
          failedNotes.push(`${noteInfo.folder}/${noteInfo.title}`);
          errors++;
          continue;
        }

        const prepared = prepareNoteForEmbedding(noteDetails);
        if (prepared) {
          preparedNotes.push(prepared);
        }
      } catch (error) {
        debug(`Error fetching ${noteInfo.title}:`, error);
        failedNotes.push(`${noteInfo.folder}/${noteInfo.title}`);
        errors++;
      }
    }

    if (preparedNotes.length > 0) {
      // Phase 2: Generate embeddings in batch
      debug(`Phase 2: Generating ${preparedNotes.length} embeddings in batch...`);
      const textsToEmbed = preparedNotes.map(n => n.truncatedContent);

      let vectors: number[][];
      try {
        vectors = await getEmbeddingBatch(textsToEmbed);
      } catch (error) {
        debug("Batch embedding failed:", error);
        throw error;
      }

      // Phase 3: Update database
      debug("Phase 3: Updating database...");
      const indexedAt = new Date().toISOString();

      for (let i = 0; i < preparedNotes.length; i++) {
        const note = preparedNotes[i];
        const record = buildNoteRecord(note, vectors[i], indexedAt);

        try {
          await store.update(record);
        } catch (error) {
          debug(`Error updating ${note.title}:`, error);
          failedNotes.push(`${note.folder}/${note.title}`);
          errors++;
        }
      }
    }
  }

  // Process deletions
  for (const key of toDelete) {
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
  }

  // Rebuild FTS index if any changes were made
  if (toAdd.length > 0 || toUpdate.length > 0 || toDelete.length > 0) {
    debug("Rebuilding FTS index after incremental changes");
    await store.rebuildFtsIndex();
  }

  const timeMs = Date.now() - startTime;
  debug(`Incremental index complete: ${timeMs}ms`);

  return {
    total: currentNotes.length,
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
  mode: "full" | "incremental" = "incremental"
): Promise<IndexResult> {
  if (mode === "full") {
    return fullIndex();
  }
  return incrementalIndex();
}
