# Parent Document Chunking Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace truncation with proper chunking - split long notes into overlapping chunks while maintaining parent note reference for accurate semantic search across entire note content.

**Architecture:** Notes are split into ~500 char chunks with 100 char overlap using recursive character splitting. Each chunk stores `note_id` reference. Search matches chunks, deduplicates by note, returns full notes. Backward compatible - same MCP tools, same user experience.

**Tech Stack:** LanceDB (existing), custom recursive splitter (no new deps), TypeScript

---

## Critical Design Decisions

### Chunk Parameters (from research)
- **Chunk size:** 500 characters (~125 tokens)
- **Overlap:** 100 characters (20%)
- **Splitter:** Recursive (respects paragraphs > sentences > words)

### Schema Change
```typescript
// OLD: NoteRecord (1 record per note)
// NEW: ChunkRecord (N records per note)

interface ChunkRecord {
  chunk_id: string;      // `${note_id}_chunk_${index}`
  note_id: string;       // Parent note Apple ID
  note_title: string;    // For display
  folder: string;
  chunk_index: number;   // 0, 1, 2...
  total_chunks: number;  // Total chunks in this note
  content: string;       // Chunk content (not full note)
  vector: number[];
  created: string;
  modified: string;
  indexed_at: string;
  tags: string[];        // From parent note (duplicated for filtering)
  outlinks: string[];    // From parent note (duplicated for filtering)
}
```

### Search Behavior
1. Query matches chunks (as before, but more precise)
2. Deduplicate results by `note_id`
3. Return full note content (fetched from Apple Notes or stored separately)

---

## Task 1: Create Text Chunker Module

**Files:**
- Create: `src/utils/chunker.ts`
- Test: `src/utils/chunker.test.ts`

**Step 1: Write failing tests**

```typescript
// src/utils/chunker.test.ts
import { describe, it, expect } from "vitest";
import { chunkText, type ChunkResult } from "./chunker.js";

describe("chunkText", () => {
  it("should return single chunk for short text", () => {
    const text = "Short text under limit.";
    const chunks = chunkText(text, { chunkSize: 500, overlap: 100 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe(text);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].totalChunks).toBe(1);
  });

  it("should split long text into multiple chunks", () => {
    const text = "A".repeat(1200); // 1200 chars
    const chunks = chunkText(text, { chunkSize: 500, overlap: 100 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].content.length).toBeLessThanOrEqual(500);
  });

  it("should include overlap between chunks", () => {
    // Create text with clear paragraph breaks
    const para1 = "First paragraph content here. ".repeat(20); // ~600 chars
    const para2 = "Second paragraph content here. ".repeat(20);
    const text = para1 + "\n\n" + para2;

    const chunks = chunkText(text, { chunkSize: 500, overlap: 100 });

    // With overlap, end of chunk N should appear at start of chunk N+1
    if (chunks.length >= 2) {
      const endOfFirst = chunks[0].content.slice(-50);
      const startOfSecond = chunks[1].content.slice(0, 100);
      // Some overlap should exist
      expect(chunks[1].content.length).toBeGreaterThan(0);
    }
  });

  it("should respect paragraph boundaries when possible", () => {
    const text = "Para one.\n\nPara two.\n\nPara three.";
    const chunks = chunkText(text, { chunkSize: 15, overlap: 0 });

    // Should prefer splitting at \n\n
    expect(chunks.some(c => c.content.includes("Para one"))).toBe(true);
  });

  it("should set correct totalChunks on all chunks", () => {
    const text = "Word ".repeat(300); // ~1500 chars
    const chunks = chunkText(text, { chunkSize: 500, overlap: 100 });

    const total = chunks[0].totalChunks;
    expect(chunks.every(c => c.totalChunks === total)).toBe(true);
    expect(total).toBe(chunks.length);
  });

  it("should handle empty text", () => {
    const chunks = chunkText("", { chunkSize: 500, overlap: 100 });
    expect(chunks).toHaveLength(0);
  });

  it("should handle whitespace-only text", () => {
    const chunks = chunkText("   \n\n   ", { chunkSize: 500, overlap: 100 });
    expect(chunks).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun run test src/utils/chunker.test.ts
```

Expected: FAIL - module not found

**Step 3: Implement chunker**

```typescript
// src/utils/chunker.ts
/**
 * Recursive character text splitter for chunking notes.
 * Respects natural boundaries: paragraphs > sentences > words.
 */

import { createDebugLogger } from "./debug.js";

const debug = createDebugLogger("CHUNKER");

export interface ChunkOptions {
  /** Target chunk size in characters (default: 500) */
  chunkSize: number;
  /** Overlap between chunks in characters (default: 100) */
  overlap: number;
}

export interface ChunkResult {
  /** Chunk content */
  content: string;
  /** Chunk index (0-based) */
  index: number;
  /** Total number of chunks */
  totalChunks: number;
  /** Start position in original text */
  startPos: number;
  /** End position in original text */
  endPos: number;
}

// Separators in order of preference (most preferred first)
const SEPARATORS = [
  "\n\n",  // Paragraph break
  "\n",    // Line break
  ". ",    // Sentence end
  "! ",    // Exclamation
  "? ",    // Question
  "; ",    // Semicolon
  ", ",    // Comma
  " ",     // Space
  "",      // Character (last resort)
];

/**
 * Split text using recursive character splitting.
 * Tries to split at natural boundaries (paragraphs, sentences, words).
 */
export function chunkText(
  text: string,
  options: ChunkOptions
): ChunkResult[] {
  const { chunkSize, overlap } = options;

  // Handle empty/whitespace text
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  // If text fits in one chunk, return it
  if (trimmed.length <= chunkSize) {
    return [{
      content: trimmed,
      index: 0,
      totalChunks: 1,
      startPos: 0,
      endPos: trimmed.length,
    }];
  }

  const chunks: ChunkResult[] = [];
  let currentPos = 0;

  while (currentPos < trimmed.length) {
    // Calculate end position for this chunk
    let endPos = Math.min(currentPos + chunkSize, trimmed.length);

    // If we're not at the end, find a good split point
    if (endPos < trimmed.length) {
      endPos = findSplitPoint(trimmed, currentPos, endPos);
    }

    // Extract chunk content
    const content = trimmed.slice(currentPos, endPos).trim();

    if (content) {
      chunks.push({
        content,
        index: chunks.length,
        totalChunks: 0, // Will be set after all chunks are created
        startPos: currentPos,
        endPos,
      });
    }

    // Move position forward, accounting for overlap
    currentPos = endPos - overlap;

    // Ensure we make progress
    if (currentPos <= chunks[chunks.length - 1]?.startPos) {
      currentPos = endPos;
    }
  }

  // Set totalChunks on all chunks
  const totalChunks = chunks.length;
  for (const chunk of chunks) {
    chunk.totalChunks = totalChunks;
  }

  debug(`Split ${trimmed.length} chars into ${chunks.length} chunks`);
  return chunks;
}

/**
 * Find the best split point near the target position.
 * Prefers natural boundaries (paragraph > sentence > word).
 */
function findSplitPoint(text: string, start: number, target: number): number {
  // Search backward from target to find a good separator
  const searchStart = Math.max(start, target - 100); // Look back up to 100 chars
  const searchText = text.slice(searchStart, target);

  for (const sep of SEPARATORS) {
    if (sep === "") continue; // Skip empty separator for now

    const lastIndex = searchText.lastIndexOf(sep);
    if (lastIndex !== -1) {
      const splitPos = searchStart + lastIndex + sep.length;
      // Make sure we're making reasonable progress
      if (splitPos > start + 50) {
        return splitPos;
      }
    }
  }

  // No good separator found, split at target
  return target;
}

// Default chunk options
export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  chunkSize: 500,
  overlap: 100,
};
```

**Step 4: Run test to verify it passes**

```bash
bun run test src/utils/chunker.test.ts
```

Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/utils/chunker.ts src/utils/chunker.test.ts
git commit -m "feat(chunking): add recursive text chunker with overlap support"
```

---

## Task 2: Update Constants

**Files:**
- Modify: `src/config/constants.ts`

**Step 1: Add chunking constants**

Add at end of file:

```typescript
// Chunking settings
export const DEFAULT_CHUNK_SIZE = 500;
export const DEFAULT_CHUNK_OVERLAP = 100;
```

**Step 2: Commit**

```bash
git add src/config/constants.ts
git commit -m "feat(chunking): add chunk size and overlap constants"
```

---

## Task 3: Create ChunkRecord Type

**Files:**
- Modify: `src/db/lancedb.ts`

**Step 1: Add ChunkRecord interface**

Add after existing `NoteRecord` interface (around line 21):

```typescript
// Schema for chunked notes (Parent Document Retriever pattern)
export interface ChunkRecord {
  chunk_id: string;      // `${note_id}_chunk_${index}`
  note_id: string;       // Parent note Apple ID
  note_title: string;    // For display and deduplication
  folder: string;
  chunk_index: number;   // 0, 1, 2...
  total_chunks: number;  // Total chunks in this note
  content: string;       // Chunk content
  vector: number[];
  created: string;       // ISO date (from parent)
  modified: string;      // ISO date (from parent)
  indexed_at: string;    // ISO date
  tags: string[];        // From parent note
  outlinks: string[];    // From parent note
  [key: string]: unknown; // Index signature for LanceDB
}
```

**Step 2: Commit**

```bash
git add src/db/lancedb.ts
git commit -m "feat(chunking): add ChunkRecord interface"
```

---

## Task 4: Create Chunk Store Class

**Files:**
- Modify: `src/db/lancedb.ts`
- Test: `src/db/lancedb.test.ts`

**Step 1: Write failing test for ChunkStore**

Add to `src/db/lancedb.test.ts`:

```typescript
describe("ChunkStore", () => {
  let store: ChunkStore;
  const testDir = path.join(os.tmpdir(), `chunk-test-${Date.now()}`);

  beforeEach(() => {
    store = new ChunkStore(testDir);
  });

  afterEach(async () => {
    await store.clear();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  const createTestChunk = (
    noteId: string,
    index: number,
    total: number,
    content: string
  ): ChunkRecord => ({
    chunk_id: `${noteId}_chunk_${index}`,
    note_id: noteId,
    note_title: `Note ${noteId}`,
    folder: "Test",
    chunk_index: index,
    total_chunks: total,
    content,
    vector: Array(384).fill(0.1),
    created: "2026-01-10T00:00:00.000Z",
    modified: "2026-01-10T00:00:00.000Z",
    indexed_at: "2026-01-10T00:00:00.000Z",
    tags: [],
    outlinks: [],
  });

  it("should index chunks", async () => {
    const chunks = [
      createTestChunk("note1", 0, 2, "First chunk"),
      createTestChunk("note1", 1, 2, "Second chunk"),
    ];

    await store.indexChunks(chunks);
    const count = await store.count();
    expect(count).toBe(2);
  });

  it("should search chunks and return results", async () => {
    const chunks = [
      createTestChunk("note1", 0, 1, "Apple pie recipe"),
      createTestChunk("note2", 0, 1, "Banana bread recipe"),
    ];

    await store.indexChunks(chunks);

    // Search with a vector (mock - just testing structure)
    const queryVector = Array(384).fill(0.1);
    const results = await store.searchChunks(queryVector, 10);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty("note_id");
    expect(results[0]).toHaveProperty("chunk_id");
  });

  it("should delete all chunks for a note", async () => {
    const chunks = [
      createTestChunk("note1", 0, 2, "Chunk 1"),
      createTestChunk("note1", 1, 2, "Chunk 2"),
      createTestChunk("note2", 0, 1, "Other note"),
    ];

    await store.indexChunks(chunks);
    await store.deleteNoteChunks("note1");

    const count = await store.count();
    expect(count).toBe(1);
  });

  it("should get all chunks for a note", async () => {
    const chunks = [
      createTestChunk("note1", 0, 2, "Chunk 1"),
      createTestChunk("note1", 1, 2, "Chunk 2"),
      createTestChunk("note2", 0, 1, "Other note"),
    ];

    await store.indexChunks(chunks);
    const noteChunks = await store.getChunksByNoteId("note1");

    expect(noteChunks).toHaveLength(2);
    expect(noteChunks[0].chunk_index).toBe(0);
    expect(noteChunks[1].chunk_index).toBe(1);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun run test src/db/lancedb.test.ts
```

Expected: FAIL - ChunkStore not defined

**Step 3: Implement ChunkStore class**

Add to `src/db/lancedb.ts` (after LanceDBStore class):

```typescript
/**
 * Chunk-based vector store for Parent Document Retriever pattern.
 */
export class ChunkStore {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private readonly dbPath: string;
  private readonly tableName = "chunks";

  constructor(dataDir?: string) {
    this.dbPath = dataDir || getDataDir();
  }

  private async ensureConnection(): Promise<lancedb.Connection> {
    if (!this.db) {
      debug(`ChunkStore: Connecting to LanceDB at ${this.dbPath}`);
      this.db = await lancedb.connect(this.dbPath);
    }
    return this.db;
  }

  private async ensureTable(): Promise<lancedb.Table> {
    if (!this.table) {
      const db = await this.ensureConnection();
      try {
        this.table = await db.openTable(this.tableName);
        debug(`ChunkStore: Opened existing table: ${this.tableName}`);
      } catch (error) {
        debug(`ChunkStore: Table ${this.tableName} not found. Error:`, error);
        throw new Error("Chunk index not found. Run index-notes first.");
      }
    }
    return this.table;
  }

  async indexChunks(chunks: ChunkRecord[]): Promise<void> {
    if (chunks.length === 0) {
      debug("ChunkStore: No chunks to index");
      return;
    }

    const db = await this.ensureConnection();

    // Drop existing table
    try {
      await db.dropTable(this.tableName);
      debug(`ChunkStore: Dropped existing table: ${this.tableName}`);
    } catch (error) {
      debug("ChunkStore: Table drop skipped:", error);
    }

    // Ensure arrays are not empty for Arrow type inference
    const processedChunks = chunks.map((c) => ({
      ...c,
      tags: c.tags.length > 0 ? c.tags : ["__placeholder__"],
      outlinks: c.outlinks.length > 0 ? c.outlinks : ["__placeholder__"],
    }));

    // Create table
    this.table = await db.createTable(this.tableName, processedChunks);

    // Remove placeholders
    for (const chunk of processedChunks) {
      if (chunk.tags[0] === "__placeholder__" || chunk.outlinks[0] === "__placeholder__") {
        const cleanChunk = {
          ...chunk,
          tags: chunk.tags[0] === "__placeholder__" ? [] : chunk.tags,
          outlinks: chunk.outlinks[0] === "__placeholder__" ? [] : chunk.outlinks,
        };
        await this.table.delete(`chunk_id = '${escapeForFilter(chunk.chunk_id)}'`);
        await this.table.add([cleanChunk]);
      }
    }

    // Create FTS index
    await this.table.createIndex("content", {
      config: lancedb.Index.fts(),
      replace: true,
    });

    debug(`ChunkStore: Indexed ${chunks.length} chunks`);
  }

  async searchChunks(
    queryVector: number[],
    limit: number
  ): Promise<ChunkRecord[]> {
    const table = await this.ensureTable();
    const results = await table.search(queryVector).limit(limit).toArray();
    return results as unknown as ChunkRecord[];
  }

  async searchChunksFTS(query: string, limit: number): Promise<ChunkRecord[]> {
    const table = await this.ensureTable();
    try {
      const results = await table
        .query()
        .fullTextSearch(query)
        .limit(limit)
        .toArray();
      return results as unknown as ChunkRecord[];
    } catch (error) {
      debug("ChunkStore: FTS search failed:", error);
      return [];
    }
  }

  async getChunksByNoteId(noteId: string): Promise<ChunkRecord[]> {
    const table = await this.ensureTable();
    const escaped = escapeForFilter(noteId);
    const results = await table
      .query()
      .where(`note_id = '${escaped}'`)
      .toArray();

    // Sort by chunk_index
    return (results as unknown as ChunkRecord[]).sort(
      (a, b) => a.chunk_index - b.chunk_index
    );
  }

  async deleteNoteChunks(noteId: string): Promise<void> {
    const table = await this.ensureTable();
    const escaped = escapeForFilter(noteId);
    await table.delete(`note_id = '${escaped}'`);
    debug(`ChunkStore: Deleted chunks for note: ${noteId}`);
  }

  async count(): Promise<number> {
    try {
      const table = await this.ensureTable();
      return await table.countRows();
    } catch (error) {
      debug("ChunkStore: Count failed:", error);
      return 0;
    }
  }

  async clear(): Promise<void> {
    const db = await this.ensureConnection();
    try {
      await db.dropTable(this.tableName);
      this.table = null;
      debug("ChunkStore: Cleared table");
    } catch (error) {
      debug("ChunkStore: Clear skipped:", error);
    }
  }

  async rebuildFtsIndex(): Promise<void> {
    const table = await this.ensureTable();
    await table.createIndex("content", {
      config: lancedb.Index.fts(),
      replace: true,
    });
    debug("ChunkStore: FTS index rebuilt");
  }
}

// Singleton instance for chunk store
let chunkStoreInstance: ChunkStore | null = null;

export function getChunkStore(): ChunkStore {
  if (!chunkStoreInstance) {
    chunkStoreInstance = new ChunkStore();
  }
  return chunkStoreInstance;
}
```

**Step 4: Run test to verify it passes**

```bash
bun run test src/db/lancedb.test.ts
```

Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/db/lancedb.ts src/db/lancedb.test.ts
git commit -m "feat(chunking): add ChunkStore class for chunk-based indexing"
```

---

## Task 5: Create Chunk Indexer

**Files:**
- Create: `src/search/chunk-indexer.ts`
- Test: `src/search/chunk-indexer.test.ts`

**Step 1: Write failing test**

```typescript
// src/search/chunk-indexer.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies
vi.mock("../embeddings/index.js", () => ({
  getEmbeddingBatch: vi.fn(),
}));

vi.mock("../db/lancedb.js", () => ({
  getChunkStore: vi.fn(),
}));

vi.mock("../notes/read.js", () => ({
  getAllNotesWithContent: vi.fn(),
}));

import { getEmbeddingBatch } from "../embeddings/index.js";
import { getChunkStore } from "../db/lancedb.js";
import { getAllNotesWithContent } from "../notes/read.js";
import { chunkNote, fullChunkIndex } from "./chunk-indexer.js";

describe("chunkNote", () => {
  it("should chunk a note into multiple parts", () => {
    const note = {
      id: "note1",
      title: "Test Note",
      content: "A".repeat(1200), // Long content
      folder: "Test",
      created: "2026-01-10T00:00:00.000Z",
      modified: "2026-01-10T00:00:00.000Z",
    };

    const chunks = chunkNote(note);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].note_id).toBe("note1");
    expect(chunks[0].note_title).toBe("Test Note");
    expect(chunks[0].chunk_index).toBe(0);
  });

  it("should return single chunk for short notes", () => {
    const note = {
      id: "note1",
      title: "Short Note",
      content: "Brief content",
      folder: "Test",
      created: "2026-01-10T00:00:00.000Z",
      modified: "2026-01-10T00:00:00.000Z",
    };

    const chunks = chunkNote(note);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].total_chunks).toBe(1);
  });
});

describe("fullChunkIndex", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should index all notes as chunks", async () => {
    const mockNotes = [
      {
        id: "note1",
        title: "Note 1",
        content: "Content for note one",
        folder: "Test",
        created: "2026-01-10T00:00:00.000Z",
        modified: "2026-01-10T00:00:00.000Z",
      },
    ];

    const mockStore = {
      indexChunks: vi.fn(),
      clear: vi.fn(),
    };

    vi.mocked(getAllNotesWithContent).mockResolvedValue(mockNotes);
    vi.mocked(getChunkStore).mockReturnValue(mockStore as any);
    vi.mocked(getEmbeddingBatch).mockResolvedValue([[0.1, 0.2, 0.3]]);

    const result = await fullChunkIndex();

    expect(result.indexed).toBeGreaterThan(0);
    expect(mockStore.indexChunks).toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun run test src/search/chunk-indexer.test.ts
```

Expected: FAIL - module not found

**Step 3: Implement chunk indexer**

```typescript
// src/search/chunk-indexer.ts
/**
 * Chunk-based indexing for Parent Document Retriever pattern.
 * Splits notes into overlapping chunks for better semantic search.
 */

import { getEmbeddingBatch } from "../embeddings/index.js";
import { getChunkStore, type ChunkRecord } from "../db/lancedb.js";
import { getAllNotesWithContent } from "../notes/read.js";
import { createDebugLogger } from "../utils/debug.js";
import { chunkText, DEFAULT_CHUNK_OPTIONS } from "../utils/chunker.js";
import { extractMetadata } from "../graph/extract.js";
import { DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP } from "../config/constants.js";

const debug = createDebugLogger("CHUNK-INDEX");

export interface ChunkIndexResult {
  /** Total notes processed */
  totalNotes: number;
  /** Total chunks created */
  totalChunks: number;
  /** Notes successfully indexed */
  indexed: number;
  /** Time taken in milliseconds */
  timeMs: number;
}

interface NoteWithContent {
  id: string;
  title: string;
  content: string;
  folder: string;
  created: string;
  modified: string;
}

/**
 * Chunk a single note into ChunkRecord objects (without vectors).
 */
export function chunkNote(note: NoteWithContent): Omit<ChunkRecord, "vector">[] {
  const metadata = extractMetadata(note.content);

  const textChunks = chunkText(note.content, {
    chunkSize: DEFAULT_CHUNK_SIZE,
    overlap: DEFAULT_CHUNK_OVERLAP,
  });

  // If no chunks (empty note), return empty array
  if (textChunks.length === 0) {
    return [];
  }

  return textChunks.map((chunk) => ({
    chunk_id: `${note.id}_chunk_${chunk.index}`,
    note_id: note.id,
    note_title: note.title,
    folder: note.folder,
    chunk_index: chunk.index,
    total_chunks: chunk.totalChunks,
    content: chunk.content,
    created: note.created,
    modified: note.modified,
    indexed_at: "", // Will be set during indexing
    tags: metadata.tags,
    outlinks: metadata.outlinks,
  }));
}

/**
 * Full reindex using chunk-based approach.
 */
export async function fullChunkIndex(): Promise<ChunkIndexResult> {
  const startTime = Date.now();
  debug("Starting full chunk index...");

  // Phase 1: Fetch all notes
  debug("Phase 1: Fetching all notes...");
  const allNotes = await getAllNotesWithContent();
  debug(`Fetched ${allNotes.length} notes`);

  // Phase 2: Chunk all notes
  debug("Phase 2: Chunking notes...");
  const allChunksWithoutVectors: Omit<ChunkRecord, "vector">[] = [];

  for (const note of allNotes) {
    if (!note.content.trim()) continue;
    const chunks = chunkNote(note);
    allChunksWithoutVectors.push(...chunks);
  }

  debug(`Created ${allChunksWithoutVectors.length} chunks from ${allNotes.length} notes`);

  if (allChunksWithoutVectors.length === 0) {
    return {
      totalNotes: allNotes.length,
      totalChunks: 0,
      indexed: 0,
      timeMs: Date.now() - startTime,
    };
  }

  // Phase 3: Generate embeddings in batch
  debug("Phase 3: Generating embeddings...");
  const textsToEmbed = allChunksWithoutVectors.map((c) => c.content);
  const vectors = await getEmbeddingBatch(textsToEmbed);
  debug(`Generated ${vectors.length} embeddings`);

  // Phase 4: Combine chunks with vectors
  const indexedAt = new Date().toISOString();
  const completeChunks: ChunkRecord[] = allChunksWithoutVectors.map((chunk, i) => ({
    ...chunk,
    vector: vectors[i],
    indexed_at: indexedAt,
  }));

  // Phase 5: Store in database
  debug("Phase 5: Storing chunks...");
  const store = getChunkStore();
  await store.indexChunks(completeChunks);

  const timeMs = Date.now() - startTime;
  const indexedNotes = new Set(completeChunks.map((c) => c.note_id)).size;

  debug(`Full chunk index complete: ${completeChunks.length} chunks, ${indexedNotes} notes, ${timeMs}ms`);

  return {
    totalNotes: allNotes.length,
    totalChunks: completeChunks.length,
    indexed: indexedNotes,
    timeMs,
  };
}
```

**Step 4: Run test to verify it passes**

```bash
bun run test src/search/chunk-indexer.test.ts
```

Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/search/chunk-indexer.ts src/search/chunk-indexer.test.ts
git commit -m "feat(chunking): add chunk-based indexer"
```

---

## Task 6: Create Chunk Search Module

**Files:**
- Create: `src/search/chunk-search.ts`
- Test: `src/search/chunk-search.test.ts`

**Step 1: Write failing test**

```typescript
// src/search/chunk-search.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../embeddings/index.js", () => ({
  getEmbedding: vi.fn(),
}));

vi.mock("../db/lancedb.js", () => ({
  getChunkStore: vi.fn(),
}));

import { getEmbedding } from "../embeddings/index.js";
import { getChunkStore } from "../db/lancedb.js";
import { searchChunks, deduplicateByNote } from "./chunk-search.js";

describe("deduplicateByNote", () => {
  it("should keep only best chunk per note", () => {
    const chunks = [
      { note_id: "note1", note_title: "Note 1", score: 0.9, content: "a", folder: "F" },
      { note_id: "note1", note_title: "Note 1", score: 0.7, content: "b", folder: "F" },
      { note_id: "note2", note_title: "Note 2", score: 0.8, content: "c", folder: "F" },
    ];

    const deduped = deduplicateByNote(chunks as any);

    expect(deduped).toHaveLength(2);
    expect(deduped[0].note_id).toBe("note1");
    expect(deduped[0].score).toBe(0.9); // Best score kept
    expect(deduped[1].note_id).toBe("note2");
  });

  it("should sort by score descending", () => {
    const chunks = [
      { note_id: "note1", note_title: "Note 1", score: 0.5, content: "a", folder: "F" },
      { note_id: "note2", note_title: "Note 2", score: 0.9, content: "b", folder: "F" },
    ];

    const deduped = deduplicateByNote(chunks as any);

    expect(deduped[0].note_id).toBe("note2"); // Higher score first
  });
});

describe("searchChunks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should search and deduplicate results", async () => {
    const mockStore = {
      searchChunks: vi.fn().mockResolvedValue([
        { note_id: "note1", note_title: "Note 1", content: "chunk1", folder: "F", chunk_index: 0 },
        { note_id: "note1", note_title: "Note 1", content: "chunk2", folder: "F", chunk_index: 1 },
        { note_id: "note2", note_title: "Note 2", content: "chunk3", folder: "F", chunk_index: 0 },
      ]),
      searchChunksFTS: vi.fn().mockResolvedValue([]),
    };

    vi.mocked(getChunkStore).mockReturnValue(mockStore as any);
    vi.mocked(getEmbedding).mockResolvedValue([0.1, 0.2, 0.3]);

    const results = await searchChunks("query", { limit: 10 });

    expect(results).toHaveLength(2); // Deduplicated to 2 notes
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun run test src/search/chunk-search.test.ts
```

Expected: FAIL - module not found

**Step 3: Implement chunk search**

```typescript
// src/search/chunk-search.ts
/**
 * Chunk-based search with note deduplication.
 * Searches chunks, deduplicates by parent note, returns note-level results.
 */

import { getEmbedding } from "../embeddings/index.js";
import { getChunkStore, type ChunkRecord } from "../db/lancedb.js";
import { createDebugLogger } from "../utils/debug.js";
import { RRF_K, DEFAULT_SEARCH_LIMIT, HYBRID_SEARCH_MIN_FETCH } from "../config/constants.js";

const debug = createDebugLogger("CHUNK-SEARCH");

export interface ChunkSearchOptions {
  folder?: string;
  limit?: number;
  mode?: "hybrid" | "keyword" | "semantic";
}

export interface ChunkSearchResult {
  note_id: string;
  note_title: string;
  folder: string;
  /** Best matching chunk content */
  matchedChunk: string;
  /** Chunk index that matched best */
  matchedChunkIndex: number;
  /** Combined score */
  score: number;
  /** Modified date from chunk record */
  modified: string;
}

interface ScoredChunk extends ChunkRecord {
  score: number;
}

/**
 * Calculate RRF score.
 */
function rrfScore(rank: number): number {
  return 1 / (RRF_K + rank);
}

/**
 * Deduplicate chunks by note_id, keeping the best scoring chunk per note.
 */
export function deduplicateByNote(chunks: ScoredChunk[]): ChunkSearchResult[] {
  const bestByNote = new Map<string, ScoredChunk>();

  for (const chunk of chunks) {
    const existing = bestByNote.get(chunk.note_id);
    if (!existing || chunk.score > existing.score) {
      bestByNote.set(chunk.note_id, chunk);
    }
  }

  // Convert to results and sort by score
  const results: ChunkSearchResult[] = Array.from(bestByNote.values())
    .sort((a, b) => b.score - a.score)
    .map((chunk) => ({
      note_id: chunk.note_id,
      note_title: chunk.note_title,
      folder: chunk.folder,
      matchedChunk: chunk.content,
      matchedChunkIndex: chunk.chunk_index,
      score: chunk.score,
      modified: chunk.modified,
    }));

  return results;
}

/**
 * Filter chunks by folder.
 */
function filterByFolder(chunks: ScoredChunk[], folder?: string): ScoredChunk[] {
  if (!folder) return chunks;
  const normalized = folder.toLowerCase();
  return chunks.filter((c) => c.folder.toLowerCase() === normalized);
}

/**
 * Search chunks and return deduplicated note-level results.
 */
export async function searchChunks(
  query: string,
  options: ChunkSearchOptions = {}
): Promise<ChunkSearchResult[]> {
  const { folder, limit = DEFAULT_SEARCH_LIMIT, mode = "hybrid" } = options;

  if (!query.trim()) {
    return [];
  }

  debug(`Chunk search: "${query}" mode=${mode} folder=${folder || "all"}`);

  const store = getChunkStore();
  const fetchLimit = Math.max(limit * 5, HYBRID_SEARCH_MIN_FETCH); // Fetch more for dedup

  let scoredChunks: ScoredChunk[] = [];

  if (mode === "semantic" || mode === "hybrid") {
    const queryVector = await getEmbedding(query);
    const vectorResults = await store.searchChunks(queryVector, fetchLimit);

    vectorResults.forEach((chunk, rank) => {
      scoredChunks.push({
        ...chunk,
        score: rrfScore(rank),
      });
    });
  }

  if (mode === "keyword" || mode === "hybrid") {
    const ftsResults = await store.searchChunksFTS(query, fetchLimit);

    ftsResults.forEach((chunk, rank) => {
      // Find if we already have this chunk from vector search
      const existing = scoredChunks.find((c) => c.chunk_id === chunk.chunk_id);
      if (existing) {
        existing.score += rrfScore(rank);
      } else {
        scoredChunks.push({
          ...chunk,
          score: rrfScore(rank),
        });
      }
    });
  }

  // Filter by folder
  scoredChunks = filterByFolder(scoredChunks, folder);

  // Deduplicate by note and limit
  const results = deduplicateByNote(scoredChunks);
  return results.slice(0, limit);
}
```

**Step 4: Run test to verify it passes**

```bash
bun run test src/search/chunk-search.test.ts
```

Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/search/chunk-search.ts src/search/chunk-search.test.ts
git commit -m "feat(chunking): add chunk search with note deduplication"
```

---

## Task 7: Integrate Chunk Search into MCP Tools

**Files:**
- Modify: `src/index.ts`

**Step 1: Update index-notes tool to use chunk indexer**

Find the `index-notes` tool handler and update to use chunk indexing:

```typescript
// In the index-notes tool handler, replace the indexNotes call:

// OLD:
const result = await indexNotes(mode);

// NEW:
import { fullChunkIndex, type ChunkIndexResult } from "./search/chunk-indexer.js";

// In handler:
let result: IndexResult | ChunkIndexResult;
if (mode === "full") {
  result = await fullChunkIndex();
} else {
  // For incremental, still use old indexer (chunk incremental TBD)
  result = await indexNotes(mode);
}
```

**Step 2: Update search-notes tool to use chunk search**

Find the `search-notes` tool handler and add chunk search option:

```typescript
// Add import at top
import { searchChunks, type ChunkSearchResult } from "./search/chunk-search.js";

// In search-notes handler, check for chunk-based search:
// For now, add a feature flag or always use chunk search for semantic/hybrid
const useChunkSearch = true; // Can be made configurable later

if (useChunkSearch) {
  const chunkResults = await searchChunks(query, {
    folder,
    limit,
    mode,
  });

  // Convert to SearchResult format
  const results: SearchResult[] = chunkResults.map((r) => ({
    id: r.note_id,
    title: r.note_title,
    folder: r.folder,
    preview: r.matchedChunk.slice(0, 200) + "...",
    modified: r.modified,
    score: r.score,
  }));

  return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
} else {
  // Fallback to old search
  const results = await searchNotes(query, { folder, limit, mode, include_content });
  // ...
}
```

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(chunking): integrate chunk indexer and search into MCP tools"
```

---

## Task 8: Add Migration Path

**Files:**
- Modify: `src/search/chunk-indexer.ts`

**Step 1: Add check for existing index type**

Add function to detect which index type exists:

```typescript
/**
 * Check if chunk index exists.
 */
export async function hasChunkIndex(): Promise<boolean> {
  try {
    const store = getChunkStore();
    const count = await store.count();
    return count > 0;
  } catch {
    return false;
  }
}
```

**Step 2: Commit**

```bash
git add src/search/chunk-indexer.ts
git commit -m "feat(chunking): add chunk index detection"
```

---

## Task 9: Update Documentation

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Step 1: Update README**

Add section about chunking:

```markdown
## Semantic Search

Notes are automatically chunked into ~500 character segments with 100 character overlap for optimal semantic search. This ensures:

- Long notes are fully searchable (not truncated)
- Better precision for specific content within notes
- Matching chunks are highlighted in search results

### Chunk Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Chunk size | 500 chars | Target size for each chunk |
| Overlap | 100 chars | Overlap between adjacent chunks |
```

**Step 2: Update CHANGELOG**

```markdown
## [Unreleased]

### Added
- Chunk-based indexing using Parent Document Retriever pattern
- Notes are split into ~500 char chunks with 100 char overlap
- Full note content is now searchable (no more truncation)
- Improved semantic search precision for long notes

### Changed
- Search now matches individual chunks, returns parent notes
- `index-notes` creates chunk-based index by default
```

**Step 3: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document chunk-based search"
```

---

## Task 10: Run Full Test Suite

**Step 1: Run all tests**

```bash
bun run test
```

Expected: All tests PASS

**Step 2: Run type check**

```bash
bun run check
```

Expected: No errors

**Step 3: Manual integration test**

```bash
# Start server
bun run start

# In another terminal or via Claude Code:
# 1. Run index-notes (full mode)
# 2. Search for content that was previously in truncated part of a long note
# 3. Verify it now finds the match
```

**Step 4: Final commit**

```bash
git add -A
git commit -m "test: verify chunk-based search integration"
```

---

## Verification Checklist

- [ ] `chunkText()` correctly splits text with overlap
- [ ] `ChunkStore` indexes and retrieves chunks
- [ ] `chunkNote()` creates proper chunk records
- [ ] `fullChunkIndex()` processes all notes
- [ ] `searchChunks()` finds and deduplicates results
- [ ] MCP tools use new chunk-based system
- [ ] Long notes are fully searchable
- [ ] Existing tests still pass
- [ ] Documentation updated

---

## Critical Files Summary

| File | Purpose |
|------|---------|
| `src/utils/chunker.ts` | Recursive text splitter |
| `src/db/lancedb.ts` | ChunkRecord type, ChunkStore class |
| `src/search/chunk-indexer.ts` | Chunk-based indexing |
| `src/search/chunk-search.ts` | Chunk search with deduplication |
| `src/index.ts` | MCP tool integration |
| `src/config/constants.ts` | Chunk size/overlap settings |

## Performance Considerations

- **Indexing:** More chunks = more embeddings = longer index time
- **Storage:** ~3-5x more records in DB (depending on average note length)
- **Search:** Slightly more work to deduplicate, but better precision
- **Memory:** Batch embedding helps keep memory stable

For 333 notes averaging 2000 chars each:
- Before: 333 records, 333 embeddings
- After: ~1300 records, ~1300 embeddings (4x more)
- Index time: ~4x longer (but still under 5 minutes)
