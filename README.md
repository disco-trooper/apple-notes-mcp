# apple-notes-mcp

[![npm version](https://img.shields.io/npm/v/@disco_trooper/apple-notes-mcp)](https://www.npmjs.com/package/@disco_trooper/apple-notes-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![macOS](https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=white)](https://www.apple.com/macos/)
[![Bun](https://img.shields.io/badge/Bun-000000?logo=bun&logoColor=white)](https://bun.sh)
[![Claude](https://img.shields.io/badge/Claude-MCP-blueviolet)](https://modelcontextprotocol.io)

MCP server for Apple Notes with semantic search and CRUD operations. Claude searches, reads, creates, updates, and manages your Apple Notes through natural language.

## Features

- **Chunk-Based Search** - Long notes split into chunks for accurate matching (NEW!)
- **Query Caching** - 60x faster repeated searches (NEW!)
- **Knowledge Graph** - Tags, links, and related notes discovery (NEW!)
- **Hybrid Search** - Vector + keyword search with Reciprocal Rank Fusion
- **Semantic Search** - Find notes by meaning, not keywords
- **Full CRUD** - Create, read, update, delete, and move notes
- **Incremental Indexing** - Re-embed only changed notes
- **Dual Embedding** - Local HuggingFace or OpenRouter API

## What's New in 1.4

- **Smart Refresh** - Search auto-reindexes changed notes. No manual `index-notes` needed.
- **Batch Operations** - Delete or move multiple notes by title or folder.
- **Purge Index** - Clear all indexed data when switching models or fixing corruption.
- **Parent Document Retriever** - Splits long notes into 500-char chunks with 100-char overlap.
- **60x faster cached queries** - Query embedding cache eliminates redundant API calls.
- **4-6x faster indexing** - Parallel processing and batch embeddings.

## Installation

### npm (recommended)

```bash
npm install -g @disco_trooper/apple-notes-mcp
apple-notes-mcp
```

The setup wizard guides you through:
1. Choosing your embedding provider (local or OpenRouter)
2. Configuring API keys if needed
3. Setting up Claude Code integration
4. Indexing your notes

### From source

```bash
git clone https://github.com/disco-trooper/apple-notes-mcp.git
cd apple-notes-mcp
bun install
bun run start
```

## Requirements

- macOS (uses Apple Notes via JXA)
- [Bun](https://bun.sh) runtime
- Apple Notes app with notes

## Quick Start

Run the command after installation:

```bash
apple-notes-mcp
```

The setup wizard starts automatically on first run. Restart Claude Code after setup to use the MCP tools.

## Configuration

Configuration stored in `~/.apple-notes-mcp/.env`:

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENROUTER_API_KEY` | OpenRouter API key (enables cloud embeddings) | - |
| `EMBEDDING_MODEL` | Model name (local or OpenRouter) | `Xenova/multilingual-e5-small` |
| `EMBEDDING_DIMS` | Embedding dimensions | `4096` |
| `READONLY_MODE` | Block all write operations | `false` |
| `INDEX_TTL` | Auto-reindex interval in seconds | - |
| `DEBUG` | Enable debug logging | `false` |

To reconfigure:

```bash
apple-notes-mcp setup
# or from source:
bun run setup
```

### Embedding Providers

**Local (default)**: Uses HuggingFace Transformers with `Xenova/multilingual-e5-small`. Free, runs locally, ~200MB download.

**OpenRouter**: Uses cloud API. Fast, requires no local resources, needs API key from [openrouter.ai](https://openrouter.ai).

See [docs/models.md](docs/models.md) for model comparison.

## Tools

### Search & Discovery

#### `search-notes`
Hybrid vector + fulltext search.

```
query: "meeting notes from last week"
folder: "Work"           # optional, filter by folder
limit: 10                # default: 20
mode: "hybrid"           # hybrid, keyword, or semantic
include_content: false   # include full content vs preview
```

#### `list-notes`
Count indexed notes.

#### `list-folders`
List all Apple Notes folders.

#### `get-note`
Get note content by title.

```
title: "My Note"          # or "Work/My Note" for disambiguation
```

### Indexing

#### `index-notes`
Index notes for semantic search.

```
mode: "incremental"       # incremental (default) or full
force: false              # force reindex even if TTL hasn't expired
```

Use `mode: "full"` to create the chunk index for better long-note search. First full index takes longer as it generates chunks, but subsequent searches run fast.

#### `reindex-note`
Re-index a single note after manual edits.

```
title: "My Note"
```

### CRUD Operations

#### `create-note`
Create a note in Apple Notes.

```
title: "New Note"
content: "# Heading\n\nMarkdown content..."
folder: "Work"            # optional, defaults to Notes
```

#### `update-note`
Update an existing note.

```
title: "My Note"
content: "Updated markdown content..."
reindex: true             # re-embed after update (default: true)
```

#### `delete-note`
Delete a note (requires confirmation).

```
title: "My Note"
confirm: true             # must be true to delete
```

#### `move-note`
Move a note to another folder.

```
title: "My Note"
folder: "Archive"
```

#### `batch-delete`
Delete multiple notes at once.

```
titles: ["Note 1", "Note 2"]  # OR folder: "Old Project"
confirm: true                 # required for safety
```

#### `batch-move`
Move multiple notes to a target folder.

```
titles: ["Note 1", "Note 2"]  # OR sourceFolder: "Old"
targetFolder: "Archive"       # required
```

### Index Management

#### `purge-index`
Clear all indexed data. Use when switching embedding models or to fix corrupted index.

```
confirm: true   # required for safety
```

After purging, run `index-notes` to rebuild.

### Knowledge Graph

#### `list-tags`
List all tags with occurrence counts.

#### `search-by-tag`
Find notes with a specific tag.

```
tag: "project"
folder: "Work"    # optional
limit: 20         # default: 20
```

#### `related-notes`
Find notes related to a source note.

```
title: "My Note"
types: ["tag", "link", "similar"]  # default: all
limit: 10                          # default: 10
```

#### `export-graph`
Export knowledge graph for visualization.

```
format: "json"     # json or graphml
folder: "Work"     # optional filter
```

**Supported Formats:**
- `json` - For custom visualization (D3.js, web apps)
- `graphml` - For professional tools (Gephi, yEd, Cytoscape)

## Claude Code Setup

### Automatic (recommended)

The setup wizard automatically adds apple-notes-mcp to Claude Code. Run `apple-notes-mcp` after installation.

### Manual

Add to `~/.claude.json`:

For npm installation:
```json
{
  "mcpServers": {
    "apple-notes": {
      "command": "apple-notes-mcp",
      "args": [],
      "env": {}
    }
  }
}
```

For source installation:
```json
{
  "mcpServers": {
    "apple-notes": {
      "command": "bun",
      "args": ["run", "/path/to/apple-notes-mcp/src/index.ts"],
      "env": {}
    }
  }
}
```

## Usage Examples

After setup, use natural language with Claude:

- "Search my notes for project ideas"
- "Create a note called 'Meeting Notes' in the Work folder"
- "What's in my note about vacation plans?"
- "Move the 'Old Project' note to Archive"
- "Index my notes" (after adding notes in Apple Notes)

## Troubleshooting

### "Note not found"
Use full path format `Folder/Note Title` when multiple notes share the same name.

### Slow first search
Local embeddings download the model on first use (~200MB). Subsequent searches run fast.

### "READONLY_MODE is enabled"
Set `READONLY_MODE=false` in `.env` to enable write operations.

### Notes missing from search
Run `index-notes` to update the search index. Use `mode: full` if incremental misses changes.

### JXA errors
Ensure Apple Notes runs and contains notes. Grant automation permissions when prompted.

## Development

```bash
# Type check
bun run check

# Run tests
bun run test

# Run with coverage
bun run test:coverage

# Run with debug logging
DEBUG=true bun run start

# Watch mode
bun run dev
```

## Contributing

PRs welcome! Please:
- Run `bun run check` before submitting
- Add tests for new functionality
- Update documentation as needed

## License

MIT
