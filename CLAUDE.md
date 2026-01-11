# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP server for Apple Notes with semantic search and CRUD operations. Claude searches, reads, creates, updates, and manages Apple Notes through natural language.

## Commands

```bash
bun run start      # Start MCP server
bun run setup      # Interactive setup wizard
bun run dev        # Watch mode
bun run check      # Type check
bun run test       # Run tests (uses vitest, NOT bun test)
bun run test:watch # Watch mode for tests
```

**Important**: Always use `bun run test` (vitest), never `bun test` (Bun's test runner is incompatible).

## Architecture

### Data Flow

```text
User Query → MCP Server → Search Module → Embeddings → LanceDB → Results
                ↓
           Apple Notes ← JXA (JavaScript for Automation)
```

### Entry Point

- `src/index.ts` - Main MCP server with stdio transport for Claude Code

### Core Modules

**Search Pipeline** (`src/search/`)

- `index.ts` - Legacy hybrid search using Reciprocal Rank Fusion (RRF)
- `indexer.ts` - Full and incremental indexing with `indexed_at` timestamp tracking
- `chunk-indexer.ts` - Chunk-based indexing for Parent Document Retriever pattern
- `chunk-search.ts` - Chunk search with note deduplication (keeps best chunk per note)

**Embedding Providers** (`src/embeddings/`)

- Auto-detection: checks `OPENROUTER_API_KEY` to choose provider
- `local.ts` - HuggingFace Transformers with `Xenova/multilingual-e5-small`
- `openrouter.ts` - Cloud API via OpenRouter

**Vector Store** (`src/db/lancedb.ts`)

- Singleton `LanceDBStore` with FTS index on content
- Storage path: `~/.apple-notes-mcp/data`
- Schema: `NoteRecord` with `vector`, `content`, `indexed_at` fields

**Apple Notes Access** (`src/notes/`)

- `read.ts` - JXA queries via `run-jxa`
- `resolve.ts` - Note title disambiguation logic
- `conversion.ts` - HTML→Markdown via Turndown
- `crud.ts` - Create, update, delete, move operations (respects `READONLY_MODE`)
- `tables.ts` - Table HTML parsing and cell editing

### Key Implementation Details

- **Title disambiguation**: Use `Folder/Note Title` or `id:xxx` format when multiple notes share the same title
- **Incremental indexing**: Compares `note.modified` with `record.indexed_at` to detect changes
- **RRF fusion**: Constant `RRF_K=60` for combining search rankings
- **Parent Document Retriever**: Long notes split into 500-char chunks with 100-char overlap for better semantic search
- **Chunk deduplication**: Search returns best-matching chunk per note, not multiple chunks from same note

## Environment Variables

| Variable             | Description                     | Default                        |
| -------------------- | ------------------------------- | ------------------------------ |
| `OPENROUTER_API_KEY` | Enables cloud embeddings        | -                              |
| `EMBEDDING_MODEL`    | Model name                      | `Xenova/multilingual-e5-small` |
| `EMBEDDING_DIMS`     | Embedding dimensions            | `4096`                         |
| `READONLY_MODE`      | Block all write operations      | `false`                        |
| `INDEX_TTL`          | Auto-reindex interval (seconds) | -                              |
| `DEBUG`              | Enable debug logging            | `false`                        |

## MCP Tools

### Read Tools

- `search-notes` - Hybrid/keyword/semantic search with folder filtering
- `get-note` - Full note content by title
- `list-notes` - List notes with sorting (created/modified/title) and filtering
- `list-folders` - All Apple Notes folders
- `index-notes` - Index for semantic search (incremental/full)
- `reindex-note` - Re-index single note

### Write Tools

- `create-note` - Create note with Markdown content
- `update-note` - Update with optional reindex
- `delete-note` - Delete with confirm flag
- `move-note` - Move to different folder
- `edit-table` - Edit table cells directly

## Git Commits

Claude must NOT be listed as a contributor in git commits. Do not use `Co-Authored-By` header with Claude.

Commits must have only the user as author.

## Releases

When releasing new versions:

1. Update `CHANGELOG.md` - document all changes (features, fixes, breaking changes)
2. Bump version in `package.json`
3. Commit: `chore: release vX.Y.Z`
4. Run `npm publish`
