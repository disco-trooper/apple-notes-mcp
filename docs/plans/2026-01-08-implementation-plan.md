# Implementation Plan: apple-notes-mcp

**Date:** 2026-01-08
**Design:** [apple-notes-mcp-design.md](./2026-01-08-apple-notes-mcp-design.md)
**Status:** Updated (post-interview)

## Phase 1: Project Setup

### Step 1.1: Initialize project
- [ ] Create `package.json` with Bun
- [ ] Add dependencies (MCP SDK, LanceDB, HuggingFace, marked, etc.)
- [ ] Create `tsconfig.json`
- [ ] Create `.gitignore`
- [ ] Create LICENSE (MIT)
- [ ] Initial commit

### Step 1.2: Basic MCP skeleton
- [ ] Create `src/index.ts` with MCP server boilerplate
- [ ] Register empty tool handlers for all 10 tools
- [ ] Add DEBUG logging infrastructure (stderr)
- [ ] Test server starts without errors

## Phase 2: Core Infrastructure

### Step 2.1: Database layer (`src/db/lancedb.ts`)
- [ ] Define VectorStore interface (for future extensibility)
- [ ] Connect to LanceDB (`~/.apple-notes-mcp/data/`)
- [ ] Define schema (title, content, vector, folder, created, modified, indexed_at)
- [ ] Implement `index()`, `update()`, `delete()`, `search()`, `searchFTS()`, `count()`, `clear()`
- [ ] Implement `getByTitle()` for single-note operations
- [ ] Test with mock data

### Step 2.2: Embedding - Local (`src/embeddings/local.ts`)
- [ ] Load HuggingFace transformers pipeline (lazy loading)
- [ ] Default model: `Xenova/multilingual-e5-small`
- [ ] Implement `getEmbedding(text): number[]`
- [ ] Add model configuration via `EMBEDDING_MODEL` env var
- [ ] Test embedding generation

### Step 2.3: Embedding - OpenRouter (`src/embeddings/openrouter.ts`)
- [ ] Implement API client with retry logic (3 attempts, exponential backoff)
- [ ] Handle rate limiting (429)
- [ ] Add caching for repeated queries
- [ ] Default model: `qwen/qwen3-embedding-8b`
- [ ] Test with real API

### Step 2.4: Embedding - Auto-detect (`src/embeddings/index.ts`)
- [ ] Check for `OPENROUTER_API_KEY` env var
- [ ] Export unified `getEmbedding` function
- [ ] Log which provider is active (when DEBUG=true)

## Phase 3: Apple Notes Integration

### Step 3.1: Read operations (`src/notes/read.ts`)
- [ ] `getAllNoteTitles()` - JXA
- [ ] `getNoteByTitle(title)` - JXA with safe JSON.stringify escaping
- [ ] `getAllFolders()` - JXA
- [ ] `resolveNoteTitle(title)` - handle folder prefix disambiguation
- [ ] HTML → Markdown conversion (Turndown)
- [ ] Extract attachment placeholders from HTML
- [ ] Test with real Notes (including Czech characters)

### Step 3.2: Write operations (`src/notes/crud.ts`)
- [ ] Markdown → HTML conversion (marked)
- [ ] `createNote(title, content, folder?)` - check for duplicates first
- [ ] `updateNote(title, content)` - resolve title, then update
- [ ] `deleteNote(title, confirm)` - require confirm=true
- [ ] `moveNote(title, folder)` - resolve title, then move
- [ ] READONLY_MODE check wrapper for all write operations
- [ ] Test each operation

## Phase 4: Search

### Step 4.1: Indexer (`src/search/indexer.ts`)
- [ ] Fetch all notes with folder info and modified timestamps
- [ ] Convert HTML → Markdown + extract attachments
- [ ] Generate embeddings (batch with 300ms delay)
- [ ] Store in LanceDB via VectorStore interface (with indexed_at)
- [ ] Return final summary (count, time, errors)

### Step 4.2: Incremental indexer
- [ ] Compare Apple Notes modified vs LanceDB indexed_at
- [ ] Detect: new notes (INSERT), changed notes (UPDATE), deleted notes (DELETE)
- [ ] Only embed changed/new notes
- [ ] Return breakdown summary (added, updated, deleted, skipped)

### Step 4.3: Single-note reindex
- [ ] `reindexNote(title)` - resolve title, fetch, embed, update in DB
- [ ] Update indexed_at timestamp
- [ ] Used by `update-note` when `reindex: true`

### Step 4.4: Hybrid search (`src/search/index.ts`)
- [ ] Vector search via VectorStore
- [ ] FTS search via VectorStore (keyword-only mode)
- [ ] RRF (Reciprocal Rank Fusion) merge (hybrid mode)
- [ ] Support `mode` parameter: hybrid, keyword, semantic
- [ ] Apply folder filter if provided
- [ ] Support `include_content` parameter (preview vs full)
- [ ] Return top N results
- [ ] Test search quality

## Phase 5: MCP Tools

### Step 5.1: Read tools
- [ ] `list-notes` - count from VectorStore
- [ ] `get-note` - fetch by title (with folder resolution)
- [ ] `list-folders` - all folders from Apple Notes
- [ ] `search-notes` - params: query, folder?, limit?, mode?, include_content?
- [ ] `index-notes` - params: mode? (full/incremental), force?
- [ ] `reindex-note` - params: title

### Step 5.2: Write tools
- [ ] `create-note` - with READONLY check, duplicate check
- [ ] `update-note` - params: title, content, reindex? (default true)
- [ ] `delete-note` - with READONLY check, confirm requirement
- [ ] `move-note` - with READONLY check, title resolution

### Step 5.3: Integration test
- [ ] Test all 10 tools via MCP protocol
- [ ] Test READONLY_MODE blocks writes
- [ ] Test error handling (duplicate, not found, no confirm)
- [ ] Test folder prefix disambiguation
- [ ] Test incremental vs full indexing
- [ ] Test search modes (hybrid, keyword, semantic)
- [ ] Test include_content parameter

## Phase 6: Setup Wizard

### Step 6.1: CLI (`src/setup.ts`)
- [ ] Detect current configuration (existing .env, ~/.claude.json)
- [ ] Provider selection prompt (Local / OpenRouter)
- [ ] API key input (if OpenRouter)
- [ ] READONLY_MODE toggle
- [ ] AUTO_INDEX mode selection (none / on-search / ttl)
- [ ] TTL duration selection (if ttl mode)
- [ ] DEBUG toggle
- [ ] Download local model if needed (with progress)
- [ ] Save configuration to .env

### Step 6.2: Claude config integration
- [ ] Prompt "Add to Claude Code config?"
- [ ] If yes: read ~/.claude.json, merge config, write back
- [ ] If no: show snippet for manual copy
- [ ] Handle case when ~/.claude.json doesn't exist

### Step 6.3: Optional indexing
- [ ] Prompt "Index notes now?"
- [ ] Run indexing if yes
- [ ] Show summary

### Step 6.4: npm script
- [ ] Add `"setup": "bun run src/setup.ts"` to package.json
- [ ] Test full setup flow

## Phase 7: Documentation

### Step 7.1: README.md
- [ ] Project description & features list
- [ ] Installation instructions (git clone + bun install)
- [ ] Quick start (bun run setup)
- [ ] Configuration reference (env vars table)
- [ ] Tool reference (all 10 tools with examples)
- [ ] Claude Code setup guide
- [ ] Troubleshooting section
- [ ] Contributing: "PRs welcome" + basic guidelines

### Step 7.2: docs/models.md
- [ ] Local model comparison table (e5-small, MiniLM, bge-m3)
- [ ] OpenRouter model options
- [ ] Performance vs quality vs memory trade-offs
- [ ] bge-m3 recommendation for best quality

### Step 7.3: Final
- [ ] Clean up code, remove test files
- [ ] Final commit
- [ ] Create GitHub repo (disco-trooper/apple-notes-mcp)
- [ ] Push

## Verification Checklist

After each phase:
- [ ] All new code compiles (`bun check`)
- [ ] Server starts without errors
- [ ] Manual test of new functionality
- [ ] DEBUG logging works correctly
- [ ] Commit with clear message

## Phase Dependencies

```
Phase 1 (Setup)
    ↓
Phase 2 (Infrastructure) ──→ Phase 3 (Notes Integration)
    ↓                              ↓
    └──────────→ Phase 4 (Search) ←┘
                     ↓
              Phase 5 (MCP Tools)
                     ↓
              Phase 6 (Setup Wizard)
                     ↓
              Phase 7 (Documentation)
```

## Key Implementation Details

### Title Resolution Algorithm
```typescript
async function resolveTitle(input: string): Promise<string> {
  // "Work/My Note" → explicit folder
  if (input.includes('/')) {
    const [folder, title] = input.split('/', 2);
    return verifyNoteExists(folder, title);
  }

  // "My Note" → find all matches
  const matches = await findNotesByTitle(input);
  if (matches.length === 0) throw new Error(`Note not found: ${input}`);
  if (matches.length === 1) return matches[0].fullPath;

  // Multiple matches → error with suggestions
  throw new Error(
    `Multiple notes found. Use full path:\n` +
    matches.map(m => `  - ${m.folder}/${m.title}`).join('\n')
  );
}
```

### Search Result Format
```typescript
interface SearchResult {
  title: string;
  folder: string;
  preview: string;      // First 200 chars (always included)
  content?: string;     // Full content (only if include_content: true)
  modified: string;     // ISO date
  score: number;        // RRF score
}
```

### Error Response Format
```typescript
// All errors return clear, actionable messages
return {
  content: [{
    type: "text",
    text: `Error: Note already exists: "${title}"\nUse update-note to modify.`
  }]
};
```

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| HuggingFace model slow to load | Lazy loading, progress in setup wizard |
| OpenRouter rate limits | Exponential backoff, 300ms delay between calls |
| JXA escaping edge cases | Comprehensive JSON.stringify, test with special chars |
| LanceDB schema changes | Version check in db module |
| Large notes (>8k tokens) | Truncate content before embedding |
