# CLAUDE.md

## Project Overview

MCP server for Apple Notes with semantic search and CRUD operations.

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript
- **Database**: LanceDB (vector store)
- **Embeddings**: HuggingFace Transformers (local) or OpenRouter API
- **Apple Notes**: JXA (JavaScript for Automation)

## Commands

```bash
bun run start      # Start MCP server
bun run setup      # Interactive setup wizard
bun run dev        # Watch mode
bun run check      # Type check
bun run test       # Run tests (uses vitest, NOT bun test)
```

## Project Structure

```
src/
├── index.ts          # MCP server entry (stdio transport)
├── server.ts         # Smithery-compatible export
├── setup.ts          # Interactive setup wizard
├── config/           # Constants and env validation
├── db/               # LanceDB vector store
├── embeddings/       # Local and OpenRouter embeddings
├── notes/            # Apple Notes CRUD via JXA
├── search/           # Hybrid search and indexing
└── utils/            # Debug logging, errors, text utils
```

## Key Patterns

- **Dual embedding support**: Detects `OPENROUTER_API_KEY` to choose provider
- **Hybrid search**: Combines vector + keyword search with RRF fusion
- **Incremental indexing**: Only re-embeds changed notes
- **Folder/title disambiguation**: Use `Folder/Note Title` format for duplicates

## Testing

Always use `bun run test` (vitest), never `bun test` (incompatible bun runner).

## Environment Variables

See README.md for full list. Key ones:
- `OPENROUTER_API_KEY` - Enables cloud embeddings
- `READONLY_MODE` - Blocks write operations
- `DEBUG` - Enables debug logging
