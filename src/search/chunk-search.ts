/**
 * Chunk-based search for Parent Document Retriever pattern.
 *
 * Searches individual chunks but returns results deduplicated by note,
 * showing the best-matching chunk for each note.
 *
 * Uses Reciprocal Rank Fusion (RRF) to merge results from:
 * - Vector search (semantic similarity)
 * - Full-text search (keyword matching)
 */

import { getEmbedding } from "../embeddings/index.js";
import { getEmbeddingCache } from "../embeddings/cache.js";
import { getChunkStore, type ChunkSearchResult as DBChunkSearchResult } from "../db/lancedb.js";
import {
  DEFAULT_SEARCH_LIMIT,
  HYBRID_SEARCH_MIN_FETCH,
  RRF_K,
} from "../config/constants.js";
import { createDebugLogger } from "../utils/debug.js";

// Debug logging
const debug = createDebugLogger("CHUNK_SEARCH");

/**
 * Options for chunk search operations.
 */
export interface ChunkSearchOptions {
  /** Filter by folder name */
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
  /** Relevance score (higher = more relevant) */
  score: number;
  /** Last modified date (ISO string) */
  modified: string;
}

/**
 * Calculate RRF score for a result at a given rank.
 * Formula: 1 / (k + rank)
 * where k is a constant (typically 60) and rank is 0-indexed.
 */
export function rrfScore(rank: number): number {
  return 1 / (RRF_K + rank);
}

/**
 * Filter results by folder if specified.
 * Case-insensitive folder matching.
 */
export function filterByFolder(
  chunks: ChunkSearchResult[],
  folder?: string
): ChunkSearchResult[] {
  if (!folder) {
    return chunks;
  }

  const normalizedFolder = folder.toLowerCase();
  return chunks.filter(
    (r) => r.folder.toLowerCase() === normalizedFolder
  );
}

/**
 * Deduplicate chunks by note_id, keeping only the best-scoring chunk for each note.
 * Returns results sorted by score in descending order.
 */
export function deduplicateByNote(
  chunks: ChunkSearchResult[]
): ChunkSearchResult[] {
  // Group by note_id, keeping the highest scoring chunk
  const bestByNote = new Map<string, ChunkSearchResult>();

  for (const chunk of chunks) {
    const existing = bestByNote.get(chunk.note_id);
    if (!existing || chunk.score > existing.score) {
      bestByNote.set(chunk.note_id, chunk);
    }
  }

  // Convert to array and sort by score descending
  return Array.from(bestByNote.values()).sort((a, b) => b.score - a.score);
}

/**
 * Convert DB chunk result to ChunkSearchResult format.
 */
function toChunkSearchResult(
  dbResult: DBChunkSearchResult
): ChunkSearchResult {
  return {
    note_id: dbResult.note_id,
    note_title: dbResult.note_title,
    folder: dbResult.folder,
    matchedChunk: dbResult.content,
    matchedChunkIndex: dbResult.chunk_index,
    score: dbResult.score,
    modified: dbResult.modified,
  };
}

/**
 * Get cached or compute embedding for query.
 */
async function getCachedQueryEmbedding(query: string): Promise<number[]> {
  const cache = getEmbeddingCache();
  return cache.getOrCompute(query, getEmbedding);
}

/**
 * Perform vector-only search on chunks.
 */
async function vectorSearch(
  query: string,
  limit: number
): Promise<ChunkSearchResult[]> {
  debug(`Vector search: "${query}" (limit: ${limit})`);

  const store = getChunkStore();
  const queryVector = await getCachedQueryEmbedding(query);

  const results = await store.searchChunks(queryVector, limit);
  return results.map(toChunkSearchResult);
}

/**
 * Perform full-text search only on chunks.
 */
async function keywordSearch(
  query: string,
  limit: number
): Promise<ChunkSearchResult[]> {
  debug(`FTS search: "${query}" (limit: ${limit})`);

  const store = getChunkStore();
  const results = await store.searchChunksFTS(query, limit);
  return results.map(toChunkSearchResult);
}

/**
 * Perform hybrid search combining vector and FTS results using RRF.
 */
async function hybridSearch(
  query: string,
  limit: number
): Promise<ChunkSearchResult[]> {
  debug(`Hybrid search: "${query}" (limit: ${limit})`);

  const store = getChunkStore();

  // Fetch more results for RRF merging
  const fetchLimit = Math.max(limit * 2, HYBRID_SEARCH_MIN_FETCH);

  // Run both searches in parallel (use cached embedding)
  const [queryVector, ftsResults] = await Promise.all([
    getCachedQueryEmbedding(query),
    store.searchChunksFTS(query, fetchLimit).catch(() => [] as DBChunkSearchResult[]),
  ]);

  const vectorResults = await store.searchChunks(queryVector, fetchLimit);

  debug(`Vector results: ${vectorResults.length}, FTS results: ${ftsResults.length}`);

  // Merge results using Reciprocal Rank Fusion
  // Use chunk_id as key since we want to combine scores for the same chunk
  const scoreMap = new Map<string, number>();
  const contentMap = new Map<string, DBChunkSearchResult>();

  // Process vector search results
  vectorResults.forEach((item, rank) => {
    const key = item.chunk_id;
    scoreMap.set(key, (scoreMap.get(key) || 0) + rrfScore(rank));
    contentMap.set(key, item);
  });

  // Process FTS results
  ftsResults.forEach((item, rank) => {
    const key = item.chunk_id;
    scoreMap.set(key, (scoreMap.get(key) || 0) + rrfScore(rank));
    if (!contentMap.has(key)) {
      contentMap.set(key, item);
    }
  });

  // Sort by combined RRF score and convert to ChunkSearchResult
  const merged = Array.from(scoreMap.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([key, score]) => {
      const dbResult = contentMap.get(key)!;
      return toChunkSearchResult({ ...dbResult, score });
    });

  return merged;
}

/**
 * Search notes using chunk-based approach.
 *
 * Searches individual chunks for better relevance, then deduplicates
 * by note to return one result per note with the best-matching chunk.
 *
 * @param query - Search query string
 * @param options - Search configuration options
 * @returns Array of search results sorted by relevance, one per note
 *
 * @example
 * ```typescript
 * // Basic hybrid search
 * const results = await searchChunks("project ideas");
 *
 * // Keyword-only search in specific folder
 * const results = await searchChunks("meeting", {
 *   mode: "keyword",
 *   folder: "Work",
 *   limit: 10,
 * });
 *
 * // Semantic search
 * const results = await searchChunks("concepts similar to machine learning", {
 *   mode: "semantic",
 * });
 * ```
 */
export async function searchChunks(
  query: string,
  options: ChunkSearchOptions = {}
): Promise<ChunkSearchResult[]> {
  const {
    folder,
    limit = DEFAULT_SEARCH_LIMIT,
    mode = "hybrid",
  } = options;

  if (!query || query.trim().length === 0) {
    debug("Empty query, returning empty results");
    return [];
  }

  const trimmedQuery = query.trim();

  debug(`searchChunks: "${trimmedQuery}" mode=${mode} folder=${folder || "all"} limit=${limit}`);

  // Fetch more results than needed because:
  // 1. Deduplication may reduce count
  // 2. Folder filtering may reduce count
  const fetchMultiplier = folder ? 3 : 2;
  const fetchLimit = Math.max(limit * fetchMultiplier, HYBRID_SEARCH_MIN_FETCH);

  let rawResults: ChunkSearchResult[];

  switch (mode) {
    case "keyword":
      rawResults = await keywordSearch(trimmedQuery, fetchLimit);
      break;

    case "semantic":
      rawResults = await vectorSearch(trimmedQuery, fetchLimit);
      break;

    case "hybrid":
    default:
      rawResults = await hybridSearch(trimmedQuery, fetchLimit);
      break;
  }

  // Apply folder filter
  const filtered = filterByFolder(rawResults, folder);

  // Deduplicate by note (keep best chunk per note)
  const deduplicated = deduplicateByNote(filtered);

  // Apply limit
  const results = deduplicated.slice(0, limit);

  debug(`Returning ${results.length} results (from ${rawResults.length} chunks)`);
  return results;
}
