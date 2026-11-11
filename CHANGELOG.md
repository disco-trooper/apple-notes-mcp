# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Breaking changes

- **Apple Silicon Mac required.** `@lancedb/lancedb` 0.41 ships no native binaries for Intel (x64) Macs
- **Duplicate titles are an error.** `get-note` and every tool that takes a note title return an error with `id:` suggestions instead of using the first match
- **Ambiguous folder names are an error.** A folder name that exists in several accounts must be given as `Account/Folder`
- **Read-only mode hides write tools.** With `READONLY_MODE` on, write tools are not registered at all
- **`search-notes` needs the chunk index.** The fallback to the old notes-table search is gone; without an index it asks you to run `index-notes`
- **Run `index-notes` with `mode: "full"` after upgrading.** Markdown conversion, tag and link extraction, the e5 query/passage prefixes and secret redaction all changed, so content indexed by 1.9.0 no longer matches what this version indexes and searches

### Added

- Tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) on every tool
- `getNoteById` lookup: search results, `related-notes` and post-write index sync address notes by Apple Notes id
- Folders can be addressed as a leaf name, a nested path (`Parent/Child`) or `Account/Folder`
- Embedding model guard: an incremental index run fails with a clear message when the configured embedding model or dimensions differ from the ones the index was built with
- In-process index lock: `index-notes`, background jobs, `reindex-note`, `purge-index` and post-write sync no longer write the index concurrently; search auto-refresh is skipped while indexing runs
- `search-notes` results include the note `id`
- `CHANGELOG.md` ships in the npm package
- CI workflow running type check and tests on macOS

### Changed

- `READONLY_MODE` and `DEBUG` accept `true`/`false`/`1`/`0` (case-insensitive)
- Titles containing `/` resolve as titles; `Folder/Title` is tried as a folder-scoped lookup as well
- `create-note` no longer duplicates the title when the content starts with it (Apple Notes writes the title as the first line itself). The response says when Apple Notes chose a different title
- Notes in "Recently Deleted" are no longer listed, indexed or matched by title, and folder lookups never target it (`id:` lookups still reach them)
- `delete-note` requires `confirm: true` in the input schema (any other value is rejected before the handler runs)
- `index-notes` syncs both the notes table (tags, links, related notes) and the chunk table (search) by note id in one run; incremental mode compares each note's `modified` date with the stored one
- `search-notes` with `include_content: true` reads the note by id
- Local e5 models embed search queries with the `query:` prefix (documents keep `passage:`); query embeddings are cached per provider and model
- `EMBEDDING_DIMS` is sent to OpenRouter only when set; without it the model's native size is used and expected to be 4096 (the default model's size)
- Settings from the MCP client's `env` block take precedence over `~/.apple-notes-mcp/.env`, which is now loaded before any module reads the environment
- Tables convert to Markdown tables, attachments and images to `[Attachment: name]`, and `[[wiki links]]` and `#tags` with `_` survive the HTML to Markdown conversion
- Hashtags: Unicode tags (`#práce`) and tags with `_` (`#my_tag`) are extracted whole; numeric (`#42`), single-character and hex-colour-like tags (`#ddd`, `#ffffff`, also words such as `#cafe`) are ignored, as are URL fragments
- `[[Title|alias]]` and `[[Title#heading]]` links resolve to `Title`
- Private key blocks are redacted in full (previously only the header line); short notes are no longer skipped, only notes with no content left after filtering
- Chunks overlap by the configured amount and never exceed the chunk size
- Error messages from domain errors are returned in full; internal errors are reduced to a generic message
- Setup wizard writes `~/.apple-notes-mcp/.env` with mode 0600 and keeps keys it does not manage; `~/.claude.json` is backed up, written atomically, and left untouched when it cannot be parsed
- `engines` requires Bun >= 1.1.0 (replaces `node >= 18`)
- Upgraded `@lancedb/lancedb` to 0.41 (see Breaking changes)
- Keyword search index stores token positions, so quoted phrases match as phrases. No stemming or stop-word removal; accents are folded (`prilis` matches `příliš`). Indexes written by 1.9.0 still open; the keyword index is rebuilt on the next index run
- Upgraded `@modelcontextprotocol/sdk` to 1.32
- Faster indexing: only chunks are embedded (a note's vector is the normalized mean of its chunk vectors), chunk vectors stored by the same embedding model are reused for unchanged chunk text in both full and incremental runs, and the local model embeds in pipeline batches of 8. `index-notes` reports embedded and reused chunk counts

### Fixed

- Settings in `~/.apple-notes-mcp/.env` were ignored by modules that read the environment at import time (OpenRouter key, model, dimensions)
- `[[links]]` were escaped by the Markdown conversion, so outlinks were never extracted; `#my_tag` was indexed as `my` and `#práce` as `pr`
- Tables in notes were flattened to one line in Markdown output
- `edit-table` edits cells by position, so a cell or table with the same HTML as an earlier one no longer gets the edit instead; table cell text is entity-decoded in `get-tables`
- Large note bodies no longer fail with `E2BIG`: scripts go to `osascript` via stdin
- OpenRouter: honours `Retry-After`, does not retry non-retryable errors, does not sleep after the last attempt, and keeps results in input order
- Empty `tags`/`outlinks` columns no longer break LanceDB table creation (explicit Arrow schemas)
- Filter values containing quotes are escaped correctly in index deletes and updates
- Index rows are keyed by note id, so notes with the same title in different folders no longer overwrite each other

### Removed

- `force` parameter of `index-notes`
- Legacy whole-note search path; `search-notes` always uses chunk search
- `run-jxa` dependency; all Apple Notes access goes through one killable `osascript` runner

## [1.9.0] - 2026-09-08

### Added

- `NOTES_FETCH_BATCH_SIZE` environment variable - Tune Notes fetch batch size for large libraries (default: 100)
- `JXA_TIMEOUT_MS` environment variable - Cap how long a single Notes read may take before it is retried or skipped (default: 120000)
- Indexing fetch now reports per-batch progress instead of a static fetch stage

### Fixed

- Indexer fetch uses bulk property reads over batched `folder.notes` slices instead of per-note Apple Events, so indexing 5000+ note libraries finishes instead of hanging (#8)
- A failing batch (locked, syncing, or corrupted note) falls back to per-note reads for that batch only and never fails the whole fetch
- Notes reads now time out and are retried or skipped instead of hanging indefinitely; `cancel-index-job` no longer sticks in `cancelling`
- Folder list shifts mid-fetch (folder created or deleted) remap the batch index instead of silently skipping the remaining folders

## [1.8.2] - 2026-02-07

### Fixed

- Bumped package version metadata so npm publish no longer targets already-released `1.8.0`

## [1.8.1] - 2026-02-07

### Fixed

- `list-notes` with `folder` now queries only matching folders instead of loading all notes first
- Preserved correctness for duplicate folder names across accounts by aggregating all matching folders

### Changed

- Improved `list-notes` folder performance by ~10x on larger vaults (single-folder lookup path)

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

[Unreleased]: https://github.com/disco-trooper/apple-notes-mcp/compare/v1.9.0...HEAD
[1.9.0]: https://github.com/disco-trooper/apple-notes-mcp/compare/v1.8.2...v1.9.0
[1.8.2]: https://github.com/disco-trooper/apple-notes-mcp/compare/v1.8.1...v1.8.2
[1.8.1]: https://github.com/disco-trooper/apple-notes-mcp/compare/v1.8.0...v1.8.1
[1.8.0]: https://github.com/disco-trooper/apple-notes-mcp/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/disco-trooper/apple-notes-mcp/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/disco-trooper/apple-notes-mcp/compare/v1.5.1...v1.6.0
[1.5.1]: https://github.com/disco-trooper/apple-notes-mcp/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/disco-trooper/apple-notes-mcp/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/disco-trooper/apple-notes-mcp/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/disco-trooper/apple-notes-mcp/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/disco-trooper/apple-notes-mcp/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/disco-trooper/apple-notes-mcp/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/disco-trooper/apple-notes-mcp/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/disco-trooper/apple-notes-mcp/releases/tag/v1.0.0
