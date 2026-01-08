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
