/**
 * OpenRouter Embeddings Client
 *
 * - Configuration (OPENROUTER_API_KEY, EMBEDDING_MODEL, EMBEDDING_DIMS) is read
 *   at call time, so values loaded by dotenv after module import are honoured.
 * - One request function with retry: honours Retry-After on every retryable
 *   status (429, 5xx, 402 with Retry-After), fails fast on non-retryable
 *   statuses, never sleeps after the last attempt.
 * - Results are placed by the response `index` field and dimension-checked.
 * - Callers own batching; the batch function only splits oversized input.
 */

import {
  DEFAULT_OPENROUTER_EMBEDDING_DIMS,
  DEFAULT_OPENROUTER_MODEL,
  MAX_RETRIES,
  OPENROUTER_TIMEOUT_MS,
  RATE_LIMIT_BACKOFF_BASE_MS,
  getEmbeddingBatchSize,
} from "../config/constants.js";
import { createDebugLogger } from "../utils/debug.js";
import { truncateForEmbedding } from "../utils/text.js";

const API_URL = "https://openrouter.ai/api/v1/embeddings";

/** Base delay for exponential backoff on non-429 retryable failures */
const ERROR_BACKOFF_BASE_MS = 1000;

/** HTTP status codes that can never succeed on retry (402 is handled separately) */
const NON_RETRYABLE_STATUS_CODES = new Set([400, 401, 403, 404, 413, 422]);

/** Max characters of an error response body included in error messages */
const ERROR_BODY_PREVIEW_LENGTH = 200;

const API_HEADERS = {
  "Content-Type": "application/json",
  "HTTP-Referer": "https://github.com/apple-notes-mcp",
  "X-Title": "Apple Notes MCP",
} as const;

const debug = createDebugLogger("OPENROUTER");

/**
 * OpenRouter API error. `retryable` decides whether the request loop tries again.
 */
class OpenRouterError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly retryable = false
  ) {
    super(message);
    this.name = "OpenRouterError";
  }
}

function getApiKey(): string {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new OpenRouterError("OPENROUTER_API_KEY environment variable is not set");
  }
  return apiKey;
}

/**
 * Get the configured OpenRouter embedding model.
 */
export function getOpenRouterModelName(): string {
  return process.env.EMBEDDING_MODEL || DEFAULT_OPENROUTER_MODEL;
}

/**
 * EMBEDDING_DIMS when explicitly set to a positive integer, otherwise undefined.
 */
function getExplicitDimensions(): number | undefined {
  const raw = process.env.EMBEDDING_DIMS;
  if (!raw) return undefined;
  const parsed = parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Expected embedding dimensions: EMBEDDING_DIMS, or the default model's native size.
 */
export function getOpenRouterDimensions(): number {
  return getExplicitDimensions() ?? DEFAULT_OPENROUTER_EMBEDDING_DIMS;
}

/**
 * Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds.
 */
function parseRetryAfterMs(header: string | null): number {
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? 0 : Math.max(0, date - Date.now());
}

type EmbeddingResponse = {
  data?: Array<{ embedding?: unknown; index?: number }>;
};

/**
 * Validate a response and return embeddings in input order.
 */
function parseEmbeddings(data: EmbeddingResponse, inputCount: number): number[][] {
  const items = data?.data;
  if (!Array.isArray(items) || items.length !== inputCount) {
    throw new OpenRouterError(
      `Invalid API response: expected ${inputCount} embeddings, got ${Array.isArray(items) ? items.length : 0}`,
      undefined,
      true
    );
  }

  const expectedDims = getOpenRouterDimensions();
  const results: Array<number[] | undefined> = new Array(inputCount);

  items.forEach((item, position) => {
    const index = item.index ?? position;
    if (!Number.isInteger(index) || index < 0 || index >= inputCount || results[index]) {
      throw new OpenRouterError(`Invalid API response: bad or duplicate embedding index ${index}`, undefined, true);
    }
    if (!Array.isArray(item.embedding)) {
      throw new OpenRouterError(`Invalid API response: missing embedding at index ${index}`, undefined, true);
    }
    if (item.embedding.length !== expectedDims) {
      throw new OpenRouterError(
        `Embedding dimension mismatch: model "${getOpenRouterModelName()}" returned ${item.embedding.length} dimensions, expected ${expectedDims}. Set EMBEDDING_DIMS to match the model.`
      );
    }
    results[index] = item.embedding as number[];
  });

  return results as number[][];
}

/**
 * POST one embeddings request with retry. Returns embeddings in input order.
 */
async function postEmbeddings(input: string[]): Promise<number[][]> {
  const apiKey = getApiKey();
  const dimensions = getExplicitDimensions();
  const body = JSON.stringify({
    model: getOpenRouterModelName(),
    input,
    ...(dimensions !== undefined && { dimensions }),
  });
  const timeoutMs = input.length > 1 ? OPENROUTER_TIMEOUT_MS * 2 : OPENROUTER_TIMEOUT_MS;

  let lastError: OpenRouterError | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let retryDelayMs = Math.pow(2, attempt) * ERROR_BACKOFF_BASE_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      debug(`Request ${attempt + 1}/${MAX_RETRIES} (${input.length} inputs)`);
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, ...API_HEADERS },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        // Read headers before consuming the body
        const retryAfterHeader = response.headers.get("retry-after");
        const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
        const backoffBase = response.status === 429 ? RATE_LIMIT_BACKOFF_BASE_MS : ERROR_BACKOFF_BASE_MS;
        retryDelayMs = Math.max(retryAfterMs, Math.pow(2, attempt) * backoffBase);

        if (response.status === 429) {
          throw new OpenRouterError("Rate limited by OpenRouter (429)", 429, true);
        }

        // 402 (out of credits) is only worth retrying when the server says when
        const retryable =
          response.status === 402 ? retryAfterHeader !== null : !NON_RETRYABLE_STATUS_CODES.has(response.status);
        const errorBody = (await response.text()).slice(0, ERROR_BODY_PREVIEW_LENGTH);
        throw new OpenRouterError(
          `OpenRouter API error: ${response.status} - ${errorBody}`,
          response.status,
          retryable
        );
      }

      return parseEmbeddings((await response.json()) as EmbeddingResponse, input.length);
    } catch (error) {
      if (error instanceof OpenRouterError) {
        lastError = error;
      } else if (error instanceof Error && error.name === "AbortError") {
        lastError = new OpenRouterError(`Request timed out after ${timeoutMs}ms`, 408, true);
      } else {
        // Network failures (fetch TypeError, malformed JSON) are transient
        const message = error instanceof Error ? error.message : String(error);
        lastError = new OpenRouterError(`OpenRouter request failed: ${message}`, undefined, true);
      }

      if (!lastError.retryable) {
        throw lastError;
      }
      if (attempt < MAX_RETRIES - 1) {
        debug(`${lastError.message}; retrying in ${retryDelayMs}ms`);
        // Executor form: lib is ES2022, which has no Promise.withResolvers
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw new OpenRouterError(
    `OpenRouter embedding request failed after ${MAX_RETRIES} attempts: ${lastError?.message}`,
    lastError?.statusCode
  );
}

/**
 * Embed texts via OpenRouter. Input longer than EMBEDDING_BATCH_SIZE is sent as
 * sequential requests; callers normally pass one batch already.
 */
export async function getOpenRouterEmbeddingBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  const truncated = texts.map((t) => truncateForEmbedding(t));
  const batchSize = getEmbeddingBatchSize();
  const results: number[][] = [];
  for (let start = 0; start < truncated.length; start += batchSize) {
    results.push(...(await postEmbeddings(truncated.slice(start, start + batchSize))));
  }
  return results;
}

/**
 * Embed a single text via OpenRouter.
 */
export async function getOpenRouterEmbedding(text: string): Promise<number[]> {
  const [embedding] = await postEmbeddings([truncateForEmbedding(text)]);
  return embedding;
}
