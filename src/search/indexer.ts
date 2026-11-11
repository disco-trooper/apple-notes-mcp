/**
 * Index synchronisation for both LanceDB tables.
 *
 * - `notes`: one row per note (metadata, tags, outlinks, note-level vector)
 * - `chunks`: chunk rows used by search-notes
 *
 * indexNotes() is the single entry point that syncs both tables from one
 * fetch of the library. Rows are keyed by the Apple Notes id; a note is
 * rewritten when its `modified` or `folder` differs from the stored row.
 * Every write runs under the in-process index lock.
 *
 * Only chunks are embedded. A note's vector is the normalized mean of its
 * chunk vectors, and chunk vectors stored by the same model are reused for
 * identical chunk text instead of being embedded again (so a note that only
 * moved folders is rewritten without embedding).
 */

import { getEmbeddingBatch, getEmbeddingDimensions, getProviderDescription } from "../embeddings/index.js";
import {
  getVectorStore,
  getChunkStore,
  assertIndexCompatible,
  indexModelMatches,
  recordIndexModel,
  type NoteRecord,
  type ChunkRecord,
} from "../db/lancedb.js";
import {
  getAllNotesWithFallback,
  getNoteById,
  getNoteByTitle,
  type NoteDetails,
} from "../notes/read.js";
import { createDebugLogger } from "../utils/debug.js";
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

/** Date.now() of the last successful indexNotes run in this process. */
let lastIndexCompletedAtMs: number | null = null;

/**
 * When the last successful indexNotes run (any mode, also one that changed
 * nothing) finished; null before the first run in this process.
 */
export function getLastIndexCompletedAtMs(): number | null {
  return lastIndexCompletedAtMs;
}

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
  /** Chunk texts sent to the embedding provider */
  embedded?: number;
  /** Chunks whose stored vector was reused (identical text, same model) */
  reused?: number;
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

/** What a table stores about one note. */
interface StoredNote {
  id: string;
  title: string;
  folder: string;
  modified: string;
}

/**
 * Diff stored rows against the current notes. A note is rewritten when its
 * `modified` or `folder` changed. `existing === null` means the table is missing.
 * `keep` holds ids that must not be deleted (notes that failed to fetch).
 */
function planTable(
  existing: Map<string, StoredNote> | null,
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
    const stored = existing.get(note.id);
    if (!stored || stored.modified !== note.modified || stored.folder !== note.folder) {
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

/** A note ready to write: its prepared content and (non-empty) chunks. */
interface ChunkedNote {
  prepared: PreparedNote;
  chunks: UnembeddedChunk[];
}

/** Prepare and chunk a note; null when nothing indexable remains. */
function chunkForIndex(note: NoteDetails): ChunkedNote | null {
  const prepared = prepareNote(note);
  if (!prepared) return null;
  const chunks = chunkNote(prepared);
  return chunks.length > 0 ? { prepared, chunks } : null;
}

/** L2-normalized mean of equal-length vectors. */
function meanVector(vectors: number[][]): number[] {
  const mean = new Array<number>(vectors[0].length).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < mean.length; i++) mean[i] += vector[i];
  }
  const norm = Math.hypot(...mean);
  return norm === 0 ? mean : mean.map((v) => v / norm);
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

interface ChunkVectors {
  /** Vector per chunk content. */
  byContent: Map<string, number[]>;
  /** Distinct texts sent to the embedding provider. */
  embedded: number;
  /** Chunks whose stored vector was reused. */
  reused: number;
}

/**
 * Vectors for every chunk content: stored vectors are reused for identical
 * text when the index was built with the active model, the rest is embedded.
 * Chunk `content` is exactly the text that gets embedded (the provider adds
 * any role prefix), so it is a sound reuse key.
 */
async function resolveChunkVectors(
  chunks: UnembeddedChunk[],
  loadStored: () => Promise<Map<string, number[]>>,
  options: IndexRunOptions = {}
): Promise<ChunkVectors> {
  if (chunks.length === 0) {
    return { byContent: new Map(), embedded: 0, reused: 0 };
  }

  let stored = new Map<string, number[]>();
  if (await indexModelMatches(getProviderDescription(), getEmbeddingDimensions())) {
    stored = await loadStored().catch((error: unknown) => {
      debug("Stored chunk vectors unavailable, embedding everything:", error);
      return new Map<string, number[]>();
    });
  }

  const byContent = new Map<string, number[]>();
  const toEmbed = new Set<string>();
  let reused = 0;
  for (const { content } of chunks) {
    const vector = stored.get(content);
    if (vector) {
      byContent.set(content, vector);
      reused++;
    } else {
      toEmbed.add(content);
    }
  }

  const texts = [...toEmbed];
  const vectors = await embedAll(texts, options);
  texts.forEach((text, i) => byContent.set(text, vectors[i]));
  debug(`Chunk vectors: embedded ${texts.length}, reused ${reused} of ${chunks.length} chunks`);

  return { byContent, embedded: texts.length, reused };
}

/** Note row whose vector is the normalized mean of its chunk vectors. */
function noteRecordFor(note: ChunkedNote, byContent: Map<string, number[]>, indexedAt: string): NoteRecord {
  const vectors = note.chunks.map((c) => byContent.get(c.content) as number[]);
  return toNoteRecord(note.prepared, meanVector(vectors), indexedAt);
}

/** Chunk rows with their resolved vectors. */
function chunkRecordsFor(notes: ChunkedNote[], byContent: Map<string, number[]>, indexedAt: string): ChunkRecord[] {
  return notes.flatMap((n) =>
    n.chunks.map((c): ChunkRecord => ({ ...c, vector: byContent.get(c.content) as number[], indexed_at: indexedAt }))
  );
}

/** `${folder}/#${index}`: an unknown note of that folder could not be read. */
const INDEX_SKIP_LABEL = /^(.*)\/#\d+$/;

/**
 * Ids of indexed notes that could not be fetched this run (locked, syncing,
 * unreadable folder). Their rows are kept instead of being treated as deleted.
 *
 * Skip labels are `${folder}/${title}` (one note), `${folder}/#${index}`
 * (unknown note: keep the whole folder) or `${folder}` (whole folder unread).
 * Folder names may contain `/`, so a label is matched against each stored
 * row instead of being split.
 */
function idsOfSkippedNotes(stored: Iterable<StoredNote>, skipped: string[]): Set<string> {
  const keep = new Set<string>();
  if (skipped.length === 0) return keep;

  const labels = new Set(skipped);
  const keptFolders = new Set<string>();
  for (const label of skipped) {
    const match = INDEX_SKIP_LABEL.exec(label);
    if (match) keptFolders.add(match[1]);
  }

  for (const row of stored) {
    if (labels.has(row.folder) || keptFolders.has(row.folder) || labels.has(`${row.folder}/${row.title}`)) {
      keep.add(row.id);
    }
  }
  return keep;
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
  let noteStored: Map<string, StoredNote> | null = null;
  let chunkStored: Map<string, StoredNote> | null = null;
  if (mode === "incremental") {
    noteStored = await noteStore
      .getIndexMetadata()
      .then((rows) => new Map(rows.map((r): [string, StoredNote] => [r.id, r])))
      .catch((error: unknown) => {
        debug("Notes table unavailable, rebuilding it:", error);
        return null;
      });
    chunkStored = await chunkStore
      .getNoteMetadata()
      .then(
        (rows) =>
          new Map(
            rows.map((r): [string, StoredNote] => [
              r.note_id,
              { id: r.note_id, title: r.note_title, folder: r.folder, modified: r.modified },
            ])
          )
      )
      .catch((error: unknown) => {
        debug("Chunks table unavailable, rebuilding it:", error);
        return null;
      });
  }

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

  // Phase 2: diff each table, then prepare and chunk each note either table rewrites.
  // Skipped notes are matched against whichever table metadata exists.
  const keep = idsOfSkippedNotes(
    [...(noteStored?.values() ?? []), ...(chunkStored?.values() ?? [])],
    skipped
  );
  const notesPlan = planTable(noteStored, notes, keep);
  const chunksPlan = planTable(chunkStored, notes, keep);

  // Note vectors are derived from chunk vectors, so note rows need chunks too.
  const chunked = new Map<string, ChunkedNote | null>();
  for (const note of [...notesPlan.write, ...chunksPlan.write]) {
    if (!chunked.has(note.id)) chunked.set(note.id, chunkForIndex(note));
  }

  const noteWrites: ChunkedNote[] = [];
  for (const note of notesPlan.write) {
    const entry = chunked.get(note.id);
    if (entry) {
      noteWrites.push(entry);
    } else if (noteStored?.has(note.id)) {
      // Content became empty/unindexable: drop the old row.
      notesPlan.remove.push(note.id);
    }
  }
  const chunkWrites = chunksPlan.write
    .map((note) => chunked.get(note.id))
    .filter((entry): entry is ChunkedNote => entry != null);
  // Rewritten notes lose their old chunks even when they now produce none.
  const chunkRemove = chunksPlan.rebuild
    ? []
    : [
        ...chunksPlan.remove,
        ...chunksPlan.write.map((n) => n.id).filter((id) => chunkStored?.has(id)),
      ];
  const allChunks = [...chunked.values()].flatMap((entry) => entry?.chunks ?? []);

  debug(
    `Plan: notes ${notesPlan.rebuild ? "rebuild" : "update"} write=${noteWrites.length} remove=${notesPlan.remove.length}; ` +
      `chunks ${chunksPlan.rebuild ? "rebuild" : "update"} write=${chunkWrites.length} notes remove=${chunkRemove.length}; ` +
      `${allChunks.length} chunks need vectors`
  );
  emitProgress(options, "prepare", chunked.size, notes.length, "Prepared notes and chunks");

  // Phase 3: resolve every vector before touching either table. Full mode reads
  // the stored vectors here, before the overwrite; incremental mode only reads
  // the rows of the notes being rewritten.
  const { byContent, embedded, reused } = await resolveChunkVectors(
    allChunks,
    () =>
      mode === "full"
        ? chunkStore.getContentVectors()
        : chunkStore.getContentVectors([...chunked.keys()].filter((id) => chunkStored?.has(id))),
    options
  );
  throwIfCancelled(options.signal);

  const description = getProviderDescription();
  const dims = byContent.values().next().value?.length;
  if (mode === "incremental" && dims !== undefined) {
    await assertIndexCompatible(description, dims);
  }

  // Phase 4: write. Not cancellable once started, so both tables stay consistent.
  const indexedAt = new Date().toISOString();
  const noteRecords = noteWrites.map((entry) => noteRecordFor(entry, byContent, indexedAt));
  const chunkRecords = chunkRecordsFor(chunkWrites, byContent, indexedAt);

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

  lastIndexCompletedAtMs = Date.now();
  const timeMs = lastIndexCompletedAtMs - startTime;
  debug(
    `${mode} index complete: ${noteRecords.length} notes, ${chunkRecords.length} chunks ` +
      `(embedded ${embedded}, reused ${reused}), ${timeMs}ms`
  );
  emitProgress(options, "done", 1, 1, `${mode === "full" ? "Full" : "Incremental"} index completed`);

  const added = noteRecords.filter((r) => !noteStored?.has(r.id)).length;
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
    embedded,
    reused,
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

  const writes: ChunkedNote[] = [];
  const unindexableIds: string[] = [];
  for (const note of notes) {
    const entry = chunkForIndex(note);
    if (entry) {
      writes.push(entry);
    } else {
      unindexableIds.push(note.id);
    }
  }

  // Read stored vectors before the old chunks are deleted below.
  const { byContent } = await resolveChunkVectors(
    writes.flatMap((entry) => entry.chunks),
    async () =>
      hasChunks ? chunkStore.getContentVectors(writes.map((entry) => entry.prepared.note.id)) : new Map()
  );
  const dims = byContent.values().next().value?.length;
  if (dims !== undefined) {
    await assertIndexCompatible(getProviderDescription(), dims);
  }

  const indexedAt = new Date().toISOString();
  if (hasNotes) {
    await noteStore.upsert(writes.map((entry) => noteRecordFor(entry, byContent, indexedAt)));
    await noteStore.deleteByIds([...unindexableIds, ...removeIds]);
    await noteStore.rebuildFtsIndex();
  }
  if (hasChunks) {
    await chunkStore.deleteChunksByNoteIds([...notes.map((n) => n.id), ...removeIds]);
    await chunkStore.addChunks(chunkRecordsFor(writes, byContent, indexedAt));
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
