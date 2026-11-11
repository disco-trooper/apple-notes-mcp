# Embedding Models

apple-notes-mcp embeds note chunks either locally (HuggingFace Transformers) or through the OpenRouter API. The provider is chosen by `OPENROUTER_API_KEY`: set means OpenRouter, unset means local.

## Defaults

| Provider | Default model | Dimensions |
|----------|---------------|------------|
| Local | `Xenova/multilingual-e5-small` | 384 |
| OpenRouter | `qwen/qwen3-embedding-8b` | 4096 (model's native size) |

Set `EMBEDDING_MODEL` to use another model with the active provider.

## Local models

Local models run on your machine and need no API key. The model is downloaded on first use (or by the setup wizard) and stays loaded in memory while the server runs.

Dimensions are known for these models:

| Model | Dimensions | Notes |
|-------|------------|-------|
| `Xenova/multilingual-e5-small` | 384 | Default. Multilingual. |
| `Xenova/bge-m3` | 1024 | Multilingual. Much larger download and memory use than the default. |
| `Xenova/all-MiniLM-L6-v2` | 384 | English. |
| `Xenova/bge-small-en-v1.5` | 384 | English. |
| `Xenova/gte-small` | 384 | English. |

Any other model is assumed to produce 384 dimensions. `EMBEDDING_DIMS` does not apply to local models.

e5 models (model name containing `e5`) are used with their trained prefixes: indexed text is embedded as `passage: ...` and search queries as `query: ...`. Other models get the text unchanged.

```env
EMBEDDING_MODEL="Xenova/bge-m3"
```

## OpenRouter models

Requires an API key from [openrouter.ai](https://openrouter.ai) and an internet connection. Pricing and rate limits are set by OpenRouter.

```env
OPENROUTER_API_KEY="sk-or-..."
# Optional:
EMBEDDING_MODEL="qwen/qwen3-embedding-8b"
EMBEDDING_DIMS="1024"
```

- `EMBEDDING_DIMS` is sent to the API as `dimensions` only when it is set. Use it for models that support reduced output sizes.
- Without `EMBEDDING_DIMS`, the server expects 4096 dimensions. When you use a different model, set `EMBEDDING_DIMS` to that model's output size; otherwise requests fail with a dimension mismatch error.
- Requests are retried on rate limits (honouring `Retry-After`) and transient errors.

## Changing models

Vectors from different models, or the same model with different dimensions, cannot be compared. The index records the model and dimensions it was built with; an incremental `index-notes` run fails with `Embedding model changed ...` when they differ.

After changing `EMBEDDING_MODEL`, `EMBEDDING_DIMS`, or the provider:

1. Run `purge-index`.
2. Run `index-notes` with `mode: "full"`.

## Search modes

`search-notes` supports three modes:

- `hybrid` (default) - vector and full-text results merged with Reciprocal Rank Fusion
- `semantic` - vector search only
- `keyword` - full-text search only; accents are folded and `"quoted phrases"` match as phrases, with no stemming
