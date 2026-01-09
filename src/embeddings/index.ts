/**
 * Embedding provider auto-detection and unified interface.
 *
 * Automatically selects between:
 * - OpenRouter (if OPENROUTER_API_KEY is set)
 * - Local HuggingFace (fallback)
 */

import { getOpenRouterEmbedding, getOpenRouterDimensions } from "./openrouter.js";
import { getLocalEmbedding, getLocalDimensions, getLocalModelName } from "./local.js";
import { createDebugLogger } from "../utils/debug.js";

// Debug logging
const debug = createDebugLogger("EMBED");

// Provider type
export type EmbeddingProvider = "openrouter" | "local";

// Detect which provider to use based on environment
let detectedProvider: EmbeddingProvider | null = null;

/**
 * Detect and cache the embedding provider.
 * Uses OpenRouter if API key is set, otherwise falls back to local.
 */
export function detectProvider(): EmbeddingProvider {
  if (detectedProvider) {
    return detectedProvider;
  }

  if (process.env.OPENROUTER_API_KEY) {
    detectedProvider = "openrouter";
    debug("Using OpenRouter embeddings (OPENROUTER_API_KEY found)");
  } else {
    detectedProvider = "local";
    debug(`Using local embeddings (${getLocalModelName()})`);
  }

  return detectedProvider;
}

/**
 * Get the current embedding provider.
 */
export function getProvider(): EmbeddingProvider {
  return detectedProvider ?? detectProvider();
}

/**
 * Generate embedding for text using the auto-detected provider.
 *
 * @param text - Text to embed
 * @returns Promise resolving to embedding vector
 */
export async function getEmbedding(text: string): Promise<number[]> {
  const provider = getProvider();

  if (provider === "openrouter") {
    return getOpenRouterEmbedding(text);
  } else {
    return getLocalEmbedding(text);
  }
}

/**
 * Get the embedding dimensions for the current provider.
 *
 * @returns Number of dimensions in embedding vectors
 */
export function getEmbeddingDimensions(): number {
  const provider = getProvider();

  if (provider === "openrouter") {
    return getOpenRouterDimensions();
  } else {
    return getLocalDimensions();
  }
}

/**
 * Get a human-readable description of the current provider.
 *
 * @returns Provider description string
 */
export function getProviderDescription(): string {
  const provider = getProvider();

  if (provider === "openrouter") {
    const model = process.env.EMBEDDING_MODEL || "qwen/qwen3-embedding-8b";
    const dims = getOpenRouterDimensions();
    return `OpenRouter (${model}, ${dims} dims)`;
  } else {
    const model = getLocalModelName();
    const dims = getLocalDimensions();
    return `Local (${model}, ${dims} dims)`;
  }
}

// Re-export individual providers for direct access if needed
export {
  getOpenRouterEmbedding,
  getOpenRouterDimensions,
} from "./openrouter.js";

export {
  getLocalEmbedding,
  getLocalDimensions,
  getLocalModelName,
  isModelLoaded,
} from "./local.js";
