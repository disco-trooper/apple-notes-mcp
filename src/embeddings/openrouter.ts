/**
 * OpenRouter Embeddings Client
 *
 * Provides embedding generation via OpenRouter API with:
 * - Configurable model and dimensions via environment variables
 * - Retry logic with exponential backoff
 * - Rate limiting handling (429 status)
 * - Caching for repeated queries
 * - Input truncation
 * - Debug logging to stderr
 */

import { createHash } from "node:crypto";
import { DEFAULT_OPENROUTER_EMBEDDING_DIMS, DEFAULT_OPENROUTER_MODEL, EMBEDDING_CACHE_MAX_SIZE, MAX_RETRIES, OPENROUTER_TIMEOUT_MS, RATE_LIMIT_BACKOFF_BASE_MS } from "../config/constants.js";
import { createDebugLogger } from "../utils/debug.js";
import { truncateForEmbedding } from "../utils/text.js";

// Configuration from environment
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || DEFAULT_OPENROUTER_MODEL;
const EMBEDDING_DIMS = parseInt(process.env.EMBEDDING_DIMS || String(DEFAULT_OPENROUTER_EMBEDDING_DIMS), 10);

// Constants
const API_URL = "https://openrouter.ai/api/v1/embeddings";

// Debug logging
const debug = createDebugLogger("OPENROUTER");

/**
 * Simple LRU cache for embeddings.
 * Evicts oldest entries when max size is reached.
 */
class LRUCache<K, V> {
  private cache = new Map<K, V>();

  constructor(private maxSize: number) {}

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    this.cache.delete(key);
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, value);
  }

  get size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }
}

// Embedding cache to reduce API calls
// Key: SHA-256 hash of input text
// Value: embedding vector
const embeddingCache = new LRUCache<string, number[]>(EMBEDDING_CACHE_MAX_SIZE);

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff delay
 * @param attempt - Current attempt number (0-indexed)
 * @param baseMs - Base delay in milliseconds
 * @returns Delay in milliseconds
 */
function getBackoffDelay(attempt: number, baseMs: number = 1000): number {
  return Math.pow(2, attempt) * baseMs;
}

/**
 * Generate cache key from input text using SHA-256 hash.
 */
export function getCacheKey(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * OpenRouter API error with additional context
 */
class OpenRouterError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly responseBody?: string
  ) {
    super(message);
    this.name = "OpenRouterError";
  }
}

/** HTTP status codes that should not be retried */
const NON_RETRYABLE_STATUS_CODES = [400, 401, 403, 404];

/** Common headers for OpenRouter API requests */
const API_HEADERS = {
  "Content-Type": "application/json",
  "HTTP-Referer": "https://github.com/apple-notes-mcp",
  "X-Title": "Apple Notes MCP",
} as const;

/**
 * Check if an error should trigger a retry or fail immediately.
 * Returns true if the error is non-retryable.
 */
function isNonRetryableError(error: unknown): boolean {
  if (error instanceof OpenRouterError && error.statusCode) {
    return NON_RETRYABLE_STATUS_CODES.includes(error.statusCode);
  }
  return false;
}

/**
 * Get embedding vector for text using OpenRouter API
 *
 * Features:
 * - Caches results based on SHA-256 hash of input
 * - Retries up to 3 times with exponential backoff
 * - Handles rate limiting (429) with longer delays
 * - Truncates input to 8000 chars
 *
 * @param text - Input text to embed
 * @returns Promise resolving to embedding vector
 * @throws OpenRouterError if API call fails after all retries
 */
export async function getOpenRouterEmbedding(text: string): Promise<number[]> {
  // Validate API key
  if (!OPENROUTER_API_KEY) {
    throw new OpenRouterError(
      "OPENROUTER_API_KEY environment variable is not set"
    );
  }

  // Truncate input first - cache key must match actual embedded text
  const truncatedText = truncateForEmbedding(text);

  // Check cache using truncated text hash
  const cacheKey = getCacheKey(truncatedText);
  const cached = embeddingCache.get(cacheKey);
  if (cached) {
    debug(`Cache hit for key: "${cacheKey.substring(0, 16)}..."`);
    return cached;
  }

  debug(`Cache miss, fetching embedding for: "${cacheKey.substring(0, 16)}..."`);

  // Retry loop
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);

    try {
      debug(`Attempt ${attempt + 1}/${MAX_RETRIES}`);

      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          ...API_HEADERS,
        },
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          input: truncatedText,
          dimensions: EMBEDDING_DIMS,
        }),
        signal: controller.signal,
      });

      // Handle rate limiting
      if (response.status === 429) {
        clearTimeout(timeoutId); // Clear timeout before sleeping
        const waitTime = getBackoffDelay(attempt, RATE_LIMIT_BACKOFF_BASE_MS); // Longer base delay for rate limits
        debug(`Rate limited (429), waiting ${waitTime}ms before retry`);
        await sleep(waitTime);
        continue;
      }

      // Handle other errors
      if (!response.ok) {
        const errorBody = await response.text();
        throw new OpenRouterError(
          `OpenRouter API error: ${response.status} - ${errorBody}`,
          response.status,
          errorBody
        );
      }

      // Parse response
      const data = await response.json() as {
        data?: Array<{ embedding?: number[] }>;
      };

      // Validate response structure
      if (!data?.data?.[0]?.embedding) {
        throw new OpenRouterError(
          "Invalid API response: missing embedding data",
          response.status,
          JSON.stringify(data)
        );
      }

      const embedding = data.data[0].embedding;

      // Validate embedding dimensions
      if (embedding.length !== EMBEDDING_DIMS) {
        debug(
          `Warning: Expected ${EMBEDDING_DIMS} dimensions, got ${embedding.length}`
        );
      }

      // Cache the result
      embeddingCache.set(cacheKey, embedding);
      debug(`Successfully got embedding with ${embedding.length} dimensions`);

      return embedding;
    } catch (error) {
      // Handle timeout errors - treat as retryable
      if (error instanceof Error && error.name === "AbortError") {
        debug(`Request timed out after ${OPENROUTER_TIMEOUT_MS}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        lastError = new OpenRouterError(
          `Request timed out after ${OPENROUTER_TIMEOUT_MS}ms`,
          408
        );
      } else {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (isNonRetryableError(error)) {
          debug(`Non-retryable error, failing immediately`);
          throw error;
        }
      }

      // If not the last attempt, wait before retrying
      if (attempt < MAX_RETRIES - 1) {
        const waitTime = getBackoffDelay(attempt);
        debug(`Error: ${lastError.message}, retrying in ${waitTime}ms`);
        await sleep(waitTime);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // All retries exhausted
  throw new OpenRouterError(
    `Failed to get embedding after ${MAX_RETRIES} attempts: ${lastError?.message}`,
    undefined,
    undefined
  );
}

/**
 * Get the configured embedding dimensions
 *
 * @returns Number of dimensions for embeddings
 */
export function getOpenRouterDimensions(): number {
  return EMBEDDING_DIMS;
}

/**
 * Clear the embedding cache
 * Useful for testing or memory management
 */
export function clearEmbeddingCache(): void {
  const size = embeddingCache.size;
  embeddingCache.clear();
  debug(`Cleared embedding cache (${size} entries)`);
}

/**
 * Get current cache size
 * Useful for monitoring
 */
export function getEmbeddingCacheSize(): number {
  return embeddingCache.size;
}

/**
 * Batch size for embedding requests.
 * OpenRouter supports up to 2048 inputs per request, but 50-100 is optimal.
 */
const BATCH_SIZE = 50;

/**
 * Number of concurrent batch API calls.
 * Higher values increase throughput but may hit rate limits.
 */
const CONCURRENT_BATCHES = 3;

/**
 * Split an array into chunks of specified size.
 */
function chunk<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Process a single batch of texts and return embeddings.
 * Internal helper for concurrent batch processing.
 */
async function processSingleBatch(
  batchTexts: string[],
  batchIndices: number[],
  cacheKeys: string[],
  results: (number[] | null)[],
  batchNumber: number,
  totalBatches: number
): Promise<void> {
  debug(`Processing batch ${batchNumber}/${totalBatches} (${batchTexts.length} texts)`);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS * 2);

    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          ...API_HEADERS,
        },
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          input: batchTexts,
          dimensions: EMBEDDING_DIMS,
        }),
        signal: controller.signal,
      });

      if (response.status === 429) {
        clearTimeout(timeoutId);
        const waitTime = getBackoffDelay(attempt, RATE_LIMIT_BACKOFF_BASE_MS);
        debug(`Batch ${batchNumber}: Rate limited (429), waiting ${waitTime}ms`);
        await sleep(waitTime);
        continue;
      }

      if (!response.ok) {
        const errorBody = await response.text();
        throw new OpenRouterError(
          `OpenRouter API error: ${response.status} - ${errorBody}`,
          response.status,
          errorBody
        );
      }

      const data = await response.json() as {
        data?: Array<{ embedding?: number[]; index?: number }>;
      };

      if (!data?.data || data.data.length !== batchTexts.length) {
        throw new OpenRouterError(
          `Invalid API response: expected ${batchTexts.length} embeddings, got ${data?.data?.length ?? 0}`,
          response.status,
          JSON.stringify(data)
        );
      }

      // Store results and cache them
      for (let j = 0; j < data.data.length; j++) {
        const embedding = data.data[j].embedding;
        if (!embedding) {
          throw new OpenRouterError(
            `Missing embedding at index ${j}`,
            response.status,
            JSON.stringify(data)
          );
        }

        results[batchIndices[j]] = embedding;
        embeddingCache.set(cacheKeys[batchIndices[j]], embedding);
      }

      return; // Success

    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        lastError = new OpenRouterError(
          `Batch request timed out after ${OPENROUTER_TIMEOUT_MS * 2}ms`,
          408
        );
      } else {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (isNonRetryableError(error)) {
          throw error;
        }
      }

      if (attempt < MAX_RETRIES - 1) {
        const waitTime = getBackoffDelay(attempt);
        debug(`Batch ${batchNumber} error: ${lastError.message}, retrying in ${waitTime}ms`);
        await sleep(waitTime);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw new OpenRouterError(
    `Failed to get batch ${batchNumber} embeddings after ${MAX_RETRIES} attempts: ${lastError?.message}`
  );
}

/**
 * Get embedding vectors for multiple texts using concurrent batch API calls.
 * Much faster than calling getOpenRouterEmbedding individually.
 *
 * @param texts - Array of input texts to embed
 * @returns Promise resolving to array of embedding vectors
 * @throws OpenRouterError if API call fails
 */
export async function getOpenRouterEmbeddingBatch(texts: string[]): Promise<number[][]> {
  if (!OPENROUTER_API_KEY) {
    throw new OpenRouterError(
      "OPENROUTER_API_KEY environment variable is not set"
    );
  }

  if (texts.length === 0) {
    return [];
  }

  // Truncate all inputs and check cache
  const truncatedTexts = texts.map(t => truncateForEmbedding(t));
  const cacheKeys = truncatedTexts.map(t => getCacheKey(t));

  // Separate cached and uncached
  const results: (number[] | null)[] = new Array(texts.length).fill(null);
  const uncachedIndices: number[] = [];
  const uncachedTexts: string[] = [];

  for (let i = 0; i < truncatedTexts.length; i++) {
    const cached = embeddingCache.get(cacheKeys[i]);
    if (cached) {
      results[i] = cached;
    } else {
      uncachedIndices.push(i);
      uncachedTexts.push(truncatedTexts[i]);
    }
  }

  debug(`Batch: ${texts.length} total, ${uncachedIndices.length} uncached`);

  if (uncachedTexts.length === 0) {
    return results as number[][];
  }

  // Split into batches
  const textBatches = chunk(uncachedTexts, BATCH_SIZE);
  const indexBatches = chunk(uncachedIndices, BATCH_SIZE);
  const totalBatches = textBatches.length;

  debug(`Processing ${totalBatches} batches with ${CONCURRENT_BATCHES} concurrent requests`);

  // Process batches with concurrency limit
  const batchGroups = chunk(
    textBatches.map((texts, i) => ({ texts, indices: indexBatches[i], batchNumber: i + 1 })),
    CONCURRENT_BATCHES
  );

  for (const group of batchGroups) {
    await Promise.all(
      group.map(batch =>
        processSingleBatch(
          batch.texts,
          batch.indices,
          cacheKeys,
          results,
          batch.batchNumber,
          totalBatches
        )
      )
    );
  }

  return results as number[][];
}
