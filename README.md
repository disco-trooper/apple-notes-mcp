# apple-notes-mcp

[![npm version](https://img.shields.io/npm/v/@disco_trooper/apple-notes-mcp)](https://www.npmjs.com/package/@disco_trooper/apple-notes-mcp)
[![npm downloads](https://img.shields.io/npm/dm/@disco_trooper/apple-notes-mcp)](https://www.npmjs.com/package/@disco_trooper/apple-notes-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![macOS](https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=white)](https://www.apple.com/macos/)
[![Bun](https://img.shields.io/badge/Bun-000000?logo=bun&logoColor=white)](https://bun.sh)
[![Claude](https://img.shields.io/badge/Claude-MCP-blueviolet)](https://modelcontextprotocol.io)

MCP server for Apple Notes with semantic search and CRUD operations. An MCP client such as Claude Code can search, read, create, update, and organise your Apple Notes.

- Hybrid search (vector + full-text, Reciprocal Rank Fusion) over chunked notes
- Incremental and background indexing
- Knowledge graph from `#tags` and `[[wiki links]]`
- Create, update, delete, move, batch operations, and table cell edits
- Local (HuggingFace Transformers) or OpenRouter embeddings
- Read-only mode

Release notes: [CHANGELOG.md](CHANGELOG.md). Some upgrades require running `index-notes` with `mode: "full"`; the changelog says when.

## Requirements

- macOS on Apple Silicon (LanceDB has no native build for Intel Macs)
- [Bun](https://bun.sh) >= 1.1.0. The executables run with Bun, so npm installs need Bun on `PATH` too.
- Apple Notes, with automation permission granted when macOS asks

## Installation

```bash
npm install -g @disco_trooper/apple-notes-mcp
apple-notes-mcp
```

The first run in a terminal starts the setup wizard: embedding provider, read-only mode, auto-indexing, Claude Code integration, and an initial index. Run `apple-notes-mcp-setup` later to change settings.

From source:

```bash
git clone https://github.com/disco-trooper/apple-notes-mcp.git
cd apple-notes-mcp
bun install
bun run setup
```

## Claude Code setup

The setup wizard adds the server to `~/.claude.json` (the existing file is backed up to `~/.claude.json.bak`). To add it by hand:

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

For a source checkout, use `"command": "bun"` and `"args": ["run", "/path/to/apple-notes-mcp/src/index.ts"]`. Run the setup wizard once first; the server needs `~/.apple-notes-mcp/.env`. Restart Claude Code after setup.

## Configuration

Settings live in `~/.apple-notes-mcp/.env`. Variables in the MCP client's `env` block take precedence. Invalid values stop the server at startup.

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENROUTER_API_KEY` | Use OpenRouter for embeddings (`sk-or-...`) | - |
| `EMBEDDING_MODEL` | Embedding model | local `Xenova/multilingual-e5-small`, OpenRouter `qwen/qwen3-embedding-8b` |
| `EMBEDDING_DIMS` | OpenRouter only; sent as `dimensions` only when set (4096 expected otherwise) | - |
| `READONLY_MODE` | Hide and block tools that write to Apple Notes (`true`/`false`/`1`/`0`) | `false` |
| `INDEX_TTL` | Seconds after which a search first runs an incremental index; unset or `0` disables | - |
| `SEARCH_REFRESH_TIMEOUT_MS` | Max wait for that refresh before searching the current index | `2000` |
| `INDEX_JOB_RETENTION_SECONDS` | How long finished index jobs stay queryable | `3600` |
| `EMBEDDING_BATCH_SIZE` | Texts per embedding batch | `50` |
| `NOTES_FETCH_BATCH_SIZE` | Notes per Apple Notes fetch batch | `100` |
| `JXA_TIMEOUT_MS` | Timeout for a single Apple Notes script | `120000` |
| `NOTES_TRASH_FOLDER` | Name of the "Recently Deleted" folder when Apple Notes uses a localized name the server does not recognise | - |
| `DEBUG` | Debug logging to stderr (`true`/`false`/`1`/`0`) | `false` |

See [docs/models.md](docs/models.md) for embedding models.

## Tools

Notes are addressed as `Title`, `Folder/Title`, `Account/Folder/Title`, or `id:xxx`. When several notes match, the tool returns an error listing `id:` values to use.

| Category | Tool | Purpose |
|----------|------|---------|
| Search | `search-notes` | Hybrid, keyword, or semantic search with optional folder filter |
| Read | `list-notes` | List notes sorted by date or title; without parameters, show index statistics |
| Read | `get-note` | Full note content as Markdown (optionally HTML) |
| Read | `get-tables` | Tables in a note as rows of cells |
| Read | `list-folders` | All folders |
| Index | `index-notes` | Incremental or full index run, optionally in the background |
| Index | `start-index-job` | Start a background index job |
| Index | `get-index-job` | Status and progress of a job |
| Index | `list-index-jobs` | Recent jobs |
| Index | `cancel-index-job` | Cancel a running job |
| Index | `reindex-note` | Re-index one note |
| Index | `purge-index` | Delete the local index (requires `confirm: true`) |
| Graph | `list-tags` | Tags with occurrence counts |
| Graph | `search-by-tag` | Notes with a tag |
| Graph | `related-notes` | Notes related by tags, links, or similarity |
| Graph | `export-graph` | Export the graph as JSON or GraphML |
| Write | `create-note` | Create a note from Markdown |
| Write | `update-note` | Replace a note's content |
| Write | `delete-note` | Delete a note (requires `confirm: true`) |
| Write | `move-note` | Move a note to another folder |
| Write | `edit-table` | Edit table cells without rewriting the note |
| Write | `batch-delete` | Delete several notes or a whole folder (requires `confirm: true`) |
| Write | `batch-move` | Move several notes or a whole folder |

Write tools are not registered when `READONLY_MODE` is on. After each write the index is updated for the affected notes; if that fails, the response includes an `index sync warning`. While an index run is in progress, the update is queued and the write returns right away.

For large libraries, run `index-notes` with `background: true` and follow the job with `get-index-job`. A foreground run sends progress notifications to clients that request them.

## Troubleshooting

- **JXA errors or timeouts**: make sure Apple Notes is running and the terminal or MCP client has automation permission (System Settings → Privacy & Security → Automation). For very large folders, lower `NOTES_FETCH_BATCH_SIZE` or raise `JXA_TIMEOUT_MS`.
- **"Embedding model changed"**: the index was built with another model or dimensions. Run `purge-index`, then `index-notes` with `mode: "full"`.
- **Skipped notes**: locked or still-syncing notes cannot be read. Unlock them or wait for iCloud sync, then reindex.
- **Slow first search**: the local model is downloaded and loaded on first use.
- **Write tools missing or "tool not found"**: `READONLY_MODE` is on. Set `READONLY_MODE=false` and restart the client.

## Development

```bash
bun run check          # type check
bun run test           # tests (vitest; do not use `bun test`)
bun run test:coverage  # tests with coverage
bun run dev            # watch mode
DEBUG=true bun run start
```

## License

MIT
