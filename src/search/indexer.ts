/**
 * Note indexing pipeline for semantic search.
 *
 * Supports:
 * - Full reindexing (drop all, reindex everything)
 * - Incremental indexing (only changed notes)
 * - Single note reindexing
 */

import { getEmbedding } from "../embeddings/index.js";
import { getVectorStore, type NoteRecord } from "../db/lancedb.js";
import { getAllNotes, getNoteByTitle, type NoteInfo } from "../notes/read.js";

// Debug logging
const DEBUG = process.env.DEBUG === "true";
function debug(...args: unknown[]) {
  if (DEBUG) {
    console.error("[INDEXER]", ...args);
  }
}

// Delay between API calls to avoid rate limiting
const EMBEDDING_DELAY_MS = 300;

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
 * Sleep for a specified duration.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Truncate content to avoid token limits in embedding models.
 */
function truncateContent(content: string, maxLength = 8000): string {
  if (content.length <= maxLength) {
    return content;
  }
  return content.slice(0, maxLength);
}

/**
 * Perform full reindexing of all notes.
 * Drops existing index and rebuilds from scratch.
 */
export async function fullIndex(): Promise<IndexResult> {
  const startTime = Date.now();
  debug("Starting full index...");

  // Get all notes from Apple Notes
  const notes = await getAllNotes();
  debug(`Found ${notes.length} notes in Apple Notes`);

  const records: NoteRecord[] = [];
  let errors = 0;
  const failedNotes: string[] = [];

  for (let i = 0; i < notes.length; i++) {
    const noteInfo = notes[i];
    const notePath = `${noteInfo.folder}/${noteInfo.title}`;
    debug(`Processing ${i + 1}/${notes.length}: ${noteInfo.title}`);

    try {
      // Get full note content
      const noteDetails = await getNoteByTitle(notePath);
      if (!noteDetails) {
        debug(`Could not fetch note: ${noteInfo.title}`);
        failedNotes.push(notePath);
        errors++;
        continue;
      }

      // Skip empty notes
      if (!noteDetails.content.trim()) {
        debug(`Skipping empty note: ${noteInfo.title}`);
        continue;
      }

      // Generate embedding
      const content = truncateContent(noteDetails.content);
      const vector = await getEmbedding(content);

      const record: NoteRecord = {
        title: noteDetails.title,
        content: noteDetails.content,
        vector,
        folder: noteDetails.folder,
        created: noteDetails.created,
        modified: noteDetails.modified,
        indexed_at: new Date().toISOString(),
      };

      records.push(record);

      // Delay to avoid rate limiting
      if (i < notes.length - 1) {
        await sleep(EMBEDDING_DELAY_MS);
      }
    } catch (error) {
      debug(`Error processing ${noteInfo.title}:`, error);
      failedNotes.push(notePath);
      errors++;
    }
  }

  // Store all records in vector database
  const store = getVectorStore();
  await store.index(records);

  const timeMs = Date.now() - startTime;
  debug(`Full index complete: ${records.length} indexed, ${errors} errors, ${timeMs}ms`);

  return {
    total: notes.length,
    indexed: records.length,
    errors,
    timeMs,
    failedNotes: failedNotes.length > 0 ? failedNotes : undefined,
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
  } catch {
    // No existing index, fall back to full index
    debug("No existing index found, performing full index");
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

  // Process additions and updates
  const toProcess = [...toAdd, ...toUpdate];
  for (let i = 0; i < toProcess.length; i++) {
    const noteInfo = toProcess[i];
    const notePath = `${noteInfo.folder}/${noteInfo.title}`;
    debug(`Processing ${i + 1}/${toProcess.length}: ${noteInfo.title}`);

    try {
      const noteDetails = await getNoteByTitle(notePath);
      if (!noteDetails) {
        failedNotes.push(notePath);
        errors++;
        continue;
      }

      if (!noteDetails.content.trim()) {
        continue;
      }

      const content = truncateContent(noteDetails.content);
      const vector = await getEmbedding(content);

      const record: NoteRecord = {
        title: noteDetails.title,
        content: noteDetails.content,
        vector,
        folder: noteDetails.folder,
        created: noteDetails.created,
        modified: noteDetails.modified,
        indexed_at: new Date().toISOString(),
      };

      await store.update(record);

      if (i < toProcess.length - 1) {
        await sleep(EMBEDDING_DELAY_MS);
      }
    } catch (error) {
      debug(`Error processing ${noteInfo.title}:`, error);
      failedNotes.push(notePath);
      errors++;
    }
  }

  // Process deletions
  for (const key of toDelete) {
    try {
      const [, title] = key.split("/");
      await store.delete(title);
    } catch (error) {
      debug(`Error deleting ${key}:`, error);
      failedNotes.push(`DELETE: ${key}`);
      errors++;
    }
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
    throw new Error(`Note not found: "${title}"`);
  }

  if (!noteDetails.content.trim()) {
    throw new Error(`Note is empty: "${title}"`);
  }

  const content = truncateContent(noteDetails.content);
  const vector = await getEmbedding(content);

  const record: NoteRecord = {
    title: noteDetails.title,
    content: noteDetails.content,
    vector,
    folder: noteDetails.folder,
    created: noteDetails.created,
    modified: noteDetails.modified,
    indexed_at: new Date().toISOString(),
  };

  const store = getVectorStore();
  await store.update(record);

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
