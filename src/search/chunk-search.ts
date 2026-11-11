/**
 * Chunk-based search for the Parent Document Retriever pattern.
 *
 * Searches individual chunks but returns results deduplicated by note,
 * showing the best-matching chunk for each note.
 *
 * Hybrid mode merges vector and full-text results with Reciprocal Rank Fusion.
 */

import { getQueryEmbedding, getProviderDescription } from "../embeddings/index.js";
import { assertIndexCompatible, getChunkStore, type ChunkRow } from "../db/lancedb.js";
import { DEFAULT_SEARCH_LIMIT, HYBRID_SEARCH_MIN_FETCH, RRF_K } from "../config/constants.js";
import { createDebugLogger } from "../utils/debug.js";

const debug = createDebugLogger("CHUNK_SEARCH");

/**
 * Options for chunk search operations.
 */
export interface ChunkSearchOptions {
  /** Filter by folder name (case-insensitive exact match) */
  folder?: string;
  /** Maximum number of results (default: 20) */
  limit?: number;
  /** Search mode: hybrid, keyword, or semantic (default: hybrid) */
  mode?: "hybrid" | "keyword" | "semantic";
}

/**
 * Search result for chunk-based search.
 * Returns one result per note with the best-matching chunk.
 */
export interface ChunkSearchResult {
  /** Apple Notes unique identifier */
  note_id: string;
  /** Note title */
  note_title: string;
  /** Folder containing the note */
  folder: string;
  /** The best-matching chunk content */
  matchedChunk: string;
  /** Index of the matched chunk within the note */
  matchedChunkIndex: number;
  /** Rank-based relevance score (higher = more relevant) */
  score: number;
  /** Last modified date (ISO string) */
  modified: string;
}

/**
 * Keep the best-scoring chunk per note, sorted by score descending.
 */
export function deduplicateByNote(chunks: ChunkSearchResult[]): ChunkSearchResult[] {
  const bestByNote = new Map<string, ChunkSearchResult>();
  for (const chunk of chunks) {
    const existing = bestByNote.get(chunk.note_id);
    if (!existing || chunk.score > existing.score) {
      bestByNote.set(chunk.note_id, chunk);
    }
  }
  return Array.from(bestByNote.values()).sort((a, b) => b.score - a.score);
}

async function vectorSearch(query: string, limit: number): Promise<ChunkRow[]> {
  const queryVector = await getQueryEmbedding(query);
  await assertIndexCompatible(getProviderDescription(), queryVector.length);
  return getChunkStore().searchChunks(queryVector, limit);
}

/**
 * Merge two ranked lists with Reciprocal Rank Fusion: score = Σ 1 / (k + rank),
 * rank 0-indexed, keyed by chunk_id.
 */
function fuseByRank(vectorRows: ChunkRow[], ftsRows: ChunkRow[]): ChunkRow[] {
  const merged = new Map<string, ChunkRow>();
  for (const rows of [vectorRows, ftsRows]) {
    rows.forEach((row, rank) => {
      const contribution = 1 / (RRF_K + rank);
      const existing = merged.get(row.chunk_id);
      merged.set(row.chunk_id, {
        ...(existing ?? row),
        score: (existing?.score ?? 0) + contribution,
      });
    });
  }
  return Array.from(merged.values()).sort((a, b) => b.score - a.score);
}

/**
 * Search notes chunk by chunk and return one result per note.
 *
 * - keyword: full-text only; FTS errors propagate
 * - semantic: vector only
 * - hybrid: vector + full-text (RRF); an FTS failure degrades to vector-only
 */
export async function searchChunks(
  query: string,
  options: ChunkSearchOptions = {}
): Promise<ChunkSearchResult[]> {
  const { folder, limit = DEFAULT_SEARCH_LIMIT, mode = "hybrid" } = options;

  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0) {
    return [];
  }

  debug(`searchChunks: "${trimmedQuery}" mode=${mode} folder=${folder || "all"} limit=${limit}`);

  // Over-fetch: deduplication and the folder filter both shrink the list.
  const fetchLimit = Math.max(limit * (folder ? 3 : 2), HYBRID_SEARCH_MIN_FETCH);
  const store = getChunkStore();

  let rows: ChunkRow[];
  if (mode === "keyword") {
    rows = await store.searchChunksFTS(trimmedQuery, fetchLimit);
  } else if (mode === "semantic") {
    rows = await vectorSearch(trimmedQuery, fetchLimit);
  } else {
    // Each ranking feeds RRF on its own, so give both the full over-fetch budget
    // twice over: fusion, folder filtering and per-note dedupe all drop rows.
    const hybridFetchLimit = Math.max(fetchLimit * 2, HYBRID_SEARCH_MIN_FETCH);
    const [vectorRows, ftsRows] = await Promise.all([
      vectorSearch(trimmedQuery, hybridFetchLimit),
      store.searchChunksFTS(trimmedQuery, hybridFetchLimit).catch((error: unknown) => {
        debug("Full-text search failed; using vector results only:", error);
        return [];
      }),
    ]);
    debug(`Vector results: ${vectorRows.length}, FTS results: ${ftsRows.length}`);
    rows = fuseByRank(vectorRows, ftsRows);
  }

  const folderKey = folder ? folder.toLowerCase() : undefined;
  const matches: ChunkSearchResult[] = rows
    .filter((row) => folderKey === undefined || row.folder.toLowerCase() === folderKey)
    .map((row) => ({
      note_id: row.note_id,
      note_title: row.note_title,
      folder: row.folder,
      matchedChunk: row.content,
      matchedChunkIndex: row.chunk_index,
      score: row.score,
      modified: row.modified,
    }));

  const results = deduplicateByNote(matches).slice(0, limit);
  debug(`Returning ${results.length} results (from ${rows.length} chunks)`);
  return results;
}
