# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `edit-table` tool for direct HTML table cell editing

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

[Unreleased]: https://github.com/disco-trooper/apple-notes-mcp/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/disco-trooper/apple-notes-mcp/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/disco-trooper/apple-notes-mcp/releases/tag/v1.0.0
