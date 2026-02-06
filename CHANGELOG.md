# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.8.0] - 2026-02-06

### Added

- `SEARCH_REFRESH_TIMEOUT_MS` environment variable to cap how long `search-notes` waits for auto-refresh
- TTL refresh policy module with focused tests (`refresh-policy`)
- Background index job manager with `start-index-job`, `get-index-job`, and `list-index-jobs`
- `cancel-index-job` for best-effort cancellation of running background jobs
- `INDEX_JOB_RETENTION_SECONDS` environment variable for index job history retention
- Post-write index sync layer for create/update/delete/move operations
- Shared indexing progress/cancellation contracts for job orchestration

### Changed

- `search-notes` auto-refresh now respects `INDEX_TTL` (disabled when unset)
- Auto-refresh now fails open: if refresh fails or times out, search continues using stale index instead of returning an error
- Incremental index and refresh change detection now use metadata-only index reads instead of full record loads
- `index-notes` supports explicit `background` mode while keeping synchronous default behavior for backward compatibility
- CRUD operations now return richer note metadata (including note ID) for robust index synchronization
- Background job progress is now granular (phase and batch based) instead of mostly static
- Background jobs now support `cancelling` and `cancelled` states

## [1.7.0] - 2026-01-22

### Added

- **Hybrid fallback indexing** - Falls back from single call → folder batch → note-by-note when notes fail
- **Streaming batch processing** - Processes embeddings in batches to reduce peak memory
- `EMBEDDING_BATCH_SIZE` environment variable - Tune batch size for memory-constrained systems (default: 50)
- Skipped notes reporting - Shows which notes failed to read (locked, syncing, or corrupted)
- **Faster incremental index** - Uses batch fetch instead of individual JXA calls per note

### Fixed

- `SyntaxError: JSON Parse error: Unexpected identifier "undefined"` when JXA returns undefined (OOM kill or inaccessible notes)
- Null pointer in `related-notes` and `export-graph` for null outlinks

## [1.6.0] - 2026-01-20

### Added

- **Table Markdown conversion** - Tables render as Markdown instead of `[Attachment: unknown]`
- `get-tables` tool - Extract structured table data (rows, columns, formatting)
- `include_html` parameter for `get-note` - Access raw Apple Notes HTML

### Fixed

- Pipe characters in table cells now escaped for valid Markdown output

## [1.5.1] - 2026-01-11

### Fixed

- Updated README "What's New" section for v1.5

## [1.5.0] - 2026-01-11

### Added

- `list-notes` sorting and filtering: sort by created, modified, or title; filter by folder; limit results
- Case-insensitive folder filtering for better usability

### Fixed

- Notes with empty dates no longer break sorting (treated as epoch)

## [1.4.0] - 2026-01-11

### Added

- `batch-delete` tool - delete multiple notes by title or entire folder
- `batch-move` tool - move multiple notes to target folder
- `purge-index` tool - clear all indexed data for model switching or corruption recovery
- Smart refresh - search auto-reindexes changed notes (no manual index-notes needed)
- Test coverage reporting (`bun run test:coverage`)

## [1.3.0] - 2026-01-10

### Added

- Chunk-based search using Parent Document Retriever pattern for accurate long note search
- Query embedding cache with LRU eviction (60x faster repeated queries)
- Content quality filter (auto-skips Base64/binary content)
- Smart first-run detection with auto-setup wizard
- Claude Code configuration generator
- Unified config paths (`~/.apple-notes-mcp/`)
- Knowledge Graph features:
  - `#tag` parsing during indexing
  - `[[wiki-link]]` parsing for note connections
  - `list-tags` tool - view all tags with counts
  - `search-by-tag` tool - find notes by tag
  - `related-notes` tool - discover connected notes
  - `export-graph` tool with JSON and GraphML formats for visualization

### Changed

- Indexing 4-6x faster with batch embeddings and parallel note fetching
- Setup wizard uses unified config paths

### Fixed

- Arrow type inference for empty tags/outlinks arrays
- Bun shebang for npm bin execution

## [1.2.0] - 2026-01-09

### Added

- ID-based note lookup with `id:xxx` prefix for precise disambiguation
- Typed error classes: `NoteNotFoundError`, `DuplicateNoteError`, `ReadOnlyModeError`, `FolderNotFoundError`, `TableOutOfBoundsError`
- Input validation with max length limits on Zod schemas

### Fixed

- FTS index rebuild after `reindexNote()` - keyword search now works after single-note reindex
- Hybrid search key collision - use note ID instead of title for RRF score calculation
- HTML escaping in table cell values to prevent injection
- Correct LanceDB FTS API usage (`table.query().fullTextSearch()`)

### Changed

- Refactored `read.ts` into smaller modules: `read.ts`, `resolve.ts`, `conversion.ts`
- Removed Smithery integration (server.ts)
- Simplified `updateTableCell` with helper functions

## [1.1.0] - 2026-01-09

### Added

- `edit-table` tool for direct HTML table cell editing
- Table parsing utilities in `src/notes/tables.ts`

## [1.0.1] - 2026-01-08

### Changed

- Updated README with npm installation instructions
- Fixed EMBEDDING_MODEL env description to cover both local and OpenRouter providers

## [1.0.0] - 2026-01-08

### Added

- Initial release
- MCP server for Apple Notes with semantic search
- Hybrid search (vector + keyword) with RRF fusion
- CRUD operations: create, read, update, delete, move notes
- Dual embedding support: local (HuggingFace Transformers) or cloud (OpenRouter)
- Incremental indexing with change detection
- Folder filtering and disambiguation via `folder/title` format
- Interactive setup wizard (`bun run setup`)
- Read-only mode via `READONLY_MODE` env variable
- Debug logging via `DEBUG` env variable

[Unreleased]: https://github.com/disco-trooper/apple-notes-mcp/compare/v1.6.0...HEAD
[1.6.0]: https://github.com/disco-trooper/apple-notes-mcp/compare/v1.5.1...v1.6.0
[1.5.1]: https://github.com/disco-trooper/apple-notes-mcp/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/disco-trooper/apple-notes-mcp/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/disco-trooper/apple-notes-mcp/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/disco-trooper/apple-notes-mcp/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/disco-trooper/apple-notes-mcp/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/disco-trooper/apple-notes-mcp/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/disco-trooper/apple-notes-mcp/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/disco-trooper/apple-notes-mcp/releases/tag/v1.0.0
