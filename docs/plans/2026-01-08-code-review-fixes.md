# Code Review Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all blocking issues, security vulnerabilities, and code quality problems identified in the code review.

**Architecture:** Systematic fixes progressing from critical bugs → security → code quality → tests. Each fix is isolated and testable.

**Tech Stack:** TypeScript, Zod validation, Vitest for testing

---

## Summary of Issues to Fix

| Priority | Issue | Location |
|----------|-------|----------|
| P0 | Silent indexing failures | indexer.ts:219-222 |
| P0 | Non-atomic update operation | lancedb.ts:111-119 |
| P0 | Empty catch blocks (5 locations) | Multiple files |
| P1 | SQL injection risk | lancedb.ts:126-128, 176-180 |
| P1 | Missing limit validation | index.ts:26-32 |
| P2 | Type name collision (SearchResult) | lancedb.ts, search/index.ts |
| P2 | Extract magic numbers | Multiple files |
| P2 | Discriminated unions for types | read.ts, indexer.ts |
| P3 | Environment variable validation | New file |
| P3 | Unit test coverage | New files |

---

## Task 1: Fix Silent Indexing Failures

**Files:**
- Modify: `src/search/indexer.ts:28-44, 117-120, 219-222, 247-250`

**Context:** When notes fail to fetch during indexing, only error count is incremented. Users cannot debug which notes failed.

**Step 1: Add failed notes tracking to IndexResult type**

In `src/search/indexer.ts`, update the IndexResult interface:

```typescript
export interface IndexResult {
  /** Total notes processed */
  total: number;
  /** Notes successfully indexed */
  indexed: number;
  /** Notes that failed to index */
  errors: number;
  /** Time taken in milliseconds */
  timeMs: number;
  /** Breakdown for incremental indexing */
  breakdown?: {
    added: number;
    updated: number;
    deleted: number;
    skipped: number;
  };
  /** List of notes that failed to index (for debugging) */
  failedNotes?: string[];
}
```

**Step 2: Track failed notes in fullIndex()**

Update the fullIndex function around line 76-120:

```typescript
export async function fullIndex(): Promise<IndexResult> {
  const startTime = Date.now();
  debug("Starting full index...");

  const notes = await getAllNotes();
  debug(`Found ${notes.length} notes in Apple Notes`);

  const records: NoteRecord[] = [];
  let errors = 0;
  const failedNotes: string[] = [];

  for (let i = 0; i < notes.length; i++) {
    const noteInfo = notes[i];
    const notePath = `${noteInfo.folder}/${noteInfo.title}`;
    debug(`Processing ${i + 1}/${notes.length}: ${noteInfo.title}`);

    try {
      const noteDetails = await getNoteByTitle(notePath);
      if (!noteDetails) {
        debug(`Could not fetch note: ${notePath}`);
        failedNotes.push(notePath);
        errors++;
        continue;
      }

      if (!noteDetails.content.trim()) {
        debug(`Skipping empty note: ${notePath}`);
        continue;
      }

      const content = truncateContent(noteDetails.content);
      const vector = await getEmbedding(content);

      const record: NoteRecord = {
        title: noteDetails.title,
        content: noteDetails.content,
        vector,
        folder: noteDetails.folder,
        created: noteDetails.created,
        modified: noteDetails.modified,
        indexed_at: new Date().toISOString(),
      };

      records.push(record);

      if (i < notes.length - 1) {
        await sleep(EMBEDDING_DELAY_MS);
      }
    } catch (error) {
      debug(`Error processing ${notePath}:`, error);
      failedNotes.push(notePath);
      errors++;
    }
  }

  const store = getVectorStore();
  await store.index(records);

  const timeMs = Date.now() - startTime;
  debug(`Full index complete: ${records.length} indexed, ${errors} errors, ${timeMs}ms`);

  return {
    total: notes.length,
    indexed: records.length,
    errors,
    timeMs,
    failedNotes: failedNotes.length > 0 ? failedNotes : undefined,
  };
}
```

**Step 3: Track failed notes in incrementalIndex()**

Update incrementalIndex function around line 210-250:

```typescript
let errors = 0;
const failedNotes: string[] = [];

// Process additions and updates
const toProcess = [...toAdd, ...toUpdate];
for (let i = 0; i < toProcess.length; i++) {
  const noteInfo = toProcess[i];
  const notePath = `${noteInfo.folder}/${noteInfo.title}`;
  debug(`Processing ${i + 1}/${toProcess.length}: ${noteInfo.title}`);

  try {
    const noteDetails = await getNoteByTitle(notePath);
    if (!noteDetails) {
      debug(`Could not fetch note: ${notePath}`);
      failedNotes.push(notePath);
      errors++;
      continue;
    }

    if (!noteDetails.content.trim()) {
      continue;
    }

    const content = truncateContent(noteDetails.content);
    const vector = await getEmbedding(content);

    const record: NoteRecord = {
      title: noteDetails.title,
      content: noteDetails.content,
      vector,
      folder: noteDetails.folder,
      created: noteDetails.created,
      modified: noteDetails.modified,
      indexed_at: new Date().toISOString(),
    };

    await store.update(record);

    if (i < toProcess.length - 1) {
      await sleep(EMBEDDING_DELAY_MS);
    }
  } catch (error) {
    debug(`Error processing ${notePath}:`, error);
    failedNotes.push(notePath);
    errors++;
  }
}

// Process deletions
for (const key of toDelete) {
  try {
    const [, title] = key.split("/");
    await store.delete(title);
  } catch (error) {
    debug(`Error deleting ${key}:`, error);
    failedNotes.push(`DELETE: ${key}`);
    errors++;
  }
}

const timeMs = Date.now() - startTime;
debug(`Incremental index complete: ${timeMs}ms`);

return {
  total: currentNotes.length,
  indexed: toAdd.length + toUpdate.length,
  errors,
  timeMs,
  breakdown: {
    added: toAdd.length,
    updated: toUpdate.length,
    deleted: toDelete.length,
    skipped: toSkip.length,
  },
  failedNotes: failedNotes.length > 0 ? failedNotes : undefined,
};
```

**Step 4: Update index-notes tool handler to show failed notes**

In `src/index.ts`, update the index-notes case (around line 261-276):

```typescript
case "index-notes": {
  const params = IndexNotesSchema.parse(args);
  const result = await indexNotes(params.mode);

  let message = `Indexed ${result.indexed} notes in ${(result.timeMs / 1000).toFixed(1)}s`;

  if (result.breakdown) {
    message += ` (added: ${result.breakdown.added}, updated: ${result.breakdown.updated}, deleted: ${result.breakdown.deleted}, skipped: ${result.breakdown.skipped})`;
  }

  if (result.errors > 0) {
    message += `\n${result.errors} errors occurred.`;
    if (result.failedNotes && result.failedNotes.length > 0) {
      message += `\nFailed notes:\n${result.failedNotes.map(n => `  - ${n}`).join("\n")}`;
    }
  }

  return textResponse(message);
}
```

**Step 5: Verify TypeScript compilation**

Run: `bun run check`
Expected: No errors

**Step 6: Commit**

```bash
git add src/search/indexer.ts src/index.ts
git commit -m "fix: track and report failed notes during indexing

- Add failedNotes array to IndexResult
- Log note path when fetch fails
- Show failed note list in index-notes output
- Fixes silent indexing failures"
```

---

## Task 2: Fix Non-Atomic Update Operation

**Files:**
- Modify: `src/db/lancedb.ts:111-119`

**Context:** Current update() deletes first, then adds. If add fails, record is permanently lost.

**Step 1: Implement atomic update with rollback**

Replace the update method in `src/db/lancedb.ts`:

```typescript
async update(record: NoteRecord): Promise<void> {
  const table = await this.ensureTable();

  // First, try to get existing record for potential rollback
  const existing = await this.getByTitle(record.title);

  // Try to add the new record first (using a temporary unique identifier)
  // If this fails, we haven't deleted anything yet
  try {
    // Delete existing record if it exists
    if (existing) {
      await this.delete(record.title);
    }

    // Add the new record
    await table.add([record]);
    debug(`Updated record: ${record.title}`);
  } catch (error) {
    // If add failed and we deleted the old record, try to restore it
    if (existing) {
      debug(`Update failed, attempting to restore original record: ${record.title}`);
      try {
        await table.add([existing]);
        debug(`Restored original record: ${record.title}`);
      } catch (restoreError) {
        debug(`Failed to restore original record: ${record.title}`, restoreError);
        // Log both errors for debugging
        throw new Error(
          `Update failed and restore failed. Original error: ${error instanceof Error ? error.message : String(error)}. ` +
          `Restore error: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
        );
      }
    }
    throw error;
  }
}
```

**Step 2: Verify TypeScript compilation**

Run: `bun run check`
Expected: No errors

**Step 3: Commit**

```bash
git add src/db/lancedb.ts
git commit -m "fix: make update operation atomic with rollback

- Get existing record before delete
- Attempt restore if add fails after delete
- Prevents data loss on partial failure"
```

---

## Task 3: Fix Empty Catch Blocks

**Files:**
- Modify: `src/search/indexer.ts:155-160`
- Modify: `src/db/lancedb.ts:72-76, 153-160`
- Modify: `src/setup.ts:127-130, 162-164`
- Modify: `src/index.ts:328`

**Step 1: Fix indexer.ts empty catch**

In `src/search/indexer.ts` around line 153-160:

```typescript
// Get existing indexed notes
let existingRecords: NoteRecord[];
try {
  existingRecords = await store.getAll();
} catch (error) {
  // No existing index, fall back to full index
  debug("No existing index found, performing full index. Error:", error);
  return fullIndex();
}
```

**Step 2: Fix lancedb.ts empty catches**

In `src/db/lancedb.ts` around line 72-76 (ensureTable):

```typescript
try {
  return await this.db.openTable(TABLE_NAME);
} catch (error) {
  debug("Table does not exist, will create on first write. Error:", error);
  return null;
}
```

In `src/db/lancedb.ts` around line 153-160 (searchFTS):

```typescript
} catch (error) {
  // FTS might not be available or table empty
  debug("FTS search failed, returning empty results. Error:", error);
  return [];
}
```

**Step 3: Fix setup.ts empty catches**

In `src/setup.ts` around line 127-130 (readClaudeConfig):

```typescript
try {
  const content = fs.readFileSync(CLAUDE_CONFIG_PATH, "utf-8");
  return JSON.parse(content);
} catch (error) {
  // Config doesn't exist or is invalid JSON
  if (process.env.DEBUG === "true") {
    console.error("[SETUP] Could not read Claude config:", error);
  }
  return null;
}
```

In `src/setup.ts` around line 162-164 (addToClaudeConfig):

```typescript
} catch (error) {
  if (process.env.DEBUG === "true") {
    console.error("[SETUP] Failed to write Claude config:", error);
  }
  return false;
}
```

**Step 4: Fix index.ts empty catch in update-note**

In `src/index.ts` around line 324-330:

```typescript
if (params.reindex) {
  try {
    await reindexNote(params.title);
    return textResponse(`Updated and reindexed note: "${params.title}"`);
  } catch (reindexError) {
    debug("Reindex after update failed:", reindexError);
    return textResponse(`Updated note: "${params.title}" (reindexing failed, run index-notes to update)`);
  }
}
```

**Step 5: Verify TypeScript compilation**

Run: `bun run check`
Expected: No errors

**Step 6: Commit**

```bash
git add src/search/indexer.ts src/db/lancedb.ts src/setup.ts src/index.ts
git commit -m "fix: add error logging to all empty catch blocks

- Log errors in indexer, lancedb, setup, and index
- Improves debugging without changing behavior
- 5 catch blocks updated"
```

---

## Task 4: Fix SQL Injection Risk

**Files:**
- Modify: `src/db/lancedb.ts:126-128, 176-180`
- Create: `src/db/validation.ts`

**Step 1: Create input validation module**

Create `src/db/validation.ts`:

```typescript
/**
 * Input validation for database operations.
 */

// Maximum allowed title length
const MAX_TITLE_LENGTH = 500;

// Pattern for allowed characters in titles
// Allows: letters (any language), numbers, spaces, common punctuation
const SAFE_TITLE_PATTERN = /^[\p{L}\p{N}\p{P}\p{Z}]+$/u;

/**
 * Validate and sanitize a note title for database operations.
 *
 * @param title - The title to validate
 * @throws Error if title is invalid
 * @returns Sanitized title safe for database queries
 */
export function validateTitle(title: string): string {
  if (!title || typeof title !== "string") {
    throw new Error("Title must be a non-empty string");
  }

  const trimmed = title.trim();

  if (trimmed.length === 0) {
    throw new Error("Title cannot be empty or whitespace only");
  }

  if (trimmed.length > MAX_TITLE_LENGTH) {
    throw new Error(`Title exceeds maximum length of ${MAX_TITLE_LENGTH} characters`);
  }

  // Check for potentially dangerous characters
  if (!SAFE_TITLE_PATTERN.test(trimmed)) {
    throw new Error("Title contains invalid characters");
  }

  return trimmed;
}

/**
 * Escape a string for use in LanceDB SQL-like filters.
 * Uses comprehensive escaping beyond just single quotes.
 *
 * @param value - The value to escape
 * @returns Escaped string safe for filter expressions
 */
export function escapeForFilter(value: string): string {
  return value
    .replace(/\\/g, "\\\\")  // Escape backslashes first
    .replace(/'/g, "''")      // Escape single quotes
    .replace(/\n/g, "\\n")    // Escape newlines
    .replace(/\r/g, "\\r")    // Escape carriage returns
    .replace(/\t/g, "\\t");   // Escape tabs
}
```

**Step 2: Update lancedb.ts to use validation**

Add import at top of `src/db/lancedb.ts`:

```typescript
import { validateTitle, escapeForFilter } from "./validation.js";
```

Update the delete method (around line 126):

```typescript
async delete(title: string): Promise<void> {
  const table = await this.ensureTable();
  const validTitle = validateTitle(title);
  const escapedTitle = escapeForFilter(validTitle);
  await table.delete(`title = '${escapedTitle}'`);
  debug(`Deleted record: ${title}`);
}
```

Update the getByTitle method (around line 176):

```typescript
async getByTitle(title: string): Promise<NoteRecord | null> {
  const table = await this.ensureTable();
  if (!table) return null;

  const validTitle = validateTitle(title);
  const escapedTitle = escapeForFilter(validTitle);
  const results = await table
    .query()
    .where(`title = '${escapedTitle}'`)
    .limit(1)
    .toArray();

  if (results.length === 0) return null;

  return results[0] as unknown as NoteRecord;
}
```

**Step 3: Verify TypeScript compilation**

Run: `bun run check`
Expected: No errors

**Step 4: Commit**

```bash
git add src/db/validation.ts src/db/lancedb.ts
git commit -m "fix: add input validation to prevent SQL injection

- Create validation.ts with title validation
- Add comprehensive string escaping for filters
- Validate title length and allowed characters"
```

---

## Task 5: Add Limit Validation to Search Schema

**Files:**
- Modify: `src/index.ts:26-32`

**Step 1: Update SearchNotesSchema with bounds**

In `src/index.ts`, update the schema:

```typescript
const SearchNotesSchema = z.object({
  query: z.string().min(1, "Query cannot be empty"),
  folder: z.string().optional(),
  limit: z.number().min(1).max(100).default(20),
  mode: z.enum(["hybrid", "keyword", "semantic"]).default("hybrid"),
  include_content: z.boolean().default(false),
});
```

**Step 2: Verify TypeScript compilation**

Run: `bun run check`
Expected: No errors

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "fix: add validation bounds to search limit parameter

- Minimum: 1, Maximum: 100, Default: 20
- Add min length validation to query"
```

---

## Task 6: Consolidate SearchResult Types

**Files:**
- Create: `src/types/search.ts`
- Modify: `src/db/lancedb.ts`
- Modify: `src/search/index.ts`

**Step 1: Create shared types module**

Create `src/types/search.ts`:

```typescript
/**
 * Shared search-related type definitions.
 */

/**
 * Raw search result from vector database.
 * Contains full note data and search metadata.
 */
export interface DBSearchResult {
  title: string;
  content: string;
  folder: string;
  created: string;
  modified: string;
  /** Distance/similarity score from vector search */
  _distance?: number;
  /** Relevance score from FTS */
  _relevance?: number;
}

/**
 * Public search result returned to MCP clients.
 * Contains formatted data suitable for display.
 */
export interface SearchResult {
  title: string;
  folder: string;
  /** First 200 chars of content */
  preview: string;
  /** Full content (only if include_content: true) */
  content?: string;
  modified: string;
  /** Combined relevance score (0-1, higher is better) */
  score: number;
}
```

**Step 2: Update lancedb.ts to use DBSearchResult**

In `src/db/lancedb.ts`, replace the SearchResult interface and update imports:

```typescript
import { DBSearchResult } from "../types/search.js";
```

Remove the local SearchResult interface and update method signatures:

```typescript
async search(
  queryVector: number[],
  limit: number
): Promise<DBSearchResult[]> {
  // ... implementation stays same, just return type changes
}

async searchFTS(query: string, limit: number): Promise<DBSearchResult[]> {
  // ... implementation stays same, just return type changes
}
```

**Step 3: Update search/index.ts to use both types**

In `src/search/index.ts`, update imports:

```typescript
import { DBSearchResult, SearchResult } from "../types/search.js";
```

Remove the local SearchResult interface. Update the internal functions to use DBSearchResult and keep the public searchNotes returning SearchResult.

**Step 4: Verify TypeScript compilation**

Run: `bun run check`
Expected: No errors

**Step 5: Commit**

```bash
git add src/types/search.ts src/db/lancedb.ts src/search/index.ts
git commit -m "refactor: consolidate SearchResult types

- Create src/types/search.ts with DBSearchResult and SearchResult
- DBSearchResult for internal database results
- SearchResult for public API responses
- Eliminates type name collision"
```

---

## Task 7: Extract Magic Numbers to Constants

**Files:**
- Create: `src/config/constants.ts`
- Modify: `src/search/indexer.ts`
- Modify: `src/search/index.ts`
- Modify: `src/embeddings/openrouter.ts`

**Step 1: Create constants module**

Create `src/config/constants.ts`:

```typescript
/**
 * Centralized configuration constants.
 * All magic numbers should be defined here for easy tuning.
 */

/** Embedding-related constants */
export const EMBEDDING = {
  /** Delay between embedding API calls to avoid rate limiting (ms) */
  DELAY_BETWEEN_CALLS_MS: 300,
  /** Maximum content length before truncation (chars) */
  MAX_CONTENT_LENGTH: 8000,
  /** Maximum retries for API calls */
  MAX_RETRIES: 3,
  /** Cache key length for deduplication */
  CACHE_KEY_LENGTH: 100,
} as const;

/** Search-related constants */
export const SEARCH = {
  /** RRF (Reciprocal Rank Fusion) constant - higher means more weight to lower ranks */
  RRF_K: 60,
  /** Default number of search results */
  DEFAULT_LIMIT: 20,
  /** Maximum allowed search limit */
  MAX_LIMIT: 100,
  /** Preview length for search results (chars) */
  PREVIEW_LENGTH: 200,
} as const;

/** Validation constants */
export const VALIDATION = {
  /** Maximum note title length */
  MAX_TITLE_LENGTH: 500,
} as const;
```

**Step 2: Update indexer.ts to use constants**

In `src/search/indexer.ts`:

```typescript
import { EMBEDDING } from "../config/constants.js";

// Replace:
// const EMBEDDING_DELAY_MS = 300;
// With usage of EMBEDDING.DELAY_BETWEEN_CALLS_MS

// Replace:
// function truncateContent(content: string, maxLength = 8000)
// With:
function truncateContent(content: string, maxLength = EMBEDDING.MAX_CONTENT_LENGTH): string {
```

**Step 3: Update search/index.ts to use constants**

In `src/search/index.ts`:

```typescript
import { SEARCH } from "../config/constants.js";

// Replace:
// const RRF_K = 60;
// With usage of SEARCH.RRF_K

// Replace:
// function truncatePreview(content: string, maxLength = 200)
// With:
function truncatePreview(content: string, maxLength = SEARCH.PREVIEW_LENGTH): string {
```

**Step 4: Update openrouter.ts to use constants**

In `src/embeddings/openrouter.ts`:

```typescript
import { EMBEDDING } from "../config/constants.js";

// Replace local constants with:
const MAX_INPUT_LENGTH = EMBEDDING.MAX_CONTENT_LENGTH;
const MAX_RETRIES = EMBEDDING.MAX_RETRIES;
const CACHE_KEY_LENGTH = EMBEDDING.CACHE_KEY_LENGTH;
```

**Step 5: Verify TypeScript compilation**

Run: `bun run check`
Expected: No errors

**Step 6: Commit**

```bash
git add src/config/constants.ts src/search/indexer.ts src/search/index.ts src/embeddings/openrouter.ts
git commit -m "refactor: extract magic numbers to constants module

- Create src/config/constants.ts
- Centralize EMBEDDING, SEARCH, VALIDATION constants
- Makes tuning parameters easy to find and modify"
```

---

## Task 8: Add Environment Variable Validation

**Files:**
- Create: `src/config/env.ts`
- Modify: `src/index.ts`

**Step 1: Create environment validation module**

Create `src/config/env.ts`:

```typescript
/**
 * Environment variable validation and parsing.
 * Validates all env vars at startup to fail fast on misconfiguration.
 */

import { z } from "zod";

const envSchema = z.object({
  // Embedding provider
  OPENROUTER_API_KEY: z.string().optional(),
  EMBEDDING_MODEL: z.string().default("qwen/qwen3-embedding-8b"),
  EMBEDDING_DIMS: z
    .string()
    .regex(/^\d+$/, "Must be a positive integer")
    .transform(Number)
    .default("4096"),

  // Behavior
  READONLY_MODE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  INDEX_TTL: z
    .string()
    .regex(/^\d+$/, "Must be a positive integer")
    .transform(Number)
    .optional(),

  // Debug
  DEBUG: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

/**
 * Validate and parse environment variables.
 * Caches result for subsequent calls.
 *
 * @throws Error if validation fails with details about invalid variables
 */
export function validateEnv(): Env {
  if (cachedEnv) {
    return cachedEnv;
  }

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.errors
      .map((e) => `  ${e.path.join(".")}: ${e.message}`)
      .join("\n");
    throw new Error(`Environment validation failed:\n${errors}`);
  }

  cachedEnv = result.data;
  return cachedEnv;
}

/**
 * Get validated environment.
 * Call validateEnv() first during startup.
 */
export function getEnv(): Env {
  if (!cachedEnv) {
    return validateEnv();
  }
  return cachedEnv;
}
```

**Step 2: Add validation to server startup**

In `src/index.ts`, add import and call at the top after imports:

```typescript
import { validateEnv } from "./config/env.js";

// Validate environment at startup
try {
  validateEnv();
} catch (error) {
  console.error("Configuration error:", error instanceof Error ? error.message : error);
  process.exit(1);
}
```

**Step 3: Verify TypeScript compilation**

Run: `bun run check`
Expected: No errors

**Step 4: Commit**

```bash
git add src/config/env.ts src/index.ts
git commit -m "feat: add environment variable validation at startup

- Create src/config/env.ts with Zod schema
- Validate all env vars before server starts
- Fail fast with clear error messages"
```

---

## Task 9: Add Unit Tests for Critical Paths

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json`
- Create: `src/db/validation.test.ts`
- Create: `src/search/rrf.test.ts`
- Create: `src/config/env.test.ts`

**Step 1: Add Vitest to dev dependencies**

Run: `bun add -d vitest`

**Step 2: Create Vitest config**

Create `vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      exclude: ["node_modules/", "dist/", "src/setup.ts", "**/*.test.ts"],
    },
  },
});
```

**Step 3: Add test script to package.json**

Add to scripts section:

```json
"test": "vitest run",
"test:watch": "vitest",
"test:coverage": "vitest run --coverage"
```

**Step 4: Create validation tests**

Create `src/db/validation.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { validateTitle, escapeForFilter } from "./validation.js";

describe("validateTitle", () => {
  it("accepts valid titles", () => {
    expect(validateTitle("My Note")).toBe("My Note");
    expect(validateTitle("Work/Project")).toBe("Work/Project");
    expect(validateTitle("Poznámky v češtině")).toBe("Poznámky v češtině");
  });

  it("trims whitespace", () => {
    expect(validateTitle("  Note  ")).toBe("Note");
  });

  it("rejects empty titles", () => {
    expect(() => validateTitle("")).toThrow("non-empty");
    expect(() => validateTitle("   ")).toThrow("empty or whitespace");
  });

  it("rejects titles exceeding max length", () => {
    const longTitle = "a".repeat(501);
    expect(() => validateTitle(longTitle)).toThrow("maximum length");
  });
});

describe("escapeForFilter", () => {
  it("escapes single quotes", () => {
    expect(escapeForFilter("It's a test")).toBe("It''s a test");
  });

  it("escapes backslashes", () => {
    expect(escapeForFilter("path\\to\\file")).toBe("path\\\\to\\\\file");
  });

  it("escapes newlines and tabs", () => {
    expect(escapeForFilter("line1\nline2")).toBe("line1\\nline2");
    expect(escapeForFilter("col1\tcol2")).toBe("col1\\tcol2");
  });

  it("handles combined escaping", () => {
    expect(escapeForFilter("It's a\\path\n")).toBe("It''s a\\\\path\\n");
  });
});
```

**Step 5: Create RRF algorithm tests**

Create `src/search/rrf.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

// Extract RRF function for testing (or import if exported)
function calculateRRFScore(rank: number, k: number = 60): number {
  return 1 / (k + rank);
}

function mergeWithRRF<T extends { title: string }>(
  vectorResults: T[],
  ftsResults: T[],
  k: number = 60
): T[] {
  const scores = new Map<string, { item: T; score: number }>();

  vectorResults.forEach((item, index) => {
    const score = calculateRRFScore(index + 1, k);
    scores.set(item.title, { item, score });
  });

  ftsResults.forEach((item, index) => {
    const score = calculateRRFScore(index + 1, k);
    const existing = scores.get(item.title);
    if (existing) {
      existing.score += score;
    } else {
      scores.set(item.title, { item, score });
    }
  });

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);
}

describe("RRF Algorithm", () => {
  it("calculates correct RRF score", () => {
    expect(calculateRRFScore(1, 60)).toBeCloseTo(1 / 61);
    expect(calculateRRFScore(2, 60)).toBeCloseTo(1 / 62);
  });

  it("merges results with combined scores", () => {
    const vector = [{ title: "A" }, { title: "B" }];
    const fts = [{ title: "B" }, { title: "C" }];

    const merged = mergeWithRRF(vector, fts);

    // B should be first (appears in both)
    expect(merged[0].title).toBe("B");
    expect(merged.length).toBe(3);
  });

  it("handles empty inputs", () => {
    expect(mergeWithRRF([], [])).toEqual([]);
    expect(mergeWithRRF([{ title: "A" }], [])).toEqual([{ title: "A" }]);
  });
});
```

**Step 6: Create env validation tests**

Create `src/config/env.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("Environment Validation", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("accepts valid configuration", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    process.env.DEBUG = "true";

    const { validateEnv } = await import("./env.js");
    const env = validateEnv();

    expect(env.OPENROUTER_API_KEY).toBe("sk-or-test");
    expect(env.DEBUG).toBe(true);
  });

  it("uses defaults for missing optional values", async () => {
    process.env = {};

    const { validateEnv } = await import("./env.js");
    const env = validateEnv();

    expect(env.EMBEDDING_MODEL).toBe("qwen/qwen3-embedding-8b");
    expect(env.EMBEDDING_DIMS).toBe(4096);
    expect(env.READONLY_MODE).toBe(false);
    expect(env.DEBUG).toBe(false);
  });

  it("rejects invalid EMBEDDING_DIMS", async () => {
    process.env.EMBEDDING_DIMS = "not-a-number";

    const { validateEnv } = await import("./env.js");
    expect(() => validateEnv()).toThrow("positive integer");
  });
});
```

**Step 7: Run tests**

Run: `bun run test`
Expected: All tests pass

**Step 8: Commit**

```bash
git add vitest.config.ts package.json src/db/validation.test.ts src/search/rrf.test.ts src/config/env.test.ts
git commit -m "test: add unit tests for critical paths

- Add Vitest configuration
- Test input validation (validation.ts)
- Test RRF algorithm (search)
- Test environment validation (env.ts)"
```

---

## Task 10: Final Cleanup and Verification

**Step 1: Run all checks**

```bash
bun run check    # TypeScript
bun run test     # Unit tests
```

**Step 2: Verify server starts**

```bash
bun run start &
sleep 2
kill $!
echo "Server starts OK"
```

**Step 3: Review git log**

```bash
git log --oneline -10
```

**Step 4: Final commit with updated README if needed**

If any tool behavior changed, update README.md accordingly.

```bash
git add -A
git commit -m "chore: final cleanup after code review fixes"
```

---

## Verification Checklist

After completing all tasks:

- [ ] All TypeScript errors resolved (`bun run check`)
- [ ] All unit tests pass (`bun run test`)
- [ ] Server starts without errors
- [ ] No silent failures in indexing
- [ ] Update operations are atomic
- [ ] All catch blocks log errors
- [ ] Input validation prevents injection
- [ ] Magic numbers are centralized
- [ ] Types are properly consolidated
- [ ] Environment validation at startup

## Summary

| Task | Priority | Estimated Time |
|------|----------|---------------|
| 1. Fix silent indexing failures | P0 | 10 min |
| 2. Fix non-atomic update | P0 | 5 min |
| 3. Fix empty catch blocks | P0 | 10 min |
| 4. Fix SQL injection risk | P1 | 10 min |
| 5. Add limit validation | P1 | 2 min |
| 6. Consolidate SearchResult types | P2 | 10 min |
| 7. Extract magic numbers | P2 | 10 min |
| 8. Add env validation | P3 | 10 min |
| 9. Add unit tests | P3 | 20 min |
| 10. Final verification | - | 5 min |

**Total estimated time: ~90 minutes**
