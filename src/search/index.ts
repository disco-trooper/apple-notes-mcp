/**
 * Hybrid search combining vector similarity and full-text search.
 *
 * Uses Reciprocal Rank Fusion (RRF) to merge results from:
 * - Vector search (semantic similarity)
 * - Full-text search (keyword matching)
 */

import { getEmbedding } from "../embeddings/index.js";
import { getVectorStore } from "../db/lancedb.js";
import type { DBSearchResult, SearchResult } from "../types/index.js";
import { DEFAULT_SEARCH_LIMIT, FOLDER_FILTER_MULTIPLIER, HYBRID_SEARCH_MIN_FETCH, PREVIEW_LENGTH, PREVIEW_TRUNCATE_RATIO, RRF_K } from "../config/constants.js";
import { createDebugLogger } from "../utils/debug.js";

// Debug logging
const debug = createDebugLogger("SEARCH");

/**
 * Search mode options.
 * - hybrid: Combine vector + FTS with RRF (default)
 * - keyword: Full-text search only
 * - semantic: Vector search only
 */
export type SearchMode = "hybrid" | "keyword" | "semantic";

/**
 * Options for search operations.
 */
export interface SearchOptions {
  /** Filter by folder name */
  folder?: string;
  /** Maximum number of results (default: 20) */
  limit?: number;
  /** Search mode: hybrid, keyword, or semantic (default: hybrid) */
  mode?: SearchMode;
  /** Include full content instead of preview (default: false) */
  include_content?: boolean;
}

/**
 * Calculate RRF score for a result at a given rank.
 * Formula: 1 / (k + rank)
 * where k is a constant (typically 60) and rank is 0-indexed.
 */
function rrfScore(rank: number): number {
  return 1 / (RRF_K + rank);
}

/**
 * Generate a preview of content (first N characters, default from PREVIEW_LENGTH constant).
 */
function generatePreview(content: string, maxLength = PREVIEW_LENGTH): string {
  if (!content) {
    return "";
  }

  // Clean up whitespace
  const cleaned = content.replace(/\s+/g, " ").trim();

  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  // Truncate at word boundary
  const truncated = cleaned.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(" ");

  if (lastSpace > maxLength * PREVIEW_TRUNCATE_RATIO) {
    return truncated.slice(0, lastSpace) + "...";
  }

  return truncated + "...";
}

/**
 * Filter results by folder if specified.
 */
function filterByFolder<T extends { folder: string }>(
  results: T[],
  folder?: string
): T[] {
  if (!folder) {
    return results;
  }

  const normalizedFolder = folder.toLowerCase();
  return results.filter(
    (r) => r.folder.toLowerCase() === normalizedFolder
  );
}

/**
 * Perform vector-only search.
 */
async function vectorSearch(
  query: string,
  limit: number,
  folder?: string
): Promise<DBSearchResult[]> {
  debug(`Vector search: "${query}" (limit: ${limit})`);

  const store = getVectorStore();
  const queryVector = await getEmbedding(query);

  // Fetch more results than needed if filtering by folder
  const fetchLimit = folder ? limit * FOLDER_FILTER_MULTIPLIER : limit;
  const results = await store.search(queryVector, fetchLimit);

  const filtered = filterByFolder(results, folder);
  return filtered.slice(0, limit);
}

/**
 * Perform full-text search only.
 */
async function keywordSearch(
  query: string,
  limit: number,
  folder?: string
): Promise<DBSearchResult[]> {
  debug(`FTS search: "${query}" (limit: ${limit})`);

  const store = getVectorStore();

  // Fetch more results than needed if filtering by folder
  const fetchLimit = folder ? limit * FOLDER_FILTER_MULTIPLIER : limit;
  const results = await store.searchFTS(query, fetchLimit);

  const filtered = filterByFolder(results, folder);
  return filtered.slice(0, limit);
}

/**
 * Perform hybrid search combining vector and FTS results using RRF.
 */
async function hybridSearch(
  query: string,
  limit: number,
  folder?: string
): Promise<DBSearchResult[]> {
  debug(`Hybrid search: "${query}" (limit: ${limit})`);

  const store = getVectorStore();

  // Fetch more results for RRF merging
  const fetchLimit = Math.max(limit * 2, HYBRID_SEARCH_MIN_FETCH);

  // Run both searches in parallel
  const [queryVector, ftsResults] = await Promise.all([
    getEmbedding(query),
    store.searchFTS(query, fetchLimit).catch(() => [] as DBSearchResult[]),
  ]);

  const vectorResults = await store.search(queryVector, fetchLimit);

  debug(`Vector results: ${vectorResults.length}, FTS results: ${ftsResults.length}`);

  // Merge results using Reciprocal Rank Fusion
  const scoreMap = new Map<string, number>();
  const contentMap = new Map<string, DBSearchResult>();

  // Process vector search results
  // Use id as key to avoid collisions with duplicate titles in different folders
  vectorResults.forEach((item, rank) => {
    const key = item.id ?? item.title;
    scoreMap.set(key, (scoreMap.get(key) || 0) + rrfScore(rank));
    contentMap.set(key, item);
  });

  // Process FTS results
  ftsResults.forEach((item, rank) => {
    const key = item.id ?? item.title;
    scoreMap.set(key, (scoreMap.get(key) || 0) + rrfScore(rank));
    if (!contentMap.has(key)) {
      contentMap.set(key, item);
    }
  });

  // Sort by combined RRF score
  const merged = Array.from(scoreMap.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([key, score]) => ({
      ...contentMap.get(key)!,
      score,
    }));

  // Apply folder filter and limit
  const filtered = filterByFolder(merged, folder);
  return filtered.slice(0, limit);
}

/**
 * Search notes with configurable search mode.
 *
 * @param query - Search query string
 * @param options - Search configuration options
 * @returns Array of search results sorted by relevance
 *
 * @example
 * ```typescript
 * // Basic hybrid search
 * const results = await searchNotes("project ideas");
 *
 * // Keyword-only search in specific folder
 * const results = await searchNotes("meeting", {
 *   mode: "keyword",
 *   folder: "Work",
 *   limit: 10,
 * });
 *
 * // Semantic search with full content
 * const results = await searchNotes("concepts similar to machine learning", {
 *   mode: "semantic",
 *   include_content: true,
 * });
 * ```
 */
export async function searchNotes(
  query: string,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const {
    folder,
    limit = DEFAULT_SEARCH_LIMIT,
    mode = "hybrid",
    include_content = false,
  } = options;

  if (!query || query.trim().length === 0) {
    debug("Empty query, returning empty results");
    return [];
  }

  const trimmedQuery = query.trim();

  debug(`searchNotes: "${trimmedQuery}" mode=${mode} folder=${folder || "all"} limit=${limit}`);

  let dbResults: DBSearchResult[];

  switch (mode) {
    case "keyword":
      dbResults = await keywordSearch(trimmedQuery, limit, folder);
      break;

    case "semantic":
      dbResults = await vectorSearch(trimmedQuery, limit, folder);
      break;

    case "hybrid":
    default:
      dbResults = await hybridSearch(trimmedQuery, limit, folder);
      break;
  }

  // Transform to SearchResult format
  const results: SearchResult[] = dbResults.map((r) => {
    const result: SearchResult = {
      id: r.id,
      title: r.title,
      folder: r.folder,
      preview: generatePreview(r.content),
      modified: r.modified,
      score: r.score,
    };

    if (include_content) {
      result.content = r.content;
    }

    return result;
  });

  debug(`Returning ${results.length} results`);
  return results;
}

// Re-export types for convenience
export type { SearchResult } from "../types/index.js";

// Export utility functions for testing
export { rrfScore, generatePreview, filterByFolder };
