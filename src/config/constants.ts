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

// Vector search
export const DEFAULT_VECTOR_SEARCH_LIMIT = 50;
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

// Indexing (EMBEDDING_DELAY_MS removed - not needed with batch processing)

// Search tuning
export const HYBRID_SEARCH_MIN_FETCH = 40;
export const FOLDER_FILTER_MULTIPLIER = 3;
export const PREVIEW_TRUNCATE_RATIO = 0.7;

// Knowledge Graph
export const DEFAULT_RELATED_NOTES_LIMIT = 10;
export const GRAPH_TAG_WEIGHT = 0.8;
export const GRAPH_LINK_WEIGHT = 1.0;
export const GRAPH_SIMILAR_WEIGHT = 0.5;

// Chunking settings
export const DEFAULT_CHUNK_SIZE = 500;
export const DEFAULT_CHUNK_OVERLAP = 100;

// Batch processing
export const DEFAULT_EMBEDDING_BATCH_SIZE = 50;

// Background indexing jobs
export const DEFAULT_INDEX_JOB_RETENTION_SECONDS = 3600;
export const MAX_INDEX_JOB_HISTORY = 100;

/**
 * Get embedding batch size from environment or use default.
 * Lower values reduce peak memory usage but increase processing time.
 */
export function getEmbeddingBatchSize(): number {
  const envValue = process.env.EMBEDDING_BATCH_SIZE;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_EMBEDDING_BATCH_SIZE;
}
