/**
 * Local embedding generation using HuggingFace Transformers.js
 *
 * Lazy-loads the model on first use to minimize startup time.
 * Supports model override via EMBEDDING_MODEL env var.
 */

// Model configuration
const DEFAULT_MODEL = "Xenova/multilingual-e5-small";
const DEFAULT_DIMENSIONS = 384;

// Model dimensions lookup (common models)
const MODEL_DIMENSIONS: Record<string, number> = {
  "Xenova/multilingual-e5-small": 384,
  "Xenova/all-MiniLM-L6-v2": 384,
  "Xenova/bge-m3": 1024,
  "Xenova/bge-small-en-v1.5": 384,
  "Xenova/gte-small": 384,
};

// Debug logging to stderr (never pollute stdout/MCP protocol)
const DEBUG = process.env.DEBUG === "true";
function debug(...args: unknown[]) {
  if (DEBUG) {
    console.error("[EMBED]", ...args);
  }
}

// Lazy-loaded pipeline
type FeatureExtractionPipeline = (
  text: string,
  options?: { pooling?: string; normalize?: boolean }
) => Promise<{ tolist: () => number[][] }>;

let pipelineInstance: FeatureExtractionPipeline | null = null;
let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;
let resolvedModel: string | null = null;

/**
 * Get the configured model name.
 * Uses EMBEDDING_MODEL env var if set, otherwise defaults to multilingual-e5-small.
 */
function getModelName(): string {
  return process.env.EMBEDDING_MODEL || DEFAULT_MODEL;
}

/**
 * Lazy-load the HuggingFace transformers pipeline.
 * Only loads once, subsequent calls return the cached instance.
 */
async function getPipeline(): Promise<FeatureExtractionPipeline> {
  // Return cached instance if available
  if (pipelineInstance) {
    return pipelineInstance;
  }

  // If already loading, wait for that promise
  if (pipelinePromise) {
    return pipelinePromise;
  }

  // Start loading
  const modelName = getModelName();
  debug(`Loading embedding model: ${modelName}`);

  pipelinePromise = (async () => {
    try {
      // Dynamic import to support lazy loading
      const { pipeline } = await import("@huggingface/transformers");

      const startTime = Date.now();

      // Create feature extraction pipeline
      // @ts-expect-error - pipeline returns a union type, we know it's FeatureExtractionPipeline for "feature-extraction"
      const pipe: FeatureExtractionPipeline = await pipeline(
        "feature-extraction",
        modelName,
        {
          // Use quantized model for faster loading and inference
          dtype: "fp32",
        }
      );

      const loadTime = Date.now() - startTime;
      debug(`Model loaded in ${loadTime}ms`);

      pipelineInstance = pipe;
      resolvedModel = modelName;

      return pipe;
    } catch (error) {
      // Reset promise so next call retries
      pipelinePromise = null;

      const message = error instanceof Error ? error.message : String(error);
      debug(`Failed to load model: ${message}`);

      throw new Error(`Failed to load embedding model "${modelName}": ${message}`);
    }
  })();

  return pipelinePromise;
}

/**
 * Generate embedding for a text string.
 *
 * Uses mean pooling and L2 normalization for best results with e5/MiniLM models.
 *
 * @param text - The text to embed
 * @returns Promise resolving to embedding vector (number array)
 * @throws Error if model loading or inference fails
 */
export async function getLocalEmbedding(text: string): Promise<number[]> {
  if (!text || typeof text !== "string") {
    throw new Error("Text must be a non-empty string");
  }

  const pipe = await getPipeline();

  debug(`Generating embedding for ${text.length} chars`);
  const startTime = Date.now();

  try {
    // For e5 models, prepend "passage: " for document embedding
    // or "query: " for search queries - using passage for general text
    const modelName = getModelName();
    const isE5Model = modelName.toLowerCase().includes("e5");
    const inputText = isE5Model ? `passage: ${text}` : text;

    // Run inference with mean pooling and normalization
    const output = await pipe(inputText, {
      pooling: "mean",
      normalize: true,
    });

    // Extract the embedding vector
    const embedding = output.tolist()[0];

    const inferenceTime = Date.now() - startTime;
    debug(`Embedding generated in ${inferenceTime}ms (${embedding.length} dims)`);

    return embedding;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug(`Embedding generation failed: ${message}`);

    throw new Error(`Failed to generate embedding: ${message}`);
  }
}

/**
 * Get the dimensions of the embedding vector for the configured model.
 *
 * Returns the known dimensions for common models, or the default (384) for unknown models.
 * This is a synchronous function that doesn't require loading the model.
 */
export function getLocalDimensions(): number {
  const modelName = getModelName();

  // Check known models first
  if (MODEL_DIMENSIONS[modelName]) {
    return MODEL_DIMENSIONS[modelName];
  }

  // If we've already loaded the model and have embeddings, we could cache the actual dimension
  // For now, return default for unknown models
  debug(`Unknown model "${modelName}", using default dimensions: ${DEFAULT_DIMENSIONS}`);
  return DEFAULT_DIMENSIONS;
}

/**
 * Get the currently configured model name.
 * Useful for logging and diagnostics.
 */
export function getLocalModelName(): string {
  return getModelName();
}

/**
 * Check if the model has been loaded.
 * Useful for diagnostics without triggering a load.
 */
export function isModelLoaded(): boolean {
  return pipelineInstance !== null;
}

/**
 * Get the name of the actually loaded model.
 * Returns null if no model has been loaded yet.
 */
export function getLoadedModelName(): string | null {
  return resolvedModel;
}
