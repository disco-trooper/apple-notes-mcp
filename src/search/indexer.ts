/**
 * Index synchronisation for both LanceDB tables.
 *
 * - `notes`: one row per note (metadata, tags, outlinks, note-level vector)
 * - `chunks`: chunk rows used by search-notes
 *
 * indexNotes() is the single entry point that syncs both tables from one
 * fetch of the library. Rows are keyed by the Apple Notes id; a note is
 * rewritten when its `modified` differs from the stored `modified`.
 * Every write runs under the in-process index lock.
 */

import { getEmbeddingBatch, getProviderDescription } from "../embeddings/index.js";
import {
  getVectorStore,
  getChunkStore,
  assertIndexCompatible,
  recordIndexModel,
  type NoteRecord,
  type ChunkRecord,
  type IndexMetadataRecord,
} from "../db/lancedb.js";
import {
  getAllNotesWithFallback,
  getNoteById,
  getNoteByTitle,
  type NoteDetails,
} from "../notes/read.js";
import { createDebugLogger } from "../utils/debug.js";
import { truncateForEmbedding } from "../utils/text.js";
import { NoteNotFoundError } from "../errors/index.js";
import { getEmbeddingBatchSize } from "../config/constants.js";
import {
  type IndexRunOptions,
  type IndexProgressEvent,
  throwIfCancelled,
} from "../indexing/contracts.js";
import { withIndexLock } from "../indexing/lock.js";
import { chunkNote, prepareNote, type PreparedNote, type UnembeddedChunk } from "./chunk-indexer.js";

const debug = createDebugLogger("INDEX");

/**
 * Result of an indexing operation.
 */
export interface IndexResult {
  /** Total notes seen (fetched + skipped during fetch) */
  total: number;
  /** Notes written to the notes table */
  indexed: number;
  /** Time taken in milliseconds */
  timeMs: number;
  /** Breakdown for incremental indexing (notes table) */
  breakdown?: {
    added: number;
    updated: number;
    deleted: number;
    skipped: number;
  };
  /** Notes skipped during fetch (locked, syncing, corrupted) */
  skippedNotes?: string[];
  /** Chunk rows written to the chunks table */
  chunks?: number;
}

/** Changes to apply to one table. */
interface TablePlan {
  /** Recreate the table from scratch (full mode, or table missing/empty). */
  rebuild: boolean;
  /** Notes whose rows must be (re)written. */
  write: NoteDetails[];
  /** Note ids whose rows must be removed. */
  remove: string[];
}

function emitProgress(
  options: IndexRunOptions,
  stage: IndexProgressEvent["stage"],
  current: number,
  total: number,
  message: string
): void {
  options.onProgress?.({ stage, current, total, message });
}

/**
 * Diff stored rows (id -> modified) against the current notes.
 * `existing === null` means the table is missing.
 * `keep` holds ids that must not be deleted (notes that failed to fetch).
 */
function planTable(
  existing: Map<string, string> | null,
  notes: NoteDetails[],
  keep: Set<string>
): TablePlan {
  if (existing === null || existing.size === 0) {
    return { rebuild: true, write: notes, remove: [] };
  }

  const current = new Set<string>();
  const write: NoteDetails[] = [];
  for (const note of notes) {
    current.add(note.id);
    if (existing.get(note.id) !== note.modified) {
      write.push(note);
    }
  }

  const remove = [...existing.keys()].filter((id) => !current.has(id) && !keep.has(id));
  return { rebuild: false, write, remove };
}

function toNoteRecord(prepared: PreparedNote, vector: number[], indexedAt: string): NoteRecord {
  const { note } = prepared;
  return {
    id: note.id,
    title: note.title,
    content: prepared.text,
    vector,
    folder: note.folder,
    created: note.created,
    modified: note.modified,
    indexed_at: indexedAt,
    tags: prepared.tags,
    outlinks: prepared.outlinks,
  };
}

/** Embed texts in provider-sized batches. */
async function embedAll(texts: string[], options: IndexRunOptions = {}): Promise<number[][]> {
  const batchSize = getEmbeddingBatchSize();
  const batchCount = Math.ceil(texts.length / batchSize);
  const vectors: number[][] = [];

  for (let batch = 0; batch < batchCount; batch++) {
    throwIfCancelled(options.signal);
    emitProgress(options, "embed", batch, batchCount, `Embedding batch ${batch + 1}/${batchCount}`);
    const start = batch * batchSize;
    vectors.push(...(await getEmbeddingBatch(texts.slice(start, start + batchSize))));
  }
  emitProgress(options, "embed", batchCount, batchCount, `Embedded ${texts.length} texts`);

  return vectors;
}

/**
 * Ids of indexed notes that could not be fetched this run (locked, syncing).
 * Their rows are kept instead of being treated as deleted.
 */
function idsOfSkippedNotes(metadata: IndexMetadataRecord[] | null, skipped: string[]): Set<string> {
  if (!metadata || skipped.length === 0) {
    return new Set();
  }
  const skippedKeys = new Set(skipped);
  return new Set(
    metadata.filter((r) => skippedKeys.has(`${r.folder}/${r.title}`)).map((r) => r.id)
  );
}

async function runIndex(
  mode: "full" | "incremental",
  options: IndexRunOptions
): Promise<IndexResult> {
  const startTime = Date.now();
  debug(`Starting ${mode} index...`);
  throwIfCancelled(options.signal);

  const noteStore = getVectorStore();
  const chunkStore = getChunkStore();

  // Stored state per table; null = table missing (rebuilt from scratch).
  let noteMetadata: IndexMetadataRecord[] | null = null;
  let chunkMetadata: Map<string, string> | null = null;
  if (mode === "incremental") {
    noteMetadata = await noteStore.getIndexMetadata().catch((error: unknown) => {
      debug("Notes table unavailable, rebuilding it:", error);
      return null;
    });
    chunkMetadata = await chunkStore
      .getNoteMetadata()
      .then((rows) => new Map(rows.map((r): [string, string] => [r.note_id, r.modified])))
      .catch((error: unknown) => {
        debug("Chunks table unavailable, rebuilding it:", error);
        return null;
      });
  }
  const noteModified = noteMetadata
    ? new Map(noteMetadata.map((r): [string, string] => [r.id, r.modified]))
    : null;

  // Phase 1: fetch the library once for both tables.
  emitProgress(options, "fetch", 0, 1, "Fetching notes");
  const { notes, skipped } = await getAllNotesWithFallback({
    signal: options.signal,
    onBatch: (fetched) =>
      emitProgress(options, "fetch", fetched, Math.max(fetched, 1), `Fetched ${fetched} notes...`),
  });
  debug(`Fetched ${notes.length} notes, ${skipped.length} skipped`);
  emitProgress(options, "fetch", 1, 1, `Fetched ${notes.length} notes`);
  throwIfCancelled(options.signal);

  // Phase 2: diff each table and prepare content (once per note).
  const keep = idsOfSkippedNotes(noteMetadata, skipped);
  const notesPlan = planTable(noteModified, notes, keep);
  const chunksPlan = planTable(chunkMetadata, notes, keep);

  const preparedById = new Map<string, PreparedNote | null>();
  const prepare = (note: NoteDetails): PreparedNote | null => {
    if (!preparedById.has(note.id)) {
      preparedById.set(note.id, prepareNote(note));
    }
    return preparedById.get(note.id) ?? null;
  };

  const notesToEmbed: PreparedNote[] = [];
  for (const note of notesPlan.write) {
    const prepared = prepare(note);
    if (prepared) {
      notesToEmbed.push(prepared);
    } else if (noteModified?.has(note.id)) {
      // Content became empty/unindexable: drop the old row.
      notesPlan.remove.push(note.id);
    }
  }

  const chunksToEmbed: UnembeddedChunk[] = [];
  for (const note of chunksPlan.write) {
    const prepared = prepare(note);
    if (prepared) {
      chunksToEmbed.push(...chunkNote(prepared));
    }
  }
  // Rewritten notes lose their old chunks even when they now produce none.
  const chunkRemove = chunksPlan.rebuild
    ? []
    : [
        ...chunksPlan.remove,
        ...chunksPlan.write.map((n) => n.id).filter((id) => chunkMetadata?.has(id)),
      ];

  debug(
    `Plan: notes ${notesPlan.rebuild ? "rebuild" : "update"} write=${notesToEmbed.length} remove=${notesPlan.remove.length}; ` +
      `chunks ${chunksPlan.rebuild ? "rebuild" : "update"} write=${chunksToEmbed.length} remove=${chunkRemove.length}`
  );
  emitProgress(
    options,
    "prepare",
    notesToEmbed.length + chunksToEmbed.length,
    notes.length,
    "Prepared notes and chunks"
  );

  // Phase 3: embed everything before touching either table.
  const vectors = await embedAll(
    [
      ...notesToEmbed.map((p) => truncateForEmbedding(p.text)),
      ...chunksToEmbed.map((c) => c.content),
    ],
    options
  );
  throwIfCancelled(options.signal);

  const description = getProviderDescription();
  const dims = vectors[0]?.length;
  if (mode === "incremental" && dims !== undefined) {
    await assertIndexCompatible(description, dims);
  }

  // Phase 4: write. Not cancellable once started, so both tables stay consistent.
  const indexedAt = new Date().toISOString();
  const noteRecords = notesToEmbed.map((p, i) => toNoteRecord(p, vectors[i], indexedAt));
  const chunkRecords: ChunkRecord[] = chunksToEmbed.map((c, i) => ({
    ...c,
    vector: vectors[notesToEmbed.length + i],
    indexed_at: indexedAt,
  }));

  emitProgress(options, "persist", 0, 2, "Writing notes table");
  if (notesPlan.rebuild) {
    if (noteRecords.length > 0) {
      await noteStore.index(noteRecords);
    } else if (mode === "full") {
      await noteStore.clear();
    }
  } else {
    await noteStore.upsert(noteRecords);
    await noteStore.deleteByIds(notesPlan.remove);
  }

  emitProgress(options, "persist", 1, 2, "Writing chunks table");
  if (chunksPlan.rebuild) {
    if (chunkRecords.length > 0) {
      await chunkStore.indexChunks(chunkRecords);
    } else if (mode === "full") {
      await chunkStore.clear();
    }
  } else {
    await chunkStore.deleteChunksByNoteIds(chunkRemove);
    await chunkStore.addChunks(chunkRecords);
  }
  emitProgress(options, "persist", 2, 2, "Tables written");

  // Overwrites build their own FTS index; incremental writes rebuild it once per table.
  const notesChanged = !notesPlan.rebuild && (noteRecords.length > 0 || notesPlan.remove.length > 0);
  const chunksChanged = !chunksPlan.rebuild && (chunkRecords.length > 0 || chunkRemove.length > 0);
  if (notesChanged || chunksChanged) {
    emitProgress(options, "rebuild-fts", 0, 1, "Rebuilding FTS index");
    if (notesChanged) await noteStore.rebuildFtsIndex();
    if (chunksChanged) await chunkStore.rebuildFtsIndex();
    emitProgress(options, "rebuild-fts", 1, 1, "FTS index rebuilt");
  }

  if (dims !== undefined) {
    await recordIndexModel(description, dims);
  }

  const timeMs = Date.now() - startTime;
  debug(`${mode} index complete: ${noteRecords.length} notes, ${chunkRecords.length} chunks, ${timeMs}ms`);
  emitProgress(options, "done", 1, 1, `${mode === "full" ? "Full" : "Incremental"} index completed`);

  const added = noteRecords.filter((r) => !noteModified?.has(r.id)).length;
  return {
    total: notes.length + skipped.length,
    indexed: noteRecords.length,
    timeMs,
    breakdown:
      mode === "incremental"
        ? {
            added,
            updated: noteRecords.length - added,
            deleted: notesPlan.remove.length,
            skipped: notes.length - noteRecords.length,
          }
        : undefined,
    skippedNotes: skipped.length > 0 ? skipped : undefined,
    chunks: chunkRecords.length,
  };
}

/**
 * Sync both index tables with Apple Notes.
 *
 * - full: rebuild both tables from scratch (recovery path; no model check)
 * - incremental: rewrite added/changed notes and remove deleted ones, per table
 */
export function indexNotes(
  mode: "full" | "incremental" = "incremental",
  options: IndexRunOptions = {}
): Promise<IndexResult> {
  return withIndexLock(() => runIndex(mode, options));
}

/**
 * Rewrite the rows of `notes` and remove `removeIds` in every existing table.
 * Caller holds the index lock. Returns false when no index exists yet.
 */
async function writeNotes(notes: NoteDetails[], removeIds: string[]): Promise<boolean> {
  const noteStore = getVectorStore();
  const chunkStore = getChunkStore();
  const [noteCount, chunkCount] = await Promise.all([noteStore.count(), chunkStore.count()]);
  const hasNotes = noteCount > 0;
  const hasChunks = chunkCount > 0;
  if (!hasNotes && !hasChunks) {
    debug("No index yet; skipping write sync");
    return false;
  }

  const indexable: PreparedNote[] = [];
  const unindexableIds: string[] = [];
  for (const note of notes) {
    const prepared = prepareNote(note);
    if (prepared) {
      indexable.push(prepared);
    } else {
      unindexableIds.push(note.id);
    }
  }

  const noteTexts = hasNotes ? indexable.map((p) => truncateForEmbedding(p.text)) : [];
  const chunks = hasChunks ? indexable.flatMap((p) => chunkNote(p)) : [];
  const vectors = await embedAll([...noteTexts, ...chunks.map((c) => c.content)]);
  if (vectors.length > 0) {
    await assertIndexCompatible(getProviderDescription(), vectors[0].length);
  }

  const indexedAt = new Date().toISOString();
  if (hasNotes) {
    await noteStore.upsert(noteTexts.map((_, i) => toNoteRecord(indexable[i], vectors[i], indexedAt)));
    await noteStore.deleteByIds([...unindexableIds, ...removeIds]);
    await noteStore.rebuildFtsIndex();
  }
  if (hasChunks) {
    await chunkStore.deleteChunksByNoteIds([...notes.map((n) => n.id), ...removeIds]);
    await chunkStore.addChunks(
      chunks.map((c, i): ChunkRecord => ({ ...c, vector: vectors[noteTexts.length + i], indexed_at: indexedAt }))
    );
    await chunkStore.rebuildFtsIndex();
  }
  return true;
}

/**
 * Re-fetch notes by id and rewrite them in both tables.
 * Ids that no longer exist in Apple Notes are removed from the index.
 *
 * @returns ids that were not found
 */
export async function syncNotesById(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const notes: NoteDetails[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const note = await getNoteById(id);
    if (note) {
      notes.push(note);
    } else {
      missing.push(id);
    }
  }
  await withIndexLock(() => writeNotes(notes, missing));
  return missing;
}

/** Remove notes from both tables by id. */
export async function removeNotesFromIndex(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await withIndexLock(() => writeNotes([], ids));
}

/**
 * Reindex a single note by title (or `Folder/Title`, `id:xxx`).
 * A note whose content became empty is removed from the index.
 */
export async function reindexNote(title: string): Promise<void> {
  debug(`Reindexing single note: ${title}`);

  const note = await getNoteByTitle(title);
  if (!note) {
    throw new NoteNotFoundError(title);
  }

  const updated = await withIndexLock(() => writeNotes([note], []));
  if (!updated) {
    throw new Error("Index not found. Run index-notes first.");
  }
  debug(`Reindexed: ${title}`);
}
