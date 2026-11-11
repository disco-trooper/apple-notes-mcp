/**
 * Application constants extracted from magic numbers throughout the codebase.
 * Centralizes configuration values for easy maintenance and documentation.
 */

// Search defaults
export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 100;
export const PREVIEW_LENGTH = 200;

// Embedding settings
export const DEFAULT_LOCAL_EMBEDDING_DIMS = 384;
export const DEFAULT_OPENROUTER_EMBEDDING_DIMS = 4096;
export const DEFAULT_OPENROUTER_MODEL = "qwen/qwen3-embedding-8b";

// Search ranking
export const RRF_K = 60; // Reciprocal Rank Fusion constant

// Timeouts and retries
export const OPENROUTER_TIMEOUT_MS = 30000;
export const DEFAULT_SEARCH_REFRESH_TIMEOUT_MS = 2000;

// Cache settings
export const EMBEDDING_CACHE_MAX_SIZE = 1000;

// Input processing
export const MAX_INPUT_LENGTH = 8000;
export const MAX_TITLE_LENGTH = 500;
export const ERROR_MESSAGE_MAX_LENGTH = 200;

// Retry and backoff
export const MAX_RETRIES = 3;
export const RATE_LIMIT_BACKOFF_BASE_MS = 2000;

// Search tuning
export const HYBRID_SEARCH_MIN_FETCH = 40;
export const PREVIEW_TRUNCATE_RATIO = 0.7;

// Knowledge Graph
export const DEFAULT_RELATED_NOTES_LIMIT = 10;
export const GRAPH_TAG_WEIGHT = 0.8;
export const GRAPH_LINK_WEIGHT = 1.0;
export const GRAPH_SIMILAR_WEIGHT = 0.5;
/** Tag groups up to this size get all-pairs edges in export-graph; larger ones a star. */
export const GRAPH_TAG_CLIQUE_MAX = 20;

// Chunking settings
export const DEFAULT_CHUNK_SIZE = 500;
export const DEFAULT_CHUNK_OVERLAP = 100;

// Batch processing
export const DEFAULT_EMBEDDING_BATCH_SIZE = 50;
export const DEFAULT_NOTES_FETCH_BATCH_SIZE = 100;
export const DEFAULT_JXA_TIMEOUT_MS = 120000;

// Background indexing jobs
export const DEFAULT_INDEX_JOB_RETENTION_SECONDS = 3600;
export const MAX_INDEX_JOB_HISTORY = 100;

/**
 * Read a positive integer from the environment; unset, empty or invalid values
 * fall back to the default (validateEnv reports invalid values at startup).
 */
function parsePositiveInt(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return parsed > 0 ? parsed : fallback;
}

/**
 * Embedding batch size (EMBEDDING_BATCH_SIZE).
 * Lower values reduce peak memory usage but increase processing time.
 */
export function getEmbeddingBatchSize(): number {
  return parsePositiveInt("EMBEDDING_BATCH_SIZE", DEFAULT_EMBEDDING_BATCH_SIZE);
}

/**
 * Notes fetch batch size (NOTES_FETCH_BATCH_SIZE).
 * Lower values reduce peak memory usage but increase processing time.
 */
export function getNotesFetchBatchSize(): number {
  return parsePositiveInt("NOTES_FETCH_BATCH_SIZE", DEFAULT_NOTES_FETCH_BATCH_SIZE);
}

/**
 * JXA execution timeout in milliseconds (JXA_TIMEOUT_MS).
 * Bounds how long a single Apple Notes JXA call may run before it is aborted.
 */
export function getJxaTimeoutMs(): number {
  return parsePositiveInt("JXA_TIMEOUT_MS", DEFAULT_JXA_TIMEOUT_MS);
}
