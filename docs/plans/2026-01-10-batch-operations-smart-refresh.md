# Batch Operations, Smart Refresh & Test Coverage

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add batch-delete/batch-move tools, auto-refresh index before search, and vitest coverage reporting.

**Architecture:** Batch operations use existing CRUD functions in a loop. Smart refresh checks note modification dates before each search and triggers incremental index if needed. Coverage uses vitest's v8 provider.

**Tech Stack:** Bun, Vitest, Zod, JXA

---

## Task 1: Add Batch Delete Function

**Files:**
- Modify: `src/notes/crud.ts`
- Test: `src/notes/crud.test.ts` (create)

**Step 1: Write failing test**

```typescript
// src/notes/crud.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock run-jxa
vi.mock("run-jxa", () => ({
  runJxa: vi.fn(),
}));

describe("batchDelete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.READONLY_MODE = "false";
  });

  it("should delete multiple notes by titles", async () => {
    const { runJxa } = await import("run-jxa");
    const { batchDelete } = await import("./crud.js");

    vi.mocked(runJxa).mockResolvedValue(JSON.stringify({ deletedCount: 2 }));

    const result = await batchDelete({ titles: ["Note 1", "Note 2"] });

    expect(result.deleted).toBe(2);
    expect(result.failed).toEqual([]);
  });

  it("should delete all notes in a folder", async () => {
    const { runJxa } = await import("run-jxa");
    const { batchDelete } = await import("./crud.js");

    vi.mocked(runJxa).mockResolvedValue(JSON.stringify({ deletedCount: 5 }));

    const result = await batchDelete({ folder: "Old Project" });

    expect(result.deleted).toBe(5);
  });

  it("should throw if both titles and folder provided", async () => {
    const { batchDelete } = await import("./crud.js");

    await expect(
      batchDelete({ titles: ["Note"], folder: "Folder" })
    ).rejects.toThrow("Specify either titles or folder, not both");
  });

  it("should throw if neither titles nor folder provided", async () => {
    const { batchDelete } = await import("./crud.js");

    await expect(batchDelete({})).rejects.toThrow(
      "Specify either titles or folder"
    );
  });

  it("should throw in readonly mode", async () => {
    process.env.READONLY_MODE = "true";
    const { batchDelete } = await import("./crud.js");

    await expect(batchDelete({ titles: ["Note"] })).rejects.toThrow(
      "READONLY_MODE"
    );
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun run test src/notes/crud.test.ts
```

Expected: FAIL - batchDelete not defined

**Step 3: Implement batchDelete**

Add to `src/notes/crud.ts`:

```typescript
/**
 * Result of a batch operation.
 */
export interface BatchResult {
  /** Number of notes successfully processed */
  deleted: number;
  /** Notes that failed to process */
  failed: string[];
}

/**
 * Options for batch delete.
 */
export interface BatchDeleteOptions {
  /** List of note titles (supports folder/title and id:xxx formats) */
  titles?: string[];
  /** Delete all notes in this folder */
  folder?: string;
}

/**
 * Delete multiple notes at once.
 *
 * @param options - Either titles array OR folder name (not both)
 * @returns BatchResult with deleted count and failed notes
 * @throws Error if READONLY_MODE is enabled
 * @throws Error if both titles and folder provided
 * @throws Error if neither titles nor folder provided
 */
export async function batchDelete(options: BatchDeleteOptions): Promise<BatchResult> {
  checkReadOnly();

  const { titles, folder } = options;

  if (titles && folder) {
    throw new Error("Specify either titles or folder, not both");
  }

  if (!titles && !folder) {
    throw new Error("Specify either titles or folder");
  }

  const result: BatchResult = { deleted: 0, failed: [] };

  if (folder) {
    // Delete all notes in folder via single JXA call
    debug(`Batch deleting all notes in folder: "${folder}"`);

    const escapedFolder = JSON.stringify(folder);
    const jxaResult = await runJxa(`
      const app = Application('Notes');
      const folderName = ${escapedFolder};

      const folders = app.folders.whose({name: folderName})();
      if (folders.length === 0) {
        throw new Error("Folder not found: " + folderName);
      }

      const folder = folders[0];
      const notes = folder.notes();
      let deletedCount = 0;

      // Delete in reverse order to avoid index shifting
      for (let i = notes.length - 1; i >= 0; i--) {
        try {
          notes[i].delete();
          deletedCount++;
        } catch (e) {
          // Continue on individual failures
        }
      }

      return JSON.stringify({ deletedCount });
    `);

    const { deletedCount } = JSON.parse(jxaResult as string);
    result.deleted = deletedCount;
  } else if (titles) {
    // Delete individual notes
    debug(`Batch deleting ${titles.length} notes by title`);

    for (const title of titles) {
      try {
        await deleteNote(title);
        result.deleted++;
      } catch (error) {
        result.failed.push(title);
        debug(`Failed to delete "${title}":`, error);
      }
    }
  }

  debug(`Batch delete complete: ${result.deleted} deleted, ${result.failed.length} failed`);
  return result;
}
```

**Step 4: Run test to verify it passes**

```bash
bun run test src/notes/crud.test.ts
```

**Step 5: Commit**

```bash
git add src/notes/crud.ts src/notes/crud.test.ts
git commit -m "feat: add batchDelete function for bulk note deletion"
```

---

## Task 2: Add Batch Move Function

**Files:**
- Modify: `src/notes/crud.ts`
- Test: `src/notes/crud.test.ts`

**Step 1: Write failing test**

Add to `src/notes/crud.test.ts`:

```typescript
describe("batchMove", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.READONLY_MODE = "false";
  });

  it("should move multiple notes by titles", async () => {
    const { runJxa } = await import("run-jxa");
    const { batchMove } = await import("./crud.js");

    // Mock resolveNoteTitle for each note
    vi.mocked(runJxa)
      .mockResolvedValueOnce(JSON.stringify([{ id: "id1", title: "Note 1", folder: "Old" }]))
      .mockResolvedValueOnce("ok")
      .mockResolvedValueOnce(JSON.stringify([{ id: "id2", title: "Note 2", folder: "Old" }]))
      .mockResolvedValueOnce("ok");

    const result = await batchMove({
      titles: ["Note 1", "Note 2"],
      targetFolder: "Archive",
    });

    expect(result.moved).toBe(2);
    expect(result.failed).toEqual([]);
  });

  it("should move all notes from source folder", async () => {
    const { runJxa } = await import("run-jxa");
    const { batchMove } = await import("./crud.js");

    vi.mocked(runJxa).mockResolvedValue(JSON.stringify({ movedCount: 3 }));

    const result = await batchMove({
      sourceFolder: "Temp",
      targetFolder: "Archive",
    });

    expect(result.moved).toBe(3);
  });

  it("should throw if both titles and sourceFolder provided", async () => {
    const { batchMove } = await import("./crud.js");

    await expect(
      batchMove({ titles: ["Note"], sourceFolder: "Folder", targetFolder: "Archive" })
    ).rejects.toThrow("Specify either titles or sourceFolder, not both");
  });

  it("should throw if targetFolder missing", async () => {
    const { batchMove } = await import("./crud.js");

    await expect(
      batchMove({ titles: ["Note"], targetFolder: "" })
    ).rejects.toThrow("targetFolder is required");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun run test src/notes/crud.test.ts
```

**Step 3: Implement batchMove**

Add to `src/notes/crud.ts`:

```typescript
/**
 * Result of a batch move operation.
 */
export interface BatchMoveResult {
  /** Number of notes successfully moved */
  moved: number;
  /** Notes that failed to move */
  failed: string[];
}

/**
 * Options for batch move.
 */
export interface BatchMoveOptions {
  /** List of note titles (supports folder/title and id:xxx formats) */
  titles?: string[];
  /** Move all notes from this folder */
  sourceFolder?: string;
  /** Target folder (required) */
  targetFolder: string;
}

/**
 * Move multiple notes to a target folder.
 *
 * @param options - Either titles array OR sourceFolder (not both) + targetFolder
 * @returns BatchMoveResult with moved count and failed notes
 * @throws Error if READONLY_MODE is enabled
 * @throws Error if both titles and sourceFolder provided
 * @throws Error if neither titles nor sourceFolder provided
 * @throws Error if targetFolder is empty
 */
export async function batchMove(options: BatchMoveOptions): Promise<BatchMoveResult> {
  checkReadOnly();

  const { titles, sourceFolder, targetFolder } = options;

  if (!targetFolder) {
    throw new Error("targetFolder is required");
  }

  if (titles && sourceFolder) {
    throw new Error("Specify either titles or sourceFolder, not both");
  }

  if (!titles && !sourceFolder) {
    throw new Error("Specify either titles or sourceFolder");
  }

  const result: BatchMoveResult = { moved: 0, failed: [] };

  if (sourceFolder) {
    // Move all notes from source folder via single JXA call
    debug(`Batch moving all notes from "${sourceFolder}" to "${targetFolder}"`);

    const escapedSource = JSON.stringify(sourceFolder);
    const escapedTarget = JSON.stringify(targetFolder);
    const jxaResult = await runJxa(`
      const app = Application('Notes');
      const sourceName = ${escapedSource};
      const targetName = ${escapedTarget};

      const sourceFolders = app.folders.whose({name: sourceName})();
      if (sourceFolders.length === 0) {
        throw new Error("Source folder not found: " + sourceName);
      }

      const targetFolders = app.folders.whose({name: targetName})();
      if (targetFolders.length === 0) {
        throw new Error("Target folder not found: " + targetName);
      }

      const source = sourceFolders[0];
      const target = targetFolders[0];
      const notes = source.notes();
      let movedCount = 0;

      // Move in reverse order to avoid index shifting
      for (let i = notes.length - 1; i >= 0; i--) {
        try {
          notes[i].move({to: target});
          movedCount++;
        } catch (e) {
          // Continue on individual failures
        }
      }

      return JSON.stringify({ movedCount });
    `);

    const { movedCount } = JSON.parse(jxaResult as string);
    result.moved = movedCount;
  } else if (titles) {
    // Move individual notes
    debug(`Batch moving ${titles.length} notes to "${targetFolder}"`);

    for (const title of titles) {
      try {
        await moveNote(title, targetFolder);
        result.moved++;
      } catch (error) {
        result.failed.push(title);
        debug(`Failed to move "${title}":`, error);
      }
    }
  }

  debug(`Batch move complete: ${result.moved} moved, ${result.failed.length} failed`);
  return result;
}
```

**Step 4: Run test to verify it passes**

```bash
bun run test src/notes/crud.test.ts
```

**Step 5: Commit**

```bash
git add src/notes/crud.ts src/notes/crud.test.ts
git commit -m "feat: add batchMove function for bulk note relocation"
```

---

## Task 3: Add MCP Tools for Batch Operations

**Files:**
- Modify: `src/index.ts`

**Step 1: Add Zod schemas after existing schemas (~line 145)**

```typescript
const BatchDeleteSchema = z.object({
  titles: z.array(z.string().max(MAX_TITLE_LENGTH)).optional(),
  folder: z.string().max(200).optional(),
  confirm: z.literal(true),
}).refine(
  (data) => (data.titles && !data.folder) || (!data.titles && data.folder),
  { message: "Specify either titles or folder, not both" }
);

const BatchMoveSchema = z.object({
  titles: z.array(z.string().max(MAX_TITLE_LENGTH)).optional(),
  sourceFolder: z.string().max(200).optional(),
  targetFolder: z.string().min(1).max(200),
}).refine(
  (data) => (data.titles && !data.sourceFolder) || (!data.titles && data.sourceFolder),
  { message: "Specify either titles or sourceFolder, not both" }
);
```

**Step 2: Add tool definitions in ListToolsRequestSchema handler (after edit-table)**

```typescript
{
  name: "batch-delete",
  description: "Delete multiple notes at once. Requires confirm: true for safety.",
  inputSchema: {
    type: "object",
    properties: {
      titles: {
        type: "array",
        items: { type: "string" },
        description: "Note titles to delete (supports folder/title and id:xxx formats)",
      },
      folder: {
        type: "string",
        description: "Delete ALL notes in this folder",
      },
      confirm: {
        type: "boolean",
        description: "Must be true to confirm deletion",
      },
    },
    required: ["confirm"],
  },
},
{
  name: "batch-move",
  description: "Move multiple notes to a target folder at once.",
  inputSchema: {
    type: "object",
    properties: {
      titles: {
        type: "array",
        items: { type: "string" },
        description: "Note titles to move (supports folder/title and id:xxx formats)",
      },
      sourceFolder: {
        type: "string",
        description: "Move ALL notes from this folder",
      },
      targetFolder: {
        type: "string",
        description: "Target folder to move notes to",
      },
    },
    required: ["targetFolder"],
  },
},
```

**Step 3: Add import for batch functions**

Update import at top of file:

```typescript
import { createNote, updateNote, deleteNote, moveNote, editTable, batchDelete, batchMove } from "./notes/crud.js";
```

**Step 4: Add tool handlers in CallToolRequestSchema switch (after edit-table case)**

```typescript
case "batch-delete": {
  const params = BatchDeleteSchema.parse(args);
  const result = await batchDelete({
    titles: params.titles,
    folder: params.folder,
  });

  let message = `Deleted ${result.deleted} notes.`;
  if (result.failed.length > 0) {
    message += `\nFailed to delete: ${result.failed.join(", ")}`;
  }
  return textResponse(message);
}

case "batch-move": {
  const params = BatchMoveSchema.parse(args);
  const result = await batchMove({
    titles: params.titles,
    sourceFolder: params.sourceFolder,
    targetFolder: params.targetFolder,
  });

  let message = `Moved ${result.moved} notes to "${params.targetFolder}".`;
  if (result.failed.length > 0) {
    message += `\nFailed to move: ${result.failed.join(", ")}`;
  }
  return textResponse(message);
}
```

**Step 5: Run type check**

```bash
bun run check
```

**Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: add batch-delete and batch-move MCP tools"
```

---

## Task 4: Add Smart Refresh Before Search

**Files:**
- Create: `src/search/refresh.ts`
- Test: `src/search/refresh.test.ts`

**Step 1: Write failing test**

```typescript
// src/search/refresh.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../notes/read.js", () => ({
  getAllNotes: vi.fn(),
}));

vi.mock("../db/lancedb.js", () => ({
  getVectorStore: vi.fn(() => ({
    getAll: vi.fn(),
  })),
}));

vi.mock("./indexer.js", () => ({
  incrementalIndex: vi.fn(),
}));

describe("checkForChanges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return true if notes were modified after indexing", async () => {
    const { getAllNotes } = await import("../notes/read.js");
    const { getVectorStore } = await import("../db/lancedb.js");

    vi.mocked(getAllNotes).mockResolvedValue([
      { title: "Note 1", folder: "Work", created: "2026-01-01", modified: "2026-01-10T12:00:00Z" },
    ]);

    vi.mocked(getVectorStore).mockReturnValue({
      getAll: vi.fn().mockResolvedValue([
        { title: "Note 1", folder: "Work", indexed_at: "2026-01-09T12:00:00Z" },
      ]),
    } as any);

    const { checkForChanges } = await import("./refresh.js");
    const hasChanges = await checkForChanges();

    expect(hasChanges).toBe(true);
  });

  it("should return false if no changes", async () => {
    const { getAllNotes } = await import("../notes/read.js");
    const { getVectorStore } = await import("../db/lancedb.js");

    vi.mocked(getAllNotes).mockResolvedValue([
      { title: "Note 1", folder: "Work", created: "2026-01-01", modified: "2026-01-08T12:00:00Z" },
    ]);

    vi.mocked(getVectorStore).mockReturnValue({
      getAll: vi.fn().mockResolvedValue([
        { title: "Note 1", folder: "Work", indexed_at: "2026-01-09T12:00:00Z" },
      ]),
    } as any);

    const { checkForChanges } = await import("./refresh.js");
    const hasChanges = await checkForChanges();

    expect(hasChanges).toBe(false);
  });
});

describe("refreshIfNeeded", () => {
  it("should trigger incremental index if changes detected", async () => {
    const { incrementalIndex } = await import("./indexer.js");
    const { getAllNotes } = await import("../notes/read.js");
    const { getVectorStore } = await import("../db/lancedb.js");

    vi.mocked(getAllNotes).mockResolvedValue([
      { title: "New Note", folder: "Work", created: "2026-01-10", modified: "2026-01-10T12:00:00Z" },
    ]);

    vi.mocked(getVectorStore).mockReturnValue({
      getAll: vi.fn().mockResolvedValue([]),
    } as any);

    vi.mocked(incrementalIndex).mockResolvedValue({
      total: 1,
      indexed: 1,
      errors: 0,
      timeMs: 100,
    });

    const { refreshIfNeeded } = await import("./refresh.js");
    const refreshed = await refreshIfNeeded();

    expect(refreshed).toBe(true);
    expect(incrementalIndex).toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun run test src/search/refresh.test.ts
```

**Step 3: Implement refresh.ts**

```typescript
// src/search/refresh.ts
/**
 * Smart refresh: check for note changes before search.
 * Triggers incremental index if notes have been modified.
 */

import { getAllNotes } from "../notes/read.js";
import { getVectorStore } from "../db/lancedb.js";
import { incrementalIndex } from "./indexer.js";
import { createDebugLogger } from "../utils/debug.js";

const debug = createDebugLogger("REFRESH");

/**
 * Check if any notes have been modified since last index.
 * Compares note modification dates with indexed_at timestamps.
 *
 * @returns true if changes detected, false otherwise
 */
export async function checkForChanges(): Promise<boolean> {
  debug("Checking for changes...");

  const currentNotes = await getAllNotes();
  const store = getVectorStore();

  let existingRecords;
  try {
    existingRecords = await store.getAll();
  } catch {
    // No index exists yet
    debug("No existing index found");
    return currentNotes.length > 0;
  }

  // Build lookup map for existing records
  const existingByKey = new Map<string, string>();
  for (const record of existingRecords) {
    const key = `${record.folder}/${record.title}`;
    existingByKey.set(key, record.indexed_at);
  }

  // Check for new or modified notes
  for (const note of currentNotes) {
    const key = `${note.folder}/${note.title}`;
    const indexedAt = existingByKey.get(key);

    if (!indexedAt) {
      debug(`New note detected: ${key}`);
      return true;
    }

    const noteModified = new Date(note.modified).getTime();
    const recordIndexed = new Date(indexedAt).getTime();

    if (noteModified > recordIndexed) {
      debug(`Modified note detected: ${key}`);
      return true;
    }
  }

  // Check for deleted notes
  const currentKeys = new Set(currentNotes.map((n) => `${n.folder}/${n.title}`));
  for (const key of existingByKey.keys()) {
    if (!currentKeys.has(key)) {
      debug(`Deleted note detected: ${key}`);
      return true;
    }
  }

  debug("No changes detected");
  return false;
}

/**
 * Refresh index if changes are detected.
 * Call this before search operations for auto-sync.
 *
 * @returns true if index was refreshed, false if no changes
 */
export async function refreshIfNeeded(): Promise<boolean> {
  const hasChanges = await checkForChanges();

  if (!hasChanges) {
    return false;
  }

  debug("Changes detected, running incremental index...");
  const result = await incrementalIndex();
  debug(`Refresh complete: ${result.indexed} notes updated in ${result.timeMs}ms`);

  return true;
}
```

**Step 4: Run test to verify it passes**

```bash
bun run test src/search/refresh.test.ts
```

**Step 5: Commit**

```bash
git add src/search/refresh.ts src/search/refresh.test.ts
git commit -m "feat: add smart refresh to detect note changes before search"
```

---

## Task 5: Integrate Smart Refresh into Search

**Files:**
- Modify: `src/index.ts`

**Step 1: Add import**

```typescript
import { refreshIfNeeded } from "./search/refresh.js";
```

**Step 2: Modify search-notes handler to call refreshIfNeeded**

Update the `case "search-notes":` handler:

```typescript
case "search-notes": {
  const params = SearchNotesSchema.parse(args);

  // Smart refresh: check for changes before search
  const refreshed = await refreshIfNeeded();
  if (refreshed) {
    debug("Index refreshed before search");
  }

  // Use chunk-based search if chunk index exists (better for long notes)
  const useChunkSearch = await hasChunkIndex();
  // ... rest of existing code
```

**Step 3: Run type check and tests**

```bash
bun run check
bun run test
```

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: integrate smart refresh into search-notes"
```

---

## Task 6: Add Vitest Coverage Configuration

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json`

**Step 1: Create vitest.config.ts**

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      exclude: [
        "**/*.test.ts",
        "**/node_modules/**",
        "**/dist/**",
        "vitest.config.ts",
      ],
      include: ["src/**/*.ts"],
    },
  },
});
```

**Step 2: Add coverage script to package.json**

Update scripts section:

```json
"scripts": {
  "start": "bun run src/index.ts",
  "setup": "bun run src/setup.ts",
  "dev": "bun --watch run src/index.ts",
  "check": "bun run tsc --noEmit",
  "test": "vitest run",
  "test:watch": "vitest",
  "test:coverage": "vitest run --coverage"
}
```

**Step 3: Install coverage dependency**

```bash
bun add -d @vitest/coverage-v8
```

**Step 4: Run coverage**

```bash
bun run test:coverage
```

**Step 5: Add coverage directory to .gitignore**

```bash
echo "coverage/" >> .gitignore
```

**Step 6: Commit**

```bash
git add vitest.config.ts package.json .gitignore
git commit -m "feat: add vitest coverage configuration"
```

---

## Task 7: Update Documentation

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Step 1: Update README.md tools section**

Add after move-note:

```markdown
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
```

Add to "What's New" or create section:

```markdown
### Smart Refresh
Search automatically checks for note changes and reindexes if needed. No manual `index-notes` required after editing notes in Apple Notes.
```

**Step 2: Update CHANGELOG.md**

Add to [Unreleased]:

```markdown
### Added

- `batch-delete` tool - delete multiple notes by titles or all notes in a folder
- `batch-move` tool - move multiple notes by titles or all notes from a source folder
- Smart refresh - auto-reindex changed notes before search
- Test coverage reporting (`bun run test:coverage`)
```

**Step 3: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document batch operations and smart refresh"
```

---

## Task 8: Final Testing

**Step 1: Run all tests**

```bash
bun run test
```

Expected: All tests pass

**Step 2: Run type check**

```bash
bun run check
```

Expected: No errors

**Step 3: Run coverage**

```bash
bun run test:coverage
```

Expected: Coverage report generated

**Step 4: Manual test batch operations**

Start MCP server and test:
- `batch-delete titles: ["Test Note 1", "Test Note 2"] confirm: true`
- `batch-move titles: ["Note"] targetFolder: "Archive"`
- `batch-move sourceFolder: "Temp" targetFolder: "Archive"`
- `batch-delete folder: "Empty Folder" confirm: true`

**Step 5: Manual test smart refresh**

1. Run search-notes
2. Create a note in Apple Notes manually
3. Run search-notes again
4. Verify the new note appears without manual index-notes

---

## Critical Files Summary

| File | Changes |
|------|---------|
| `src/notes/crud.ts` | Add batchDelete, batchMove |
| `src/notes/crud.test.ts` | Tests for batch operations |
| `src/search/refresh.ts` | Smart refresh logic |
| `src/search/refresh.test.ts` | Tests for refresh |
| `src/index.ts` | MCP tools + refresh integration |
| `vitest.config.ts` | Coverage configuration |
| `package.json` | Coverage script |
| `README.md` | Documentation |
| `CHANGELOG.md` | Release notes |
