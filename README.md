# apple-notes-mcp

MCP server for Apple Notes with semantic search and CRUD operations. Claude searches, reads, creates, updates, and manages your Apple Notes through natural language.

## Features

- **Semantic Search** - Find notes by meaning, not keywords
- **Hybrid Search** - Combine vector and keyword search for better results
- **Full CRUD** - Create, read, update, delete, and move notes
- **Incremental Indexing** - Re-embed only changed notes
- **Dual Embedding Support** - Local HuggingFace or OpenRouter API
- **Claude Code Integration** - Works with Claude Code CLI

## Requirements

- macOS (uses Apple Notes via JXA)
- [Bun](https://bun.sh) runtime
- Apple Notes app with notes

## Installation

```bash
git clone https://github.com/disco-trooper/apple-notes-mcp.git
cd apple-notes-mcp
bun install
```

## Quick Start

Run the setup wizard:

```bash
bun run setup
```

The wizard:
1. Chooses your embedding provider (local or OpenRouter)
2. Configures API keys if needed
3. Sets auto-indexing preferences
4. Adds to Claude Code configuration
5. Indexes your notes

## Configuration

Store configuration in `.env`:

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENROUTER_API_KEY` | OpenRouter API key (enables cloud embeddings) | - |
| `EMBEDDING_MODEL` | Model name (local or OpenRouter) | `Xenova/multilingual-e5-small` |
| `EMBEDDING_DIMS` | Embedding dimensions | `4096` |
| `READONLY_MODE` | Block all write operations | `false` |
| `INDEX_TTL` | Auto-reindex interval in seconds | - |
| `DEBUG` | Enable debug logging | `false` |

### Embedding Providers

**Local (default)**: Uses HuggingFace Transformers with `Xenova/multilingual-e5-small`. Free, runs locally, ~200MB download.

**OpenRouter**: Uses cloud API. Fast, requires no local resources, needs API key from [openrouter.ai](https://openrouter.ai).

See [docs/models.md](docs/models.md) for model comparison.

## Tools

### Search & Discovery

#### `search-notes`
Search notes with hybrid vector + fulltext search.

```
query: "meeting notes from last week"
folder: "Work"           # optional, filter by folder
limit: 10                 # default: 20
mode: "hybrid"            # hybrid, keyword, or semantic
include_content: false    # include full content vs preview
```

#### `list-notes`
Count indexed notes.

#### `list-folders`
List all Apple Notes folders.

#### `get-note`
Get a note's full content by title.

```
title: "My Note"          # or "Work/My Note" for disambiguation
```

### Indexing

#### `index-notes`
Index all notes for semantic search.

```
mode: "incremental"       # incremental (default) or full
force: false              # force reindex even if TTL hasn't expired
```

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

## Claude Code Setup

### Automatic (via setup wizard)

Run `bun run setup` and select "Add to Claude Code configuration".

### Manual

Add to `~/.claude.json`:

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
