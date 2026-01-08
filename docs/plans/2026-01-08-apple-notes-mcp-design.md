# apple-notes-mcp Design

**Date:** 2026-01-08
**Status:** Approved (post-interview)

## Overview

Unified MCP server for Apple Notes combining semantic search and CRUD operations. Replaces two separate MCPs (RafalWilinski/mcp-apple-notes + henilcalagiya/mcp-apple-notes) with a single, configurable solution.

## Goals

- Single MCP for all Apple Notes operations
- Auto-detect embedding provider (local vs cloud)
- Configurable models and safety settings
- Easy setup wizard for non-technical users
- Clean architecture for future extensibility

## Non-Goals

- Multiple vector database backends (v1 is LanceDB only, but abstracted interface)
- Remote/SSE transport (JXA requires local macOS)
- Real-time sync with Notes.app
- npm publish (v1 is GitHub-only distribution)

## Features

### Tools (9 total)

| Tool | Description | CRUD | Parameters |
|------|-------------|------|------------|
| `search-notes` | Hybrid vector + fulltext search | Read | `query`, `folder?`, `limit?` |
| `index-notes` | Index all notes for semantic search | Read | - |
| `list-notes` | Count indexed notes | Read | - |
| `get-note` | Get note by title | Read | `title` (supports folder prefix) |
| `create-note` | Create new note | Write | `title`, `content`, `folder?` |
| `update-note` | Update existing note | Write | `title`, `content` |
| `delete-note` | Delete note | Write | `title`, `confirm: true` (required) |
| `list-folders` | List all folders | Read | - |
| `move-note` | Move note to folder | Write | `title`, `folder` |

### Note Identification

Notes are identified by title. For duplicates, use folder prefix:
- `"My Note"` - works if unique across all folders
- `"Work/My Note"` - explicit folder for disambiguation
- If duplicate without prefix → error with suggested full paths

### Search Output

Returns preview (200 chars) + metadata:
```json
{
  "title": "Meeting Notes",
  "folder": "Work",
  "preview": "Discussion about Q1 goals...",
  "modified": "2026-01-08T10:30:00Z"
}
```
Use `get-note` for full content.

### Content Formatting

- Input: Markdown (AI-friendly)
- Storage: HTML (Apple Notes native)
- Conversion: `marked` for Markdown→HTML, `turndown` for HTML→Markdown

### Attachments

Attachments are extracted and noted in content:
```markdown
# My Note
Some text...
[Attachment: screenshot.png]
[Attachment: document.pdf]
```

### Embedding Providers

**Auto-detection logic:**
```
if (OPENROUTER_API_KEY) → OpenRouter
else → Local HuggingFace
```

**Local models:**
- Default: `Xenova/multilingual-e5-small` (384 dims) - good multilingual support
- Alternative: `Xenova/all-MiniLM-L6-v2` (384 dims) - faster, English-focused
- High-quality: `Xenova/bge-m3` (1024 dims) - best quality, larger

**OpenRouter models:**
- Default: `qwen/qwen3-embedding-8b` (4096 dims)
- Alternative: `openai/text-embedding-3-small` (1536 dims)

### Configuration

| Env Variable | Default | Description |
|--------------|---------|-------------|
| `OPENROUTER_API_KEY` | - | Enables cloud embeddings |
| `EMBEDDING_MODEL` | auto | Override embedding model |
| `EMBEDDING_DIMS` | auto | Override dimensions (OpenRouter) |
| `READONLY_MODE` | `false` | Disable write operations |
| `DEBUG` | `false` | Enable verbose logging to stderr |
| `AUTO_INDEX` | `none` | Auto-index mode: `none`, `on-search`, `ttl:1h` |

### Auto-Index Modes

| Mode | Description |
|------|-------------|
| `none` | Manual only - user calls `index-notes` |
| `on-search` | Check for changes before each search (slower, always fresh) |
| `ttl:Xh` | Re-index if older than X hours (e.g., `ttl:1h`, `ttl:24h`) |

When stale (ttl mode), `search-notes` returns warning:
```
"Note: Index is 3 hours old. Run index-notes for fresh results."
```

### Setup Wizard

Interactive CLI using `@clack/prompts`:

```bash
bun run setup

? Embedding provider:
  ● Local (multilingual-e5-small)
  ○ OpenRouter (cloud, requires API key)

? Enable read-only mode? (safer for AI assistants)
  ○ Yes
  ● No

? Auto-index mode:
  ● Manual only (call index-notes yourself)
  ○ Before each search (slower, always fresh)
  ○ TTL-based (re-index when stale)

? TTL duration: (if TTL selected)
  ○ 1 hour
  ● 24 hours
  ○ 7 days

? Enable debug logging?
  ○ Yes
  ● No

✓ Downloading multilingual-e5-small... (127 MB)
✓ Model ready
✓ Configuration saved to .env

? Add to Claude Code config (~/.claude.json)?
  ● Yes - add automatically
  ○ No - just show me the snippet

✓ Added to ~/.claude.json

? Index notes now? Yes
✓ Indexed 312 notes

Setup complete! Restart Claude Code to use apple-notes-mcp.
```

**Wizard saves:**
1. `.env` file in project directory (persistent config)
2. Claude config - either auto-add to `~/.claude.json` or show snippet (user choice)

## Architecture

### Directory Structure

```
apple-notes-mcp/
├── src/
│   ├── index.ts              # MCP server entry point
│   ├── setup.ts              # Setup wizard CLI
│   ├── embeddings/
│   │   ├── index.ts          # Provider auto-detection
│   │   ├── local.ts          # HuggingFace transformers
│   │   └── openrouter.ts     # OpenRouter API client
│   ├── notes/
│   │   ├── crud.ts           # Create, update, delete (JXA)
│   │   └── read.ts           # List, get, folders (JXA)
│   ├── search/
│   │   ├── index.ts          # Hybrid search (RRF)
│   │   └── indexer.ts        # Note indexing pipeline
│   └── db/
│       └── lancedb.ts        # LanceDB wrapper (VectorStore interface)
├── docs/
│   ├── models.md             # Embedding model comparison
│   └── plans/
├── package.json
├── tsconfig.json
├── README.md
└── LICENSE (MIT)
```

### VectorStore Interface (for future extensibility)

```typescript
interface VectorStore {
  index(chunks: Chunk[]): Promise<void>
  search(query: number[], limit: number): Promise<Result[]>
  searchFTS(query: string, limit: number): Promise<Result[]>
  count(): Promise<number>
  clear(): Promise<void>
}

// v1: LanceDB implementation only
// v2+: potential Chroma, SQLite-vss implementations
```

### Data Flow

**Indexing pipeline:**
```
Apple Notes (JXA) → HTML → Extract attachments → Turndown (Markdown) → Embedding → LanceDB
```

**Search pipeline:**
```
Query → Embedding → Vector Search ─┐
                                   ├→ RRF Merge → Top 20 results (preview)
Query → FTS Search ────────────────┘
```

**CRUD operations:**
```
MCP Tool → READONLY check → Validation → marked (MD→HTML) → JXA → Apple Notes.app
```

### Storage

- **Vector DB:** LanceDB (embedded, local)
- **Data location:** `~/.apple-notes-mcp/data/`
- **Schema:** `{ title, content, vector, folder, created, modified }`

### Logging

- Errors/warnings: always to stderr
- Verbose logs: only when `DEBUG=true`
- MCP protocol (stdout) never polluted

## Behavior Decisions

### Create Conflict
If note with same title exists → **Error** (explicit, safe)

### Delete Safety
Requires `confirm: true` parameter → protects against AI hallucinations

### Index Updates
Three modes available (configured via `AUTO_INDEX`):
- `none` (default): Manual `index-notes` calls only
- `on-search`: Auto-check before each search (fresh but slower)
- `ttl:Xh`: Re-index when older than X hours, warn when stale

### Progress Reporting
- `index-notes` blocks until complete
- Returns final summary with timing
- v2: potential incremental indexing

## Error Handling

| Error | Handling |
|-------|----------|
| Embedding API failure | Retry with exponential backoff (3 attempts) |
| Rate limiting (429) | Wait and retry with longer delay |
| JXA failure | Return clear error message |
| Note not found | Return `null` or error with suggestions |
| Duplicate title (no prefix) | Error with list of matching full paths |
| READONLY_MODE violation | `"Operation disabled in read-only mode"` |
| Delete without confirm | `"Add confirm: true to delete"` |
| Create duplicate | `"Note already exists: {title}"` |

## Dependencies

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@lancedb/lancedb": "^0.5.0",
    "@huggingface/transformers": "^3.0.0",
    "turndown": "^7.1.0",
    "marked": "^12.0.0",
    "run-jxa": "^3.0.0",
    "zod": "^3.22.0",
    "@clack/prompts": "^0.7.0",
    "dotenv": "^16.0.0"
  }
}
```

## README Structure

1. Project description & features
2. Installation (git clone + bun install)
3. Quick start (bun run setup)
4. Configuration reference (env vars table)
5. Tool reference (all 9 tools with examples)
6. Claude Code setup guide
7. Troubleshooting
8. Contributing: "PRs welcome" + basic guidelines

## Future Considerations (v2+)

- Vector DB abstraction (Chroma, SQLite-vss implementations)
- Incremental indexing (only changed notes)
- Staleness warning in search
- npm publish for easier distribution
- Full attachment content (OCR for images, PDF text extraction)
- iCloud sync awareness
- CONTRIBUTING.md if community grows
