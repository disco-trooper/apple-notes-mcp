/**
 * Smart refresh: check for note changes before search.
 * Triggers incremental index if notes have been modified.
 * Also updates chunk index for changed notes.
 */

import { getAllNotes, getNoteByFolderAndTitle, type NoteInfo } from "../notes/read.js";
import { getVectorStore, getChunkStore } from "../db/lancedb.js";
import { incrementalIndex } from "./indexer.js";
import { updateChunksForNotes, hasChunkIndex } from "./chunk-indexer.js";
import { createDebugLogger } from "../utils/debug.js";

const debug = createDebugLogger("REFRESH");

/**
 * Detected changes in notes.
 */
interface DetectedChanges {
  hasChanges: boolean;
  added: NoteInfo[];
  modified: NoteInfo[];
  deleted: string[]; // note IDs
}

/**
 * Check for note changes and return details about what changed.
 */
export async function detectChanges(): Promise<DetectedChanges> {
  debug("Checking for changes...");

  const currentNotes = await getAllNotes();
  const store = getVectorStore();

  let existingRecords;
  try {
    existingRecords = await store.getAll();
  } catch {
    // No index exists yet
    debug("No existing index found");
    return {
      hasChanges: currentNotes.length > 0,
      added: currentNotes,
      modified: [],
      deleted: [],
    };
  }

  // Build lookup maps
  const existingByKey = new Map<string, { indexed_at: string; id: string }>();
  for (const record of existingRecords) {
    const key = `${record.folder}/${record.title}`;
    existingByKey.set(key, { indexed_at: record.indexed_at, id: record.id });
  }

  const added: NoteInfo[] = [];
  const modified: NoteInfo[] = [];
  const deleted: string[] = [];

  // Check for new or modified notes
  for (const note of currentNotes) {
    const key = `${note.folder}/${note.title}`;
    const existing = existingByKey.get(key);

    if (!existing) {
      debug(`New note detected: ${key}`);
      added.push(note);
    } else {
      const noteModified = new Date(note.modified).getTime();
      const recordIndexed = new Date(existing.indexed_at).getTime();

      if (noteModified > recordIndexed) {
        debug(`Modified note detected: ${key}`);
        modified.push(note);
      }
    }
  }

  // Check for deleted notes
  const currentKeys = new Set(currentNotes.map((n) => `${n.folder}/${n.title}`));
  for (const [key, { id }] of existingByKey) {
    if (!currentKeys.has(key)) {
      debug(`Deleted note detected: ${key}`);
      deleted.push(id);
    }
  }

  const hasChanges = added.length > 0 || modified.length > 0 || deleted.length > 0;
  debug(`Changes: ${added.length} added, ${modified.length} modified, ${deleted.length} deleted`);

  return { hasChanges, added, modified, deleted };
}

/**
 * Check if any notes have been modified since last index.
 * @returns true if changes detected, false otherwise
 */
export async function checkForChanges(): Promise<boolean> {
  const changes = await detectChanges();
  return changes.hasChanges;
}

/**
 * Refresh index if changes are detected.
 * Updates both main index AND chunk index.
 *
 * @returns true if index was refreshed, false if no changes
 */
export async function refreshIfNeeded(): Promise<boolean> {
  const changes = await detectChanges();

  if (!changes.hasChanges) {
    return false;
  }

  // Update main index
  debug("Changes detected, running incremental index...");
  const result = await incrementalIndex();
  debug(`Main index refresh: ${result.indexed} notes updated in ${result.timeMs}ms`);

  // Update chunk index if it exists and there are changes
  const hasChunks = await hasChunkIndex();
  if (hasChunks && (changes.added.length > 0 || changes.modified.length > 0)) {
    debug("Updating chunk index for changed notes...");

    // Fetch full content for changed notes
    const changedNotes = [...changes.added, ...changes.modified];
    const notesWithContent = await Promise.all(
      changedNotes.map(async (n) => {
        const note = await getNoteByFolderAndTitle(n.folder, n.title);
        return note;
      })
    );

    // Filter out nulls (notes that couldn't be fetched)
    const validNotes = notesWithContent.filter((n) => n !== null);

    if (validNotes.length > 0) {
      const chunksCreated = await updateChunksForNotes(validNotes);
      debug(`Chunk index refresh: ${chunksCreated} chunks for ${validNotes.length} notes`);
    }

    // Delete chunks for deleted notes
    if (changes.deleted.length > 0) {
      const chunkStore = getChunkStore();
      await chunkStore.deleteChunksByNoteIds(changes.deleted);
      debug(`Deleted chunks for ${changes.deleted.length} notes`);
    }
  }

  return true;
}
