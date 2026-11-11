/**
 * Embedding provider auto-detection and unified interface.
 *
 * Selects the provider at call time:
 * - OpenRouter (if OPENROUTER_API_KEY is set)
 * - Local HuggingFace (fallback)
 */

import {
  getOpenRouterEmbedding,
  getOpenRouterDimensions,
  getOpenRouterEmbeddingBatch,
  getOpenRouterModelName,
} from "./openrouter.js";
import { getLocalEmbedding, getLocalDimensions, getLocalModelName, getLocalEmbeddingBatch } from "./local.js";
import { EMBEDDING_CACHE_MAX_SIZE } from "../config/constants.js";
import { LRUCache } from "../utils/lru.js";

/** Query embeddings keyed by provider description + role + normalized query */
const queryCache = new LRUCache<string, number[]>(EMBEDDING_CACHE_MAX_SIZE);

function useOpenRouter(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY?.trim());
}

/**
 * Embed a document/passage for indexing.
 */
export async function getEmbedding(text: string): Promise<number[]> {
  return useOpenRouter() ? getOpenRouterEmbedding(text) : getLocalEmbedding(text, "passage");
}

/**
 * Embed multiple documents/passages for indexing.
 */
export async function getEmbeddingBatch(texts: string[]): Promise<number[][]> {
  return useOpenRouter() ? getOpenRouterEmbeddingBatch(texts) : getLocalEmbeddingBatch(texts);
}

/**
 * Embed a search query (e5 models get the "query:" prefix). Cached per
 * provider/model; the query is trimmed and whitespace-collapsed (case kept,
 * since cased models embed "Apple" and "apple" differently).
 */
export async function getQueryEmbedding(text: string): Promise<number[]> {
  const normalized = text.trim().replace(/\s+/g, " ");
  const key = `${getProviderDescription()}\u0000query\u0000${normalized}`;
  const cached = queryCache.get(key);
  if (cached) {
    return cached;
  }

  const embedding = useOpenRouter()
    ? await getOpenRouterEmbedding(normalized)
    : await getLocalEmbedding(normalized, "query");
  queryCache.set(key, embedding);
  return embedding;
}

/**
 * Get the embedding dimensions for the current provider.
 */
export function getEmbeddingDimensions(): number {
  return useOpenRouter() ? getOpenRouterDimensions() : getLocalDimensions();
}

/**
 * Human-readable provider description including model and dimensions.
 * Stable for a given configuration, so it can identify the embedding space.
 */
export function getProviderDescription(): string {
  return useOpenRouter()
    ? `OpenRouter (${getOpenRouterModelName()}, ${getOpenRouterDimensions()} dims)`
    : `Local (${getLocalModelName()}, ${getLocalDimensions()} dims)`;
}
