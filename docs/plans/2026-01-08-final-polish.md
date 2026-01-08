# Final Polish Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix remaining low-priority issues and consolidate magic numbers for cleaner codebase.

**Architecture:** Bug fixes + constant consolidation. No structural changes.

**Tech Stack:** TypeScript, Vitest

---

## Task 1: Fix Cache Key - Compute After Truncation

**Files:**
- Modify: `src/embeddings/openrouter.ts:145,155`

**Problem:** Cache key is computed from original text, but embedding is generated from truncated text. Different full texts that truncate to the same result don't share cache.

**Step 1: Move truncation before cache key generation**

In `src/embeddings/openrouter.ts`, change lines 144-155 from:

```typescript
// Check cache first
const cacheKey = getCacheKey(text);
const cached = embeddingCache.get(cacheKey);
if (cached) {
  debug(`Cache hit for key: "${cacheKey.substring(0, 30)}..."`);
  return cached;
}

debug(`Cache miss, fetching embedding for: "${cacheKey.substring(0, 30)}..."`);

// Truncate input to max length
const truncatedText = truncateInput(text);
```

To:

```typescript
// Truncate input first - cache key must match actual embedded text
const truncatedText = truncateInput(text);

// Check cache using truncated text hash
const cacheKey = getCacheKey(truncatedText);
const cached = embeddingCache.get(cacheKey);
if (cached) {
  debug(`Cache hit for key: "${cacheKey.substring(0, 16)}..."`);
  return cached;
}

debug(`Cache miss, fetching embedding for: "${cacheKey.substring(0, 16)}..."`);
```

**Step 2: Run tests**

```bash
npm test
```

**Step 3: Commit**

```bash
git add src/embeddings/openrouter.ts
git commit -m "fix: compute cache key after truncation for better cache hits"
```

---

## Task 2: Fix Timeout Not Cleared Before Continue

**Files:**
- Modify: `src/embeddings/openrouter.ts:184-190`

**Problem:** On rate limit (429), the code calls `continue` without clearing the timeout first. The timeout fires during sleep (benign but wasteful).

**Step 1: Clear timeout before continue**

In `src/embeddings/openrouter.ts`, change lines 184-190 from:

```typescript
// Handle rate limiting
if (response.status === 429) {
  const waitTime = getBackoffDelay(attempt, 2000); // Longer base delay for rate limits
  debug(`Rate limited (429), waiting ${waitTime}ms before retry`);
  await sleep(waitTime);
  continue;
}
```

To:

```typescript
// Handle rate limiting
if (response.status === 429) {
  clearTimeout(timeoutId); // Clear timeout before sleeping
  const waitTime = getBackoffDelay(attempt, 2000); // Longer base delay for rate limits
  debug(`Rate limited (429), waiting ${waitTime}ms before retry`);
  await sleep(waitTime);
  continue;
}
```

**Step 2: Run tests**

```bash
npm test
```

**Step 3: Commit**

```bash
git add src/embeddings/openrouter.ts
git commit -m "fix: clear timeout before rate limit sleep"
```

---

## Task 3: Remove Redundant Null Check

**Files:**
- Modify: `src/db/lancedb.ts:202-204`

**Problem:** `ensureTable()` never returns null, only throws. The null check at line 204 is dead code.

**Step 1: Remove redundant check**

In `src/db/lancedb.ts`, change lines 202-205 from:

```typescript
async getByTitle(title: string): Promise<NoteRecord | null> {
  const table = await this.ensureTable();
  if (!table) return null;

  const validTitle = validateTitle(title);
```

To:

```typescript
async getByTitle(title: string): Promise<NoteRecord | null> {
  const table = await this.ensureTable();

  const validTitle = validateTitle(title);
```

**Step 2: Run tests**

```bash
npm test
```

**Step 3: Commit**

```bash
git add src/db/lancedb.ts
git commit -m "refactor: remove redundant null check in getByTitle"
```

---

## Task 4: Consolidate Magic Numbers to Constants

**Files:**
- Modify: `src/config/constants.ts` - add new constants
- Modify: `src/embeddings/openrouter.ts` - use constants
- Modify: `src/search/indexer.ts` - use constants
- Modify: `src/search/index.ts` - use constants
- Modify: `src/db/validation.ts` - use constants
- Modify: `src/utils/errors.ts` - use constants

**Step 1: Add new constants to config/constants.ts**

Add at the end of `src/config/constants.ts`:

```typescript
// Input processing
export const MAX_INPUT_LENGTH = 8000;
export const MAX_TITLE_LENGTH = 500;
export const ERROR_MESSAGE_MAX_LENGTH = 200;

// Retry and backoff
export const MAX_RETRIES = 3;
export const RATE_LIMIT_BACKOFF_BASE_MS = 2000;

// Indexing
export const EMBEDDING_DELAY_MS = 300;

// Search tuning
export const HYBRID_SEARCH_MIN_FETCH = 40;
export const FOLDER_FILTER_MULTIPLIER = 3;
export const PREVIEW_TRUNCATE_RATIO = 0.7;
```

**Step 2: Update openrouter.ts**

Replace local constants with imports. Change lines 22-25:

```typescript
// Constants
const API_URL = "https://openrouter.ai/api/v1/embeddings";
const MAX_INPUT_LENGTH = 8000;
const MAX_RETRIES = 3;
```

To:

```typescript
import { ..., MAX_INPUT_LENGTH, MAX_RETRIES, RATE_LIMIT_BACKOFF_BASE_MS } from "../config/constants.js";

// Constants
const API_URL = "https://openrouter.ai/api/v1/embeddings";
```

Update line 186 from:

```typescript
const waitTime = getBackoffDelay(attempt, 2000);
```

To:

```typescript
const waitTime = getBackoffDelay(attempt, RATE_LIMIT_BACKOFF_BASE_MS);
```

**Step 3: Update indexer.ts**

Add import and use constant. Change line 28:

```typescript
const EMBEDDING_DELAY_MS = 300;
```

To import from constants:

```typescript
import { EMBEDDING_DELAY_MS, MAX_INPUT_LENGTH } from "../config/constants.js";
```

Change line 63:

```typescript
function truncateContent(content: string, maxLength = 8000): string {
```

To:

```typescript
function truncateContent(content: string, maxLength = MAX_INPUT_LENGTH): string {
```

**Step 4: Update search/index.ts**

Add imports and use constants. Change line 71:

```typescript
if (lastSpace > maxLength * 0.7) {
```

To:

```typescript
import { ..., HYBRID_SEARCH_MIN_FETCH, FOLDER_FILTER_MULTIPLIER, PREVIEW_TRUNCATE_RATIO } from "../config/constants.js";

// In generatePreview function:
if (lastSpace > maxLength * PREVIEW_TRUNCATE_RATIO) {
```

Change line 109:

```typescript
const fetchLimit = folder ? limit * 3 : limit;
```

To:

```typescript
const fetchLimit = folder ? limit * FOLDER_FILTER_MULTIPLIER : limit;
```

Change line 149:

```typescript
const fetchLimit = Math.max(limit * 2, 40);
```

To:

```typescript
const fetchLimit = Math.max(limit * 2, HYBRID_SEARCH_MIN_FETCH);
```

**Step 5: Update validation.ts**

Add import and use constant. Change line 6:

```typescript
const MAX_TITLE_LENGTH = 500;
```

To:

```typescript
import { MAX_TITLE_LENGTH } from "../config/constants.js";
```

**Step 6: Update errors.ts**

Add import and use constant. Change line 43:

```typescript
return firstLine.substring(0, 200);
```

To:

```typescript
import { ERROR_MESSAGE_MAX_LENGTH } from "../config/constants.js";

// In sanitizeErrorMessage:
return firstLine.substring(0, ERROR_MESSAGE_MAX_LENGTH);
```

**Step 7: Run tests**

```bash
npm test
```

**Step 8: Commit**

```bash
git add src/config/constants.ts src/embeddings/openrouter.ts src/search/indexer.ts src/search/index.ts src/db/validation.ts src/utils/errors.ts
git commit -m "refactor: consolidate magic numbers into constants.ts"
```

---

## Task 5: Extract Shared Truncation Utility

**Files:**
- Create: `src/utils/text.ts`
- Modify: `src/embeddings/openrouter.ts` - use shared utility
- Modify: `src/search/indexer.ts` - use shared utility

**Step 1: Create shared text utility**

Create `src/utils/text.ts`:

```typescript
/**
 * Text processing utilities.
 */

import { MAX_INPUT_LENGTH } from "../config/constants.js";
import { createDebugLogger } from "./debug.js";

const debug = createDebugLogger("TEXT");

/**
 * Truncate text to maximum allowed length for embedding models.
 *
 * @param text - Text to truncate
 * @param maxLength - Maximum length (default: MAX_INPUT_LENGTH from constants)
 * @returns Truncated text
 */
export function truncateForEmbedding(text: string, maxLength = MAX_INPUT_LENGTH): string {
  if (text.length <= maxLength) {
    return text;
  }
  debug(`Truncating text from ${text.length} to ${maxLength} chars`);
  return text.substring(0, maxLength);
}
```

**Step 2: Update openrouter.ts**

Remove local `truncateInput` function and import shared one:

```typescript
import { truncateForEmbedding } from "../utils/text.js";
```

Replace calls to `truncateInput(text)` with `truncateForEmbedding(text)`.

Delete the local function (lines 98-107):

```typescript
// DELETE THIS:
/**
 * Truncate input text to maximum allowed length
 */
function truncateInput(text: string): string {
  if (text.length <= MAX_INPUT_LENGTH) {
    return text;
  }
  debug(`Truncating input from ${text.length} to ${MAX_INPUT_LENGTH} chars`);
  return text.substring(0, MAX_INPUT_LENGTH);
}
```

**Step 3: Update indexer.ts**

Remove local `truncateContent` function and import shared one:

```typescript
import { truncateForEmbedding } from "../utils/text.js";
```

Replace calls to `truncateContent(...)` with `truncateForEmbedding(...)`.

Delete the local function (lines 60-68):

```typescript
// DELETE THIS:
/**
 * Truncate content to avoid token limits in embedding models.
 */
function truncateContent(content: string, maxLength = 8000): string {
  if (content.length <= maxLength) {
    return content;
  }
  return content.slice(0, maxLength);
}
```

**Step 4: Run tests**

```bash
npm test
```

**Step 5: Commit**

```bash
git add src/utils/text.ts src/embeddings/openrouter.ts src/search/indexer.ts
git commit -m "refactor: extract shared truncation utility"
```

---

## Summary

| Task | Type | Files Changed | Description |
|------|------|---------------|-------------|
| 1 | Bug fix | openrouter.ts | Cache key after truncation |
| 2 | Bug fix | openrouter.ts | Clear timeout before continue |
| 3 | Cleanup | lancedb.ts | Remove redundant null check |
| 4 | Refactor | 6 files | Consolidate magic numbers |
| 5 | Refactor | 3 files | Extract shared truncation |

**Total: 5 tasks, estimated ~15 minutes**
