# Code Review Fixes V2 - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all critical bugs, security issues, and improve test coverage identified in code review.

**Architecture:** TDD approach - write failing tests first, then implement fixes. Group related changes. Extract shared utilities to reduce duplication.

**Tech Stack:** TypeScript, Vitest, Bun, LanceDB, crypto (Node.js built-in)

---

## Summary of Issues to Fix

| # | Category | Issue | File | Priority |
|---|----------|-------|------|----------|
| 1 | Bug | Nested folder title extraction | indexer.ts:267 | Critical |
| 2 | Bug | Cache key collision | openrouter.ts:60 | Critical |
| 3 | Bug | Missing fetch timeout | openrouter.ts:130 | Critical |
| 4 | Bug | Unbounded cache growth | openrouter.ts:37 | High |
| 5 | Security | Overly permissive title pattern | validation.ts:10 | Medium |
| 6 | Security | Information leakage in errors | index.ts:369 | Medium |
| 7 | DRY | Debug function duplicated 9x | multiple files | Medium |
| 8-11 | Tests | Missing test coverage | multiple | High |

---

## Task 1: Fix Nested Folder Title Extraction

**Files:**
- Test: `src/search/indexer.test.ts` (create)
- Modify: `src/search/indexer.ts:267`

**Context:** The key format is `folder/title`. For nested folders like `Work/Projects`, the key becomes `Work/Projects/Note Title`. Current code `const [, title] = key.split("/")` returns "Projects" instead of "Note Title".

**Step 1: Write the failing test**

Create `src/search/indexer.test.ts`:
```typescript
import { describe, it, expect } from "vitest";

// Helper to extract title from key - we'll export this from indexer.ts
import { extractTitleFromKey } from "./indexer.js";

describe("extractTitleFromKey", () => {
  it("extracts title from simple folder/title key", () => {
    expect(extractTitleFromKey("Work/My Note")).toBe("My Note");
  });

  it("extracts title from nested folder key", () => {
    expect(extractTitleFromKey("Work/Projects/My Note")).toBe("My Note");
  });

  it("extracts title from deeply nested folder key", () => {
    expect(extractTitleFromKey("Personal/Archive/2024/January/Meeting Notes")).toBe("Meeting Notes");
  });

  it("handles title with slashes (edge case)", () => {
    // Note: This shouldn't happen in practice as Apple Notes doesn't allow / in titles
    // but we should handle it gracefully
    expect(extractTitleFromKey("Work/Note")).toBe("Note");
  });

  it("handles single segment (no folder)", () => {
    expect(extractTitleFromKey("My Note")).toBe("My Note");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun run test src/search/indexer.test.ts
```
Expected: FAIL with "extractTitleFromKey is not exported"

**Step 3: Implement the fix**

In `src/search/indexer.ts`, add near the top (after imports):
```typescript
/**
 * Extract note title from folder/title key.
 * Handles nested folders correctly by taking the last segment.
 */
export function extractTitleFromKey(key: string): string {
  const parts = key.split("/");
  return parts[parts.length - 1];
}
```

Then update line 267 (in the deletion loop):
```typescript
// Before:
const [, title] = key.split("/");

// After:
const title = extractTitleFromKey(key);
```

**Step 4: Run test to verify it passes**

```bash
bun run test src/search/indexer.test.ts
```
Expected: PASS (5 tests)

**Step 5: Run full test suite and type check**

```bash
bun run check && bun run test
```
Expected: All pass

**Step 6: Commit**

```bash
git add src/search/indexer.ts src/search/indexer.test.ts
git commit -m "fix: extract title correctly from nested folder keys

- Add extractTitleFromKey() helper function
- Fix deletion in incremental index for nested folders
- Add tests for various folder depth scenarios"
```

---

## Task 2: Fix Cache Key Collision

**Files:**
- Test: `src/embeddings/openrouter.test.ts` (create)
- Modify: `src/embeddings/openrouter.ts:60-62`

**Context:** Cache key uses only first 100 characters. Two different notes with identical first 100 chars return wrong cached embeddings. Fix: use SHA-256 hash of full text.

**Step 1: Write the failing test**

Create `src/embeddings/openrouter.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { getCacheKey } from "./openrouter.js";

describe("getCacheKey", () => {
  it("generates different keys for texts with same prefix", () => {
    const prefix = "a".repeat(100);
    const text1 = prefix + " first document content";
    const text2 = prefix + " second document content";

    const key1 = getCacheKey(text1);
    const key2 = getCacheKey(text2);

    expect(key1).not.toBe(key2);
  });

  it("generates same key for identical texts", () => {
    const text = "This is a test document for embedding";
    expect(getCacheKey(text)).toBe(getCacheKey(text));
  });

  it("generates consistent hash format", () => {
    const key = getCacheKey("test");
    // SHA-256 produces 64 hex characters
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun run test src/embeddings/openrouter.test.ts
```
Expected: FAIL - getCacheKey not exported or returns wrong value

**Step 3: Implement the fix**

In `src/embeddings/openrouter.ts`:

1. Add import at top:
```typescript
import { createHash } from "node:crypto";
```

2. Remove old constant:
```typescript
// Remove this line:
const CACHE_KEY_LENGTH = 100;
```

3. Replace getCacheKey function (around line 60):
```typescript
/**
 * Generate cache key from input text using SHA-256 hash.
 * Ensures different texts always produce different keys.
 */
export function getCacheKey(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
```

**Step 4: Run test to verify it passes**

```bash
bun run test src/embeddings/openrouter.test.ts
```
Expected: PASS (3 tests)

**Step 5: Run full test suite and type check**

```bash
bun run check && bun run test
```
Expected: All pass

**Step 6: Commit**

```bash
git add src/embeddings/openrouter.ts src/embeddings/openrouter.test.ts
git commit -m "fix: use SHA-256 hash for embedding cache keys

- Replace truncated prefix with full content hash
- Prevents cache collisions for similar-prefix documents
- Add tests for cache key generation"
```

---

## Task 3: Add Fetch Timeout

**Files:**
- Modify: `src/embeddings/openrouter.ts:130-143`
- Modify: `src/embeddings/openrouter.test.ts`

**Context:** The fetch call has no timeout. `OPENROUTER_TIMEOUT_MS` is defined in constants but never used. Add AbortController with timeout.

**Step 1: Add test for timeout behavior**

Add to `src/embeddings/openrouter.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OPENROUTER_TIMEOUT_MS } from "../config/constants.js";

describe("fetchWithTimeout", () => {
  it("uses correct timeout value from constants", () => {
    // Verify the constant is reasonable (30 seconds)
    expect(OPENROUTER_TIMEOUT_MS).toBe(30000);
  });
});
```

**Step 2: Run test to verify setup**

```bash
bun run test src/embeddings/openrouter.test.ts
```
Expected: PASS

**Step 3: Implement timeout in fetch**

In `src/embeddings/openrouter.ts`:

1. Add import:
```typescript
import { OPENROUTER_TIMEOUT_MS } from "../config/constants.js";
```

2. Update the fetch call (around line 130):
```typescript
// Create abort controller for timeout
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);

try {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/apple-notes-mcp",
      "X-Title": "Apple Notes MCP",
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: truncatedText,
      dimensions: EMBEDDING_DIMS,
    }),
    signal: controller.signal,
  });

  // ... rest of response handling
} finally {
  clearTimeout(timeoutId);
}
```

3. Add error handling for abort in the catch block:
```typescript
} catch (error) {
  if (error instanceof Error && error.name === "AbortError") {
    debug(`Request timed out after ${OPENROUTER_TIMEOUT_MS}ms`);
    throw new OpenRouterError(
      `Request timed out after ${OPENROUTER_TIMEOUT_MS}ms`,
      408
    );
  }
  // ... rest of error handling
}
```

**Step 4: Run full test suite and type check**

```bash
bun run check && bun run test
```
Expected: All pass

**Step 5: Commit**

```bash
git add src/embeddings/openrouter.ts src/embeddings/openrouter.test.ts
git commit -m "fix: add timeout to OpenRouter API calls

- Use AbortController with OPENROUTER_TIMEOUT_MS (30s)
- Properly clean up timeout on success
- Throw OpenRouterError on timeout with 408 status"
```

---

## Task 4: Add LRU Cache with Size Limit

**Files:**
- Modify: `src/embeddings/openrouter.ts:37`
- Modify: `src/config/constants.ts`
- Test: `src/embeddings/openrouter.test.ts`

**Context:** The embedding cache `Map<string, number[]>` has no size limit and can grow unbounded, causing memory issues over time.

**Step 1: Add constant for cache size**

In `src/config/constants.ts`, add:
```typescript
// Cache settings
export const EMBEDDING_CACHE_MAX_SIZE = 1000; // Max cached embeddings
```

**Step 2: Add test for cache eviction**

Add to `src/embeddings/openrouter.test.ts`:
```typescript
import { getEmbeddingCacheSize, clearEmbeddingCache } from "./openrouter.js";
import { EMBEDDING_CACHE_MAX_SIZE } from "../config/constants.js";

describe("embedding cache", () => {
  beforeEach(() => {
    clearEmbeddingCache();
  });

  it("has a maximum size limit", () => {
    expect(EMBEDDING_CACHE_MAX_SIZE).toBe(1000);
  });

  it("provides cache size getter", () => {
    expect(getEmbeddingCacheSize()).toBe(0);
  });
});
```

**Step 3: Implement LRU cache**

In `src/embeddings/openrouter.ts`:

1. Add import:
```typescript
import { EMBEDDING_CACHE_MAX_SIZE } from "../config/constants.js";
```

2. Replace the cache implementation:
```typescript
/**
 * Simple LRU cache for embeddings.
 * Evicts oldest entries when max size is reached.
 */
class LRUCache<K, V> {
  private cache = new Map<K, V>();

  constructor(private maxSize: number) {}

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    // Delete if exists (to update position)
    this.cache.delete(key);

    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
        debug(`Cache evicted oldest entry, size: ${this.cache.size}`);
      }
    }

    this.cache.set(key, value);
  }

  get size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }
}

// Embedding cache with LRU eviction
const embeddingCache = new LRUCache<string, number[]>(EMBEDDING_CACHE_MAX_SIZE);

/**
 * Get current cache size (for monitoring)
 */
export function getEmbeddingCacheSize(): number {
  return embeddingCache.size;
}

/**
 * Clear the embedding cache (for testing)
 */
export function clearEmbeddingCache(): void {
  embeddingCache.clear();
}
```

3. Update cache usage in `getOpenRouterEmbedding`:
```typescript
// Check cache (use .get() method)
const cached = embeddingCache.get(cacheKey);
if (cached) {
  debug("Cache hit");
  return cached;
}

// ... after getting embedding ...

// Cache the result (use .set() method)
embeddingCache.set(cacheKey, embedding);
```

**Step 4: Run tests**

```bash
bun run check && bun run test
```
Expected: All pass

**Step 5: Commit**

```bash
git add src/embeddings/openrouter.ts src/config/constants.ts src/embeddings/openrouter.test.ts
git commit -m "fix: add LRU cache with size limit for embeddings

- Implement simple LRU cache class
- Limit cache to 1000 entries (EMBEDDING_CACHE_MAX_SIZE)
- Evict oldest entries when full
- Add cache size getter and clear functions"
```

---

## Task 5: Restrict Title Pattern

**Files:**
- Modify: `src/db/validation.ts:10`
- Modify: `src/db/validation.test.ts`

**Context:** Current pattern `\p{P}` allows all Unicode punctuation including potentially dangerous characters. Restrict to common safe punctuation.

**Step 1: Add test for restricted characters**

Add to `src/db/validation.test.ts`:
```typescript
describe("validateTitle - restricted punctuation", () => {
  it("allows common safe punctuation", () => {
    expect(validateTitle("Note: My Title")).toBe("Note: My Title");
    expect(validateTitle("Meeting (2024-01-08)")).toBe("Meeting (2024-01-08)");
    expect(validateTitle("Q&A Session")).toBe("Q&A Session");
    expect(validateTitle("To-Do List")).toBe("To-Do List");
    expect(validateTitle("Notes #1")).toBe("Notes #1");
    expect(validateTitle("50% Complete!")).toBe("50% Complete!");
  });

  it("rejects backticks", () => {
    expect(() => validateTitle("Note `code` here")).toThrow("invalid characters");
  });

  it("rejects pipe character", () => {
    expect(() => validateTitle("Option A | Option B")).toThrow("invalid characters");
  });

  it("rejects angle brackets", () => {
    expect(() => validateTitle("Note <script>")).toThrow("invalid characters");
    expect(() => validateTitle("A > B")).toThrow("invalid characters");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun run test src/db/validation.test.ts
```
Expected: FAIL - backticks and pipes currently allowed

**Step 3: Update the pattern**

In `src/db/validation.ts`, replace line 10:
```typescript
// Before:
const SAFE_TITLE_PATTERN = /^[\p{L}\p{N}\p{P}\p{Z}]+$/u;

// After - explicit safe punctuation only:
// Allows: letters, numbers, spaces, and safe punctuation: . , ! ? ; : - _ ( ) [ ] { } ' " @ # $ % & * + = ~
const SAFE_TITLE_PATTERN = /^[\p{L}\p{N}\p{Z}.,!?;:\-_()[\]{}'\"@#$%&*+=~]+$/u;
```

**Step 4: Run tests**

```bash
bun run test src/db/validation.test.ts
```
Expected: All pass

**Step 5: Commit**

```bash
git add src/db/validation.ts src/db/validation.test.ts
git commit -m "security: restrict allowed punctuation in titles

- Replace broad \\p{P} with explicit safe character set
- Block backticks, pipes, angle brackets
- Allow common punctuation: . , ! ? ; : - _ ( ) etc."
```

---

## Task 6: Sanitize Error Messages

**Files:**
- Create: `src/utils/errors.ts`
- Modify: `src/index.ts:369`
- Test: `src/utils/errors.test.ts`

**Context:** Raw error messages are passed to clients, potentially leaking internal paths and implementation details.

**Step 1: Create error utility with test**

Create `src/utils/errors.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { sanitizeErrorMessage } from "./errors.js";

describe("sanitizeErrorMessage", () => {
  it("preserves user-friendly messages", () => {
    expect(sanitizeErrorMessage("Note not found")).toBe("Note not found");
    expect(sanitizeErrorMessage("Invalid title")).toBe("Invalid title");
  });

  it("removes file paths", () => {
    const error = "ENOENT: no such file at /Users/john/secret/file.ts";
    expect(sanitizeErrorMessage(error)).not.toContain("/Users/john");
  });

  it("removes stack traces", () => {
    const error = "Error: failed\n    at Function.module (/path/to/file.js:123:45)";
    expect(sanitizeErrorMessage(error)).not.toContain("/path/to");
    expect(sanitizeErrorMessage(error)).not.toContain(":123:45");
  });

  it("handles generic errors gracefully", () => {
    const error = "TypeError: Cannot read property 'x' of undefined";
    const sanitized = sanitizeErrorMessage(error);
    expect(sanitized).toBe("An internal error occurred");
  });

  it("preserves known safe error patterns", () => {
    expect(sanitizeErrorMessage("Title must be a non-empty string")).toBe("Title must be a non-empty string");
    expect(sanitizeErrorMessage("Note not found: \"My Note\"")).toBe("Note not found: \"My Note\"");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun run test src/utils/errors.test.ts
```
Expected: FAIL - module not found

**Step 3: Implement error sanitizer**

Create `src/utils/errors.ts`:
```typescript
/**
 * Error message sanitization for client responses.
 * Removes internal paths and implementation details.
 */

// Patterns that indicate safe, user-facing error messages
const SAFE_ERROR_PATTERNS = [
  /^Note not found/,
  /^Title must be/,
  /^Title cannot be/,
  /^Title exceeds/,
  /^Title contains/,
  /^Invalid arguments/,
  /^Query cannot be empty/,
  /^READONLY_MODE is enabled/,
  /^Add confirm: true/,
  /^Multiple notes found/,
  /^Folder not found/,
];

// Patterns that indicate internal errors (should be sanitized)
const INTERNAL_ERROR_PATTERNS = [
  /\/[a-zA-Z]+\/[a-zA-Z]+\//,  // File paths like /Users/x/y/
  /at\s+\S+\s+\(/,              // Stack traces
  /:\d+:\d+\)/,                 // Line:column references
  /TypeError:/,
  /ReferenceError:/,
  /ENOENT:/,
  /EACCES:/,
];

/**
 * Sanitize an error message for client consumption.
 * Removes internal paths and implementation details.
 */
export function sanitizeErrorMessage(message: string): string {
  // Check if it's a known safe error message
  for (const pattern of SAFE_ERROR_PATTERNS) {
    if (pattern.test(message)) {
      return message;
    }
  }

  // Check if it contains internal error patterns
  for (const pattern of INTERNAL_ERROR_PATTERNS) {
    if (pattern.test(message)) {
      return "An internal error occurred";
    }
  }

  // Default: return first line only, up to 200 chars
  const firstLine = message.split("\n")[0];
  return firstLine.substring(0, 200);
}
```

**Step 4: Run tests**

```bash
bun run test src/utils/errors.test.ts
```
Expected: All pass

**Step 5: Update index.ts to use sanitizer**

In `src/index.ts`:

1. Add import:
```typescript
import { sanitizeErrorMessage } from "./utils/errors.js";
```

2. Update the error handling (around line 369):
```typescript
// Before:
const message = error instanceof Error ? error.message : String(error);
debug("Tool error:", error);
return errorResponse(message);

// After:
const rawMessage = error instanceof Error ? error.message : String(error);
debug("Tool error:", error);  // Full error in debug log
return errorResponse(sanitizeErrorMessage(rawMessage));
```

**Step 6: Run full tests and type check**

```bash
bun run check && bun run test
```
Expected: All pass

**Step 7: Commit**

```bash
git add src/utils/errors.ts src/utils/errors.test.ts src/index.ts
git commit -m "security: sanitize error messages for clients

- Create sanitizeErrorMessage() utility
- Remove file paths and stack traces from responses
- Preserve known safe error messages
- Keep full errors in debug logs"
```

---

## Task 7: Extract Debug Function to Shared Utility

**Files:**
- Create: `src/utils/debug.ts`
- Modify: 9 files that have duplicate debug function

**Context:** The same debug function pattern is duplicated in 9 files. Extract to shared utility.

**Step 1: Create shared debug utility**

Create `src/utils/debug.ts`:
```typescript
/**
 * Shared debug logging utility.
 * Logs to stderr to avoid polluting stdout/MCP protocol.
 */

const IS_DEBUG = process.env.DEBUG === "true";

/**
 * Create a debug logger with a specific prefix.
 *
 * @param prefix - Module identifier (e.g., "INDEX", "SEARCH")
 * @returns Debug logging function
 *
 * @example
 * const debug = createDebugLogger("SEARCH");
 * debug("Starting search...", query);
 */
export function createDebugLogger(prefix: string) {
  return (...args: unknown[]): void => {
    if (IS_DEBUG) {
      console.error(`[${prefix}]`, ...args);
    }
  };
}

/**
 * Check if debug mode is enabled.
 */
export function isDebugEnabled(): boolean {
  return IS_DEBUG;
}
```

**Step 2: Update all files to use shared utility**

Replace the debug function in each file:

**src/index.ts:**
```typescript
// Remove:
const DEBUG = process.env.DEBUG === "true";
function debug(...args: unknown[]) {
  if (DEBUG) {
    console.error("[DEBUG]", ...args);
  }
}

// Add:
import { createDebugLogger } from "./utils/debug.js";
const debug = createDebugLogger("MCP");
```

**src/db/lancedb.ts:**
```typescript
import { createDebugLogger } from "../utils/debug.js";
const debug = createDebugLogger("DB");
```

**src/search/indexer.ts:**
```typescript
import { createDebugLogger } from "../utils/debug.js";
const debug = createDebugLogger("INDEX");
```

**src/search/index.ts:**
```typescript
import { createDebugLogger } from "../utils/debug.js";
const debug = createDebugLogger("SEARCH");
```

**src/notes/read.ts:**
```typescript
import { createDebugLogger } from "../utils/debug.js";
const debug = createDebugLogger("NOTES");
```

**src/notes/crud.ts:**
```typescript
import { createDebugLogger } from "../utils/debug.js";
const debug = createDebugLogger("CRUD");
```

**src/embeddings/index.ts:**
```typescript
import { createDebugLogger } from "../utils/debug.js";
const debug = createDebugLogger("EMBED");
```

**src/embeddings/local.ts:**
```typescript
import { createDebugLogger } from "../utils/debug.js";
const debug = createDebugLogger("LOCAL");
```

**src/embeddings/openrouter.ts:**
```typescript
import { createDebugLogger } from "../utils/debug.js";
const debug = createDebugLogger("OPENROUTER");
```

**Step 3: Run full tests and type check**

```bash
bun run check && bun run test
```
Expected: All pass

**Step 4: Commit**

```bash
git add src/utils/debug.ts src/index.ts src/db/lancedb.ts src/search/indexer.ts src/search/index.ts src/notes/read.ts src/notes/crud.ts src/embeddings/index.ts src/embeddings/local.ts src/embeddings/openrouter.ts
git commit -m "refactor: extract debug function to shared utility

- Create createDebugLogger() factory in src/utils/debug.ts
- Replace duplicate debug functions in 9 files
- Use module-specific prefixes (MCP, DB, SEARCH, etc.)"
```

---

## Task 8: Add Tests for Search Module

**Files:**
- Create: `src/search/index.test.ts`

**Step 1: Create search tests**

Create `src/search/index.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { rrfScore, generatePreview, filterByFolder } from "./index.js";
import { DBSearchResult } from "../types/index.js";

describe("rrfScore", () => {
  it("calculates RRF score correctly", () => {
    // RRF formula: 1 / (k + rank) where k = 60
    expect(rrfScore(1)).toBeCloseTo(1 / 61, 5);
    expect(rrfScore(10)).toBeCloseTo(1 / 70, 5);
  });

  it("returns smaller scores for higher ranks", () => {
    expect(rrfScore(1)).toBeGreaterThan(rrfScore(10));
    expect(rrfScore(10)).toBeGreaterThan(rrfScore(100));
  });
});

describe("generatePreview", () => {
  it("returns full text if shorter than limit", () => {
    const text = "Short text";
    expect(generatePreview(text)).toBe("Short text");
  });

  it("truncates long text with ellipsis", () => {
    const text = "a".repeat(300);
    const preview = generatePreview(text);
    expect(preview.length).toBeLessThanOrEqual(203); // 200 + "..."
    expect(preview).toMatch(/\.\.\.$/);
  });

  it("preserves word boundaries when truncating", () => {
    const text = "This is a sentence with multiple words that goes on and on " + "x".repeat(200);
    const preview = generatePreview(text);
    // Should not cut in middle of a word
    expect(preview).not.toMatch(/[a-z]\.\.\.$/); // Not ending with letter...
  });

  it("handles empty content", () => {
    expect(generatePreview("")).toBe("");
    expect(generatePreview("   ")).toBe("");
  });
});

describe("filterByFolder", () => {
  const mockResults: DBSearchResult[] = [
    { title: "Note 1", folder: "Work", content: "content", score: 1, modified: "2024-01-01" },
    { title: "Note 2", folder: "Personal", content: "content", score: 0.9, modified: "2024-01-01" },
    { title: "Note 3", folder: "Work/Projects", content: "content", score: 0.8, modified: "2024-01-01" },
  ];

  it("filters by exact folder name", () => {
    const filtered = filterByFolder(mockResults, "Work");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].title).toBe("Note 1");
  });

  it("filters by nested folder", () => {
    const filtered = filterByFolder(mockResults, "Work/Projects");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].title).toBe("Note 3");
  });

  it("is case-insensitive", () => {
    const filtered = filterByFolder(mockResults, "work");
    expect(filtered).toHaveLength(1);
  });

  it("returns all results when folder is undefined", () => {
    const filtered = filterByFolder(mockResults, undefined);
    expect(filtered).toHaveLength(3);
  });
});
```

**Step 2: Export functions for testing**

In `src/search/index.ts`, ensure these are exported:
```typescript
export { rrfScore, generatePreview, filterByFolder };
```

**Step 3: Run tests**

```bash
bun run test src/search/index.test.ts
```
Expected: All pass

**Step 4: Commit**

```bash
git add src/search/index.ts src/search/index.test.ts
git commit -m "test: add unit tests for search module

- Test rrfScore() calculation
- Test generatePreview() truncation and word boundaries
- Test filterByFolder() exact, nested, and case-insensitive matching"
```

---

## Task 9: Add Tests for Environment Validation

**Files:**
- Create: `src/config/env.test.ts`

**Step 1: Create env validation tests**

Create `src/config/env.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { validateEnv } from "./env.js";

describe("validateEnv", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("accepts valid configuration", () => {
    process.env.DEBUG = "true";
    process.env.READONLY_MODE = "false";
    expect(() => validateEnv()).not.toThrow();
  });

  it("accepts empty configuration", () => {
    // All fields are optional
    process.env = {};
    expect(() => validateEnv()).not.toThrow();
  });

  it("validates OPENROUTER_API_KEY format", () => {
    process.env.OPENROUTER_API_KEY = "invalid-key";
    expect(() => validateEnv()).toThrow();

    process.env.OPENROUTER_API_KEY = "sk-or-valid-key-123";
    expect(() => validateEnv()).not.toThrow();
  });

  it("validates EMBEDDING_DIMS is numeric", () => {
    process.env.EMBEDDING_DIMS = "not-a-number";
    expect(() => validateEnv()).toThrow();

    process.env.EMBEDDING_DIMS = "4096";
    expect(() => validateEnv()).not.toThrow();
  });

  it("validates INDEX_TTL is numeric", () => {
    process.env.INDEX_TTL = "abc";
    expect(() => validateEnv()).toThrow();

    process.env.INDEX_TTL = "86400";
    expect(() => validateEnv()).not.toThrow();
  });

  it("validates DEBUG is boolean string", () => {
    process.env.DEBUG = "yes";
    expect(() => validateEnv()).toThrow();

    process.env.DEBUG = "true";
    expect(() => validateEnv()).not.toThrow();
  });

  it("validates READONLY_MODE is boolean string", () => {
    process.env.READONLY_MODE = "1";
    expect(() => validateEnv()).toThrow();

    process.env.READONLY_MODE = "true";
    expect(() => validateEnv()).not.toThrow();
  });
});
```

**Step 2: Run tests**

```bash
bun run test src/config/env.test.ts
```
Expected: All pass

**Step 3: Commit**

```bash
git add src/config/env.test.ts
git commit -m "test: add unit tests for environment validation

- Test valid and empty configurations
- Test API key format validation
- Test numeric field validation (EMBEDDING_DIMS, INDEX_TTL)
- Test boolean string validation (DEBUG, READONLY_MODE)"
```

---

## Task 10: Add Tests for LanceDB Operations

**Files:**
- Create: `src/db/lancedb.test.ts`

**Step 1: Create LanceDB tests**

Create `src/db/lancedb.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LanceDBStore, NoteRecord } from "./lancedb.js";
import * as fs from "node:fs";
import * as path from "node:path";

describe("LanceDBStore", () => {
  let store: LanceDBStore;
  let testDbPath: string;

  beforeEach(() => {
    // Use temp directory for test database
    testDbPath = path.join("/tmp", `lancedb-test-${Date.now()}`);
    store = new LanceDBStore(testDbPath);
  });

  afterEach(async () => {
    // Clean up test database
    if (fs.existsSync(testDbPath)) {
      fs.rmSync(testDbPath, { recursive: true, force: true });
    }
  });

  const createTestRecord = (title: string): NoteRecord => ({
    title,
    folder: "Test",
    content: `Content of ${title}`,
    modified: new Date().toISOString(),
    created: new Date().toISOString(),
    indexed_at: new Date().toISOString(),
    vector: Array(384).fill(0.1), // Mock embedding
  });

  describe("add and getByTitle", () => {
    it("adds and retrieves a record", async () => {
      const record = createTestRecord("Test Note");
      await store.add([record]);

      const retrieved = await store.getByTitle("Test Note");
      expect(retrieved).not.toBeNull();
      expect(retrieved?.title).toBe("Test Note");
      expect(retrieved?.folder).toBe("Test");
    });

    it("returns null for non-existent title", async () => {
      const retrieved = await store.getByTitle("Does Not Exist");
      expect(retrieved).toBeNull();
    });
  });

  describe("update", () => {
    it("updates existing record", async () => {
      const record = createTestRecord("Update Test");
      await store.add([record]);

      const updated = { ...record, content: "Updated content" };
      await store.update(updated);

      const retrieved = await store.getByTitle("Update Test");
      expect(retrieved?.content).toBe("Updated content");
    });

    it("adds record if not exists", async () => {
      const record = createTestRecord("New Note");
      await store.update(record);

      const retrieved = await store.getByTitle("New Note");
      expect(retrieved).not.toBeNull();
    });
  });

  describe("delete", () => {
    it("deletes existing record", async () => {
      const record = createTestRecord("Delete Test");
      await store.add([record]);

      await store.delete("Delete Test");

      const retrieved = await store.getByTitle("Delete Test");
      expect(retrieved).toBeNull();
    });

    it("handles deletion of non-existent record", async () => {
      // Should not throw
      await expect(store.delete("Does Not Exist")).resolves.not.toThrow();
    });
  });

  describe("count", () => {
    it("returns correct count", async () => {
      expect(await store.count()).toBe(0);

      await store.add([
        createTestRecord("Note 1"),
        createTestRecord("Note 2"),
      ]);

      expect(await store.count()).toBe(2);
    });
  });
});
```

**Step 2: Update LanceDBStore to accept custom path**

In `src/db/lancedb.ts`, modify the constructor:
```typescript
export class LanceDBStore implements VectorStore {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || DB_PATH;
  }

  // Update ensureTable to use this.dbPath
  private async ensureTable(): Promise<lancedb.Table> {
    if (!this.table) {
      this.db = await lancedb.connect(this.dbPath);
      // ... rest of method
    }
    return this.table;
  }
}
```

**Step 3: Run tests**

```bash
bun run test src/db/lancedb.test.ts
```
Expected: All pass

**Step 4: Commit**

```bash
git add src/db/lancedb.ts src/db/lancedb.test.ts
git commit -m "test: add unit tests for LanceDB operations

- Test add and getByTitle
- Test update (existing and new records)
- Test delete (existing and non-existent)
- Test count
- Support custom DB path for isolated tests"
```

---

## Task 11: Final Verification

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

**Step 3: Check test coverage summary**

```bash
bun run test --reporter=verbose
```

**Step 4: Review git log**

```bash
git log --oneline -15
```

**Step 5: Final commit with plan doc**

```bash
git add docs/plans/2026-01-08-code-review-fixes-v2.md
git commit -m "docs: add code review fixes v2 implementation plan"
```

---

## Summary

| Task | Description | Type |
|------|-------------|------|
| 1 | Fix nested folder title extraction | Bug fix |
| 2 | Fix cache key collision with SHA-256 | Bug fix |
| 3 | Add fetch timeout | Bug fix |
| 4 | Add LRU cache with size limit | Bug fix |
| 5 | Restrict title pattern | Security |
| 6 | Sanitize error messages | Security |
| 7 | Extract debug function | DRY refactor |
| 8 | Add search module tests | Test coverage |
| 9 | Add env validation tests | Test coverage |
| 10 | Add LanceDB tests | Test coverage |
| 11 | Final verification | Verification |

**Total: 11 tasks**
