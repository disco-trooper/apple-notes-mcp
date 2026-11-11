# AGENTS.md

MCP server for Apple Notes (Bun + TypeScript): CRUD via JXA, semantic search via LanceDB. User docs: README.md.

## Commands

```bash
bun install
bun run check   # tsc, must be clean
bun run test    # vitest; never `bun test` (Bun's runner is incompatible)
bun run start   # stdio MCP server
bun run setup   # setup wizard
```

## Rules

- All osascript calls go through `executeJxa` in `src/notes/jxa-runner.ts`. Embed user strings in JXA only via `JSON.stringify`.
- Identify notes by Apple Notes `id`, never by `folder/title`.
- Nothing may write to stdout in the server path (it is the MCP stdio channel); log with `debug()` (stderr).
- Index writes go through `indexNotes` / write-sync, which take the index lock.

## Git

- Do not add Claude as a contributor and do not use `Co-Authored-By` headers. Commits have only the user as author.

## Releases

1. Update `CHANGELOG.md` (rename `[Unreleased]` to the version and date).
2. Bump `version` in `package.json` (the server reads it at runtime).
3. Commit `chore: release vX.Y.Z`.
4. `npm publish` (needs the user's npm auth).
