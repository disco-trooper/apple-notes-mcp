/**
 * Smart refresh: check for note changes before search.
 * Triggers incremental index if notes have been modified.
 * Also updates chunk index for changed notes.
 */

import { getAllNotes, getNoteByFolderAndTitle, type NoteInfo } from "../notes/read.js";
import {
  getVectorStore,
  getChunkStore,
  type IndexMetadataRecord,
} from "../db/lancedb.js";
import { incrementalIndex } from "./indexer.js";
import { updateChunksForNotes, hasChunkIndex } from "./chunk-indexer.js";
import { createDebugLogger } from "../utils/debug.js";
import { DEFAULT_SEARCH_REFRESH_TIMEOUT_MS } from "../config/constants.js";
import { shouldAutoRefreshByTtl } from "./refresh-policy.js";

const debug = createDebugLogger("REFRESH");
let refreshInFlight: Promise<boolean> | null = null;

interface LegacyIndexRecord {
  id?: string;
  title: string;
  folder: string;
  indexed_at: string;
}

/**
 * Detected changes in notes.
 */
interface DetectedChanges {
  hasChanges: boolean;
  added: NoteInfo[];
  modified: NoteInfo[];
  deleted: string[]; // note IDs
}

async function getIndexMetadata(): Promise<IndexMetadataRecord[]> {
  const store = getVectorStore() as {
    getIndexMetadata?: () => Promise<IndexMetadataRecord[]>;
    getAll?: () => Promise<LegacyIndexRecord[]>;
  };

  if (typeof store.getIndexMetadata === "function") {
    return store.getIndexMetadata();
  }

  if (typeof store.getAll === "function") {
    const legacyRecords = await store.getAll();
    return legacyRecords.map((record) => ({
      id: record.id ?? "",
      title: record.title,
      folder: record.folder,
      indexed_at: record.indexed_at,
    }));
  }

  throw new Error("Vector store does not expose index metadata methods");
}

function getLatestIndexedAtMs(records: IndexMetadataRecord[]): number | null {
  let latestMs: number | null = null;

  for (const record of records) {
    const indexedAtMs = Date.parse(record.indexed_at);
    if (Number.isNaN(indexedAtMs)) {
      continue;
    }
    if (latestMs === null || indexedAtMs > latestMs) {
      latestMs = indexedAtMs;
    }
  }

  return latestMs;
}

function getSearchRefreshTimeoutMs(): number {
  const raw = process.env.SEARCH_REFRESH_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_SEARCH_REFRESH_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SEARCH_REFRESH_TIMEOUT_MS;
  }

  return parsed;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<null>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(null), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function runRefresh(existingRecords: IndexMetadataRecord[]): Promise<boolean> {
  const changes = await detectChanges(existingRecords);

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

/**
 * Check for note changes and return details about what changed.
 */
export async function detectChanges(
  existingIndexMetadata?: IndexMetadataRecord[]
): Promise<DetectedChanges> {
  debug("Checking for changes...");

  const currentNotes = await getAllNotes();

  let existingRecords = existingIndexMetadata;
  if (!existingRecords) {
    try {
      existingRecords = await getIndexMetadata();
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
  try {
    const ttlRaw = process.env.INDEX_TTL;
    if (!ttlRaw) {
      debug("Auto-refresh disabled (INDEX_TTL not set)");
      return false;
    }

    const parsedTtlSeconds = Number.parseInt(ttlRaw, 10);
    if (!Number.isFinite(parsedTtlSeconds) || parsedTtlSeconds <= 0) {
      debug("Auto-refresh disabled (INDEX_TTL invalid)");
      return false;
    }

    const timeoutMs = getSearchRefreshTimeoutMs();
    if (refreshInFlight) {
      debug("Auto-refresh already in progress, waiting for existing run");
      const sharedResult = await withTimeout(refreshInFlight, timeoutMs);
      if (sharedResult === null) {
        debug(`Auto-refresh wait timed out after ${timeoutMs}ms; returning stale index results`);
        return false;
      }
      return sharedResult;
    }

    const refreshTask = (async () => {
      let existingRecords: IndexMetadataRecord[] = [];

      try {
        existingRecords = await getIndexMetadata();
      } catch {
        // No index yet - treat as empty metadata
        existingRecords = [];
      }

      const lastIndexedAtMs = getLatestIndexedAtMs(existingRecords);
      const shouldRefresh = shouldAutoRefreshByTtl(
        ttlRaw,
        Date.now(),
        lastIndexedAtMs
      );

      if (!shouldRefresh) {
        debug("Auto-refresh skipped by TTL policy");
        return false;
      }

      return runRefresh(existingRecords);
    })()
      .catch((error) => {
        debug("Auto-refresh failed; returning stale index results", error);
        return false;
      })
      .finally(() => {
        if (refreshInFlight === refreshTask) {
          refreshInFlight = null;
        }
      });

    refreshInFlight = refreshTask;

    const refreshed = await withTimeout(refreshTask, timeoutMs);
    if (refreshed === null) {
      debug(`Auto-refresh timed out after ${timeoutMs}ms; returning stale index results`);
      return false;
    }

    return refreshed;
  } catch (error) {
    debug("Unexpected auto-refresh failure; returning stale index results", error);
    return false;
  }
}
