# Embedding Models

This guide covers embedding models for apple-notes-mcp.

## Quick Comparison

| Provider | Model | Dimensions | Quality | Speed | Memory | Cost |
|----------|-------|------------|---------|-------|--------|------|
| Local | Xenova/multilingual-e5-small | 384 | Good | Fast | ~200MB | Free |
| Local | Xenova/bge-m3 | 1024 | Excellent | Slow | ~2GB | Free |
| OpenRouter | qwen/qwen3-embedding-8b | 4096 | Excellent | Fast | - | ~$0.02/1M tokens |

## Local Models

Local models run entirely on your machine using HuggingFace Transformers. They require no API keys.

### Xenova/multilingual-e5-small (Default)

```bash
# This is the default, no configuration needed
```

**Pros:**
- Small model size (~200MB)
- Fast inference
- Strong multilingual support (100+ languages)
- Handles general note search well

**Cons:**
- Lower dimensional space (384)
- Misses subtle semantic differences

**Best for:** Most users, especially those with limited disk space or slower machines.

### Xenova/bge-m3

```env
EMBEDDING_MODEL="Xenova/bge-m3"
```

**Pros:**
- State-of-the-art quality
- 1024 dimensions capture fine-grained semantics
- Excellent multilingual support
- Highest retrieval accuracy

**Cons:**
- Large model (~2GB download)
- Slower inference
- Higher memory usage

**Best for:** Users who prioritize search quality and have resources to spare.

### Xenova/all-MiniLM-L6-v2

```env
EMBEDDING_MODEL="Xenova/all-MiniLM-L6-v2"
```

**Pros:**
- Very small and fast
- 384 dimensions
- Handles English content well

**Cons:**
- English-focused
- Less accurate than E5

**Best for:** English-only note collections where speed matters most.

## OpenRouter Models

OpenRouter provides cloud-based embeddings. You need an API key from [openrouter.ai](https://openrouter.ai).

### qwen/qwen3-embedding-8b (Default)

```env
OPENROUTER_API_KEY="sk-or-..."
# Optional:
EMBEDDING_MODEL="qwen/qwen3-embedding-8b"
EMBEDDING_DIMS="4096"
```

**Pros:**
- High-quality embeddings
- 4096 dimensions (highly expressive)
- Requires no local resources
- Fast API response

**Cons:**
- Requires internet connection
- Pay per use (~$0.02/1M tokens)
- API rate limits

**Best for:** Users who want top quality without managing local models.

### Other OpenRouter Options

OpenRouter supports many embedding models. Check their documentation for current options and set `EMBEDDING_MODEL` and `EMBEDDING_DIMS` accordingly.

## Choosing a Model

### Decision Tree

1. **Do you have reliable internet and accept small costs?**
   - Yes: Use OpenRouter with `qwen/qwen3-embedding-8b`
   - No: Continue to step 2

2. **Does your use case demand high search quality?**
   - Yes: Use `Xenova/bge-m3` (local, 2GB)
   - No: Continue to step 3

3. **Do you have notes in multiple languages?**
   - Yes: Use `Xenova/multilingual-e5-small` (default)
   - No: Use `Xenova/all-MiniLM-L6-v2` for speed

### Performance Trade-offs

| Scenario | Recommended Model |
|----------|-------------------|
| General use | multilingual-e5-small (default) |
| Best quality, local | bge-m3 |
| Best quality, cloud | qwen3-embedding-8b |
| Fastest, English only | all-MiniLM-L6-v2 |
| Limited disk space | multilingual-e5-small |
| Offline required | Any local model |

## Changing Models

When you change embedding models, you **must** reindex all notes:

```bash
# After updating .env with new model:
# Run index-notes with mode: "full"
```

Different models produce incompatible embedding vectors.

## Hybrid Search

apple-notes-mcp uses hybrid search (vector + keyword) by default, combining:

- **Vector search**: Finds semantically similar content through embeddings
- **Keyword search**: Finds exact matches through fulltext search

Reciprocal Rank Fusion (RRF) merges the results for optimal quality.

You can also use:
- `mode: "semantic"` - Vector search only
- `mode: "keyword"` - Keyword search only

## Memory Usage

| Model | Initial Load | Per-Search |
|-------|-------------|------------|
| e5-small | ~500MB | ~200MB |
| bge-m3 | ~3GB | ~2GB |
| OpenRouter | ~0 | ~0 |

Local models stay in memory after first load, enabling fast subsequent queries.
