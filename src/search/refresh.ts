/**
 * Smart refresh: check for note changes before search.
 * Triggers incremental index if notes have been modified.
 */

import { getAllNotes } from "../notes/read.js";
import { getVectorStore } from "../db/lancedb.js";
import { incrementalIndex } from "./indexer.js";
import { createDebugLogger } from "../utils/debug.js";

const debug = createDebugLogger("REFRESH");

/**
 * Check if any notes have been modified since last index.
 * Compares note modification dates with indexed_at timestamps.
 *
 * @returns true if changes detected, false otherwise
 */
export async function checkForChanges(): Promise<boolean> {
  debug("Checking for changes...");

  const currentNotes = await getAllNotes();
  const store = getVectorStore();

  let existingRecords;
  try {
    existingRecords = await store.getAll();
  } catch {
    // No index exists yet
    debug("No existing index found");
    return currentNotes.length > 0;
  }

  // Build lookup map for existing records
  const existingByKey = new Map<string, string>();
  for (const record of existingRecords) {
    const key = `${record.folder}/${record.title}`;
    existingByKey.set(key, record.indexed_at);
  }

  // Check for new or modified notes
  for (const note of currentNotes) {
    const key = `${note.folder}/${note.title}`;
    const indexedAt = existingByKey.get(key);

    if (!indexedAt) {
      debug(`New note detected: ${key}`);
      return true;
    }

    const noteModified = new Date(note.modified).getTime();
    const recordIndexed = new Date(indexedAt).getTime();

    if (noteModified > recordIndexed) {
      debug(`Modified note detected: ${key}`);
      return true;
    }
  }

  // Check for deleted notes
  const currentKeys = new Set(currentNotes.map((n) => `${n.folder}/${n.title}`));
  for (const key of existingByKey.keys()) {
    if (!currentKeys.has(key)) {
      debug(`Deleted note detected: ${key}`);
      return true;
    }
  }

  debug("No changes detected");
  return false;
}

/**
 * Refresh index if changes are detected.
 * Call this before search operations for auto-sync.
 *
 * @returns true if index was refreshed, false if no changes
 */
export async function refreshIfNeeded(): Promise<boolean> {
  const hasChanges = await checkForChanges();

  if (!hasChanges) {
    return false;
  }

  debug("Changes detected, running incremental index...");
  const result = await incrementalIndex();
  debug(`Refresh complete: ${result.indexed} notes updated in ${result.timeMs}ms`);

  return true;
}
