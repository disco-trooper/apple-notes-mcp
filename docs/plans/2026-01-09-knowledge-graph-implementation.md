# Knowledge Graph Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add knowledge graph layer with tag/link parsing, related notes discovery, and multi-format export (JSON, GraphML, Obsidian).

**Architecture:** Extend existing NoteRecord schema with `tags` and `outlinks` fields. Parse during indexing. Add 4 new MCP tools. Export module generates graph data structures.

**Tech Stack:** TypeScript, LanceDB, Zod validation, existing embedding infrastructure.

---

## Task 1: Metadata Extraction Module

**Files:**
- Create: `src/graph/extract.ts`
- Test: `src/graph/extract.test.ts`

**Step 1: Write failing tests for tag extraction**

```typescript
// src/graph/extract.test.ts
import { describe, it, expect } from "vitest";
import { extractTags, extractOutlinks, extractMetadata } from "./extract.js";

describe("extractTags", () => {
  it("extracts simple hashtags", () => {
    const content = "This is a #project about #coding";
    expect(extractTags(content)).toEqual(["project", "coding"]);
  });

  it("handles hyphenated tags", () => {
    const content = "Working on #my-project and #some-idea";
    expect(extractTags(content)).toEqual(["my-project", "some-idea"]);
  });

  it("normalizes to lowercase", () => {
    const content = "#Project #IDEA #Mixed";
    expect(extractTags(content)).toEqual(["project", "idea", "mixed"]);
  });

  it("deduplicates tags", () => {
    const content = "#project #idea #project";
    expect(extractTags(content)).toEqual(["project", "idea"]);
  });

  it("returns empty array for no tags", () => {
    expect(extractTags("No tags here")).toEqual([]);
  });

  it("ignores tags in code blocks", () => {
    const content = "Real #tag\n```\n#not-a-tag\n```\nAnother #real";
    expect(extractTags(content)).toEqual(["tag", "real"]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun run test src/graph/extract.test.ts`
Expected: FAIL - module not found

**Step 3: Implement extractTags**

```typescript
// src/graph/extract.ts
/**
 * Knowledge graph metadata extraction from note content.
 */

/**
 * Extract hashtags from content.
 * Ignores tags inside code blocks.
 */
export function extractTags(content: string): string[] {
  // Remove code blocks first
  const withoutCode = content.replace(/```[\s\S]*?```/g, "");

  // Match hashtags: # followed by word chars and hyphens
  const matches = withoutCode.match(/#[\w-]+/g) || [];

  // Normalize and deduplicate
  const tags = matches.map(t => t.slice(1).toLowerCase());
  return [...new Set(tags)];
}
```

**Step 4: Run test to verify it passes**

Run: `bun run test src/graph/extract.test.ts`
Expected: PASS

**Step 5: Add tests for wiki-link extraction**

```typescript
// Add to src/graph/extract.test.ts
describe("extractOutlinks", () => {
  it("extracts wiki-style links", () => {
    const content = "See [[Meeting Notes]] and [[Project Plan]]";
    expect(extractOutlinks(content)).toEqual(["Meeting Notes", "Project Plan"]);
  });

  it("handles links with special characters", () => {
    const content = "Check [[Note with / slash]] and [[Note: with colon]]";
    expect(extractOutlinks(content)).toEqual(["Note with / slash", "Note: with colon"]);
  });

  it("deduplicates links", () => {
    const content = "[[Note]] and [[Other]] and [[Note]]";
    expect(extractOutlinks(content)).toEqual(["Note", "Other"]);
  });

  it("returns empty array for no links", () => {
    expect(extractOutlinks("No links here")).toEqual([]);
  });

  it("ignores links in code blocks", () => {
    const content = "Real [[Link]]\n```\n[[not-a-link]]\n```";
    expect(extractOutlinks(content)).toEqual(["Link"]);
  });
});
```

**Step 6: Run test to verify it fails**

Run: `bun run test src/graph/extract.test.ts`
Expected: FAIL - extractOutlinks not defined

**Step 7: Implement extractOutlinks**

```typescript
// Add to src/graph/extract.ts

/**
 * Extract wiki-style [[links]] from content.
 * Ignores links inside code blocks.
 */
export function extractOutlinks(content: string): string[] {
  // Remove code blocks first
  const withoutCode = content.replace(/```[\s\S]*?```/g, "");

  // Match wiki links: [[anything except ]]]
  const matches = withoutCode.match(/\[\[([^\]]+)\]\]/g) || [];

  // Extract link text and deduplicate
  const links = matches.map(m => m.slice(2, -2));
  return [...new Set(links)];
}
```

**Step 8: Run tests**

Run: `bun run test src/graph/extract.test.ts`
Expected: PASS

**Step 9: Add combined extractMetadata function**

```typescript
// Add to src/graph/extract.test.ts
describe("extractMetadata", () => {
  it("extracts both tags and outlinks", () => {
    const content = "A #project note linking to [[Other Note]]";
    expect(extractMetadata(content)).toEqual({
      tags: ["project"],
      outlinks: ["Other Note"],
    });
  });
});
```

**Step 10: Implement extractMetadata**

```typescript
// Add to src/graph/extract.ts

export interface NoteMetadata {
  tags: string[];
  outlinks: string[];
}

/**
 * Extract all metadata (tags and outlinks) from content.
 */
export function extractMetadata(content: string): NoteMetadata {
  return {
    tags: extractTags(content),
    outlinks: extractOutlinks(content),
  };
}
```

**Step 11: Run all tests**

Run: `bun run test src/graph/extract.test.ts`
Expected: All PASS

**Step 12: Commit**

```bash
git add src/graph/extract.ts src/graph/extract.test.ts
git commit -m "feat(graph): add metadata extraction for tags and wiki-links"
```

---

## Task 2: Extend NoteRecord Schema

**Files:**
- Modify: `src/db/lancedb.ts:9-19`
- Modify: `src/types/index.ts`

**Step 1: Update NoteRecord interface**

```typescript
// src/db/lancedb.ts - update NoteRecord interface (lines 9-19)
export interface NoteRecord {
  id: string;
  title: string;
  content: string;
  vector: number[];
  folder: string;
  created: string;
  modified: string;
  indexed_at: string;
  // Knowledge Graph fields
  tags: string[];        // Extracted #hashtags
  outlinks: string[];    // Extracted [[wiki-links]]
  [key: string]: unknown;
}
```

**Step 2: Update getAll to include new fields**

```typescript
// src/db/lancedb.ts - update getAll method (around line 215-230)
async getAll(): Promise<NoteRecord[]> {
  const table = await this.ensureTable();

  const results = await table.query().toArray();

  return results.map((row) => ({
    id: (row.id as string) ?? "",
    title: row.title as string,
    content: row.content as string,
    vector: row.vector as number[],
    folder: row.folder as string,
    created: row.created as string,
    modified: row.modified as string,
    indexed_at: row.indexed_at as string,
    tags: (row.tags as string[]) ?? [],
    outlinks: (row.outlinks as string[]) ?? [],
  }));
}
```

**Step 3: Run type check**

Run: `bun run check`
Expected: PASS (or errors in indexer.ts - expected, will fix next)

**Step 4: Commit**

```bash
git add src/db/lancedb.ts src/types/index.ts
git commit -m "feat(db): extend NoteRecord with tags and outlinks fields"
```

---

## Task 3: Update Indexer to Extract Metadata

**Files:**
- Modify: `src/search/indexer.ts`

**Step 1: Import extraction module**

```typescript
// Add to imports at top of src/search/indexer.ts
import { extractMetadata } from "../graph/extract.js";
```

**Step 2: Update fullIndex to include metadata**

```typescript
// Update in fullIndex function (around line 100-110)
const metadata = extractMetadata(noteDetails.content);

const record: NoteRecord = {
  id: noteDetails.id,
  title: noteDetails.title,
  content: noteDetails.content,
  vector,
  folder: noteDetails.folder,
  created: noteDetails.created,
  modified: noteDetails.modified,
  indexed_at: new Date().toISOString(),
  tags: metadata.tags,
  outlinks: metadata.outlinks,
};
```

**Step 3: Update incrementalIndex to include metadata**

```typescript
// Update in incrementalIndex function (around line 237-247)
const metadata = extractMetadata(noteDetails.content);

const record: NoteRecord = {
  id: noteDetails.id,
  title: noteDetails.title,
  content: noteDetails.content,
  vector,
  folder: noteDetails.folder,
  created: noteDetails.created,
  modified: noteDetails.modified,
  indexed_at: new Date().toISOString(),
  tags: metadata.tags,
  outlinks: metadata.outlinks,
};
```

**Step 4: Update reindexNote to include metadata**

```typescript
// Update in reindexNote function (around line 317-327)
const metadata = extractMetadata(noteDetails.content);

const record: NoteRecord = {
  id: noteDetails.id,
  title: noteDetails.title,
  content: noteDetails.content,
  vector,
  folder: noteDetails.folder,
  created: noteDetails.created,
  modified: noteDetails.modified,
  indexed_at: new Date().toISOString(),
  tags: metadata.tags,
  outlinks: metadata.outlinks,
};
```

**Step 5: Run type check**

Run: `bun run check`
Expected: PASS

**Step 6: Run existing tests**

Run: `bun run test`
Expected: All PASS

**Step 7: Commit**

```bash
git add src/search/indexer.ts
git commit -m "feat(indexer): extract tags and outlinks during indexing"
```

---

## Task 4: Knowledge Graph Query Module

**Files:**
- Create: `src/graph/queries.ts`
- Test: `src/graph/queries.test.ts`

**Step 1: Write failing test for listTags**

```typescript
// src/graph/queries.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { listTags, searchByTag, findRelatedNotes } from "./queries.js";

// Mock the vector store
vi.mock("../db/lancedb.js", () => ({
  getVectorStore: vi.fn(() => ({
    getAll: vi.fn(),
    search: vi.fn(),
  })),
}));

describe("listTags", () => {
  it("aggregates tags with counts", async () => {
    const { getVectorStore } = await import("../db/lancedb.js");
    const mockStore = getVectorStore() as any;

    mockStore.getAll.mockResolvedValue([
      { id: "1", title: "Note 1", tags: ["project", "idea"], outlinks: [] },
      { id: "2", title: "Note 2", tags: ["project", "todo"], outlinks: [] },
      { id: "3", title: "Note 3", tags: ["idea"], outlinks: [] },
    ]);

    const result = await listTags();

    expect(result).toEqual([
      { tag: "project", count: 2 },
      { tag: "idea", count: 2 },
      { tag: "todo", count: 1 },
    ]);
  });

  it("returns empty array when no tags", async () => {
    const { getVectorStore } = await import("../db/lancedb.js");
    const mockStore = getVectorStore() as any;

    mockStore.getAll.mockResolvedValue([
      { id: "1", title: "Note 1", tags: [], outlinks: [] },
    ]);

    const result = await listTags();
    expect(result).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun run test src/graph/queries.test.ts`
Expected: FAIL - module not found

**Step 3: Implement listTags**

```typescript
// src/graph/queries.ts
/**
 * Knowledge graph query operations.
 */

import { getVectorStore, type NoteRecord } from "../db/lancedb.js";
import { createDebugLogger } from "../utils/debug.js";

const debug = createDebugLogger("GRAPH");

export interface TagCount {
  tag: string;
  count: number;
}

/**
 * List all tags with occurrence counts.
 * Sorted by count descending.
 */
export async function listTags(): Promise<TagCount[]> {
  debug("Listing all tags");

  const store = getVectorStore();
  const records = await store.getAll();

  // Aggregate tag counts
  const counts = new Map<string, number>();
  for (const record of records) {
    for (const tag of record.tags ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  // Sort by count descending
  const result = Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);

  debug(`Found ${result.length} unique tags`);
  return result;
}
```

**Step 4: Run test**

Run: `bun run test src/graph/queries.test.ts`
Expected: PASS

**Step 5: Add tests for searchByTag**

```typescript
// Add to src/graph/queries.test.ts
describe("searchByTag", () => {
  it("finds notes with specific tag", async () => {
    const { getVectorStore } = await import("../db/lancedb.js");
    const mockStore = getVectorStore() as any;

    mockStore.getAll.mockResolvedValue([
      { id: "1", title: "Note 1", folder: "Work", tags: ["project"], content: "...", modified: "2026-01-01" },
      { id: "2", title: "Note 2", folder: "Personal", tags: ["project", "idea"], content: "...", modified: "2026-01-02" },
      { id: "3", title: "Note 3", folder: "Work", tags: ["todo"], content: "...", modified: "2026-01-03" },
    ]);

    const result = await searchByTag("project");

    expect(result).toHaveLength(2);
    expect(result[0].title).toBe("Note 1");
    expect(result[1].title).toBe("Note 2");
  });

  it("filters by folder", async () => {
    const { getVectorStore } = await import("../db/lancedb.js");
    const mockStore = getVectorStore() as any;

    mockStore.getAll.mockResolvedValue([
      { id: "1", title: "Note 1", folder: "Work", tags: ["project"], content: "...", modified: "2026-01-01" },
      { id: "2", title: "Note 2", folder: "Personal", tags: ["project"], content: "...", modified: "2026-01-02" },
    ]);

    const result = await searchByTag("project", { folder: "Work" });

    expect(result).toHaveLength(1);
    expect(result[0].folder).toBe("Work");
  });

  it("respects limit", async () => {
    const { getVectorStore } = await import("../db/lancedb.js");
    const mockStore = getVectorStore() as any;

    mockStore.getAll.mockResolvedValue([
      { id: "1", title: "Note 1", folder: "Work", tags: ["project"], content: "...", modified: "2026-01-01" },
      { id: "2", title: "Note 2", folder: "Work", tags: ["project"], content: "...", modified: "2026-01-02" },
      { id: "3", title: "Note 3", folder: "Work", tags: ["project"], content: "...", modified: "2026-01-03" },
    ]);

    const result = await searchByTag("project", { limit: 2 });

    expect(result).toHaveLength(2);
  });
});
```

**Step 6: Implement searchByTag**

```typescript
// Add to src/graph/queries.ts
import type { SearchResult } from "../types/index.js";

export interface SearchByTagOptions {
  folder?: string;
  limit?: number;
}

/**
 * Find notes with a specific tag.
 */
export async function searchByTag(
  tag: string,
  options: SearchByTagOptions = {}
): Promise<SearchResult[]> {
  const { folder, limit = 20 } = options;

  debug(`Searching for tag: ${tag}`);

  const store = getVectorStore();
  const records = await store.getAll();

  // Filter by tag
  let matches = records.filter(r =>
    (r.tags ?? []).includes(tag.toLowerCase())
  );

  // Filter by folder if specified
  if (folder) {
    const normalizedFolder = folder.toLowerCase();
    matches = matches.filter(r => r.folder.toLowerCase() === normalizedFolder);
  }

  // Transform to SearchResult and limit
  const results: SearchResult[] = matches.slice(0, limit).map((r, i) => ({
    id: r.id,
    title: r.title,
    folder: r.folder,
    preview: r.content.slice(0, 200) + (r.content.length > 200 ? "..." : ""),
    modified: r.modified,
    score: 1 / (1 + i),  // Rank-based score
  }));

  debug(`Found ${results.length} notes with tag: ${tag}`);
  return results;
}
```

**Step 7: Run tests**

Run: `bun run test src/graph/queries.test.ts`
Expected: PASS

**Step 8: Add tests for findRelatedNotes**

```typescript
// Add to src/graph/queries.test.ts
describe("findRelatedNotes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("finds notes by shared tags", async () => {
    const { getVectorStore } = await import("../db/lancedb.js");
    const mockStore = getVectorStore() as any;

    mockStore.getAll.mockResolvedValue([
      { id: "1", title: "Source", folder: "Work", tags: ["project", "idea"], outlinks: [], vector: [1,0,0] },
      { id: "2", title: "Related", folder: "Work", tags: ["project"], outlinks: [], vector: [0,1,0] },
      { id: "3", title: "Unrelated", folder: "Work", tags: ["todo"], outlinks: [], vector: [0,0,1] },
    ]);

    const result = await findRelatedNotes("1", { types: ["tag"] });

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Related");
    expect(result[0].relationship).toBe("tag");
    expect(result[0].sharedTags).toContain("project");
  });

  it("finds notes by outlinks", async () => {
    const { getVectorStore } = await import("../db/lancedb.js");
    const mockStore = getVectorStore() as any;

    mockStore.getAll.mockResolvedValue([
      { id: "1", title: "Source", folder: "Work", tags: [], outlinks: ["Target"], vector: [1,0,0] },
      { id: "2", title: "Target", folder: "Work", tags: [], outlinks: [], vector: [0,1,0] },
    ]);

    const result = await findRelatedNotes("1", { types: ["link"] });

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Target");
    expect(result[0].relationship).toBe("link");
    expect(result[0].direction).toBe("outgoing");
  });

  it("finds backlinks", async () => {
    const { getVectorStore } = await import("../db/lancedb.js");
    const mockStore = getVectorStore() as any;

    mockStore.getAll.mockResolvedValue([
      { id: "1", title: "Target", folder: "Work", tags: [], outlinks: [], vector: [1,0,0] },
      { id: "2", title: "Source", folder: "Work", tags: [], outlinks: ["Target"], vector: [0,1,0] },
    ]);

    const result = await findRelatedNotes("1", { types: ["link"] });

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Source");
    expect(result[0].direction).toBe("incoming");
  });

  it("finds similar notes by vector", async () => {
    const { getVectorStore } = await import("../db/lancedb.js");
    const mockStore = getVectorStore() as any;

    const sourceVector = [1, 0, 0];
    mockStore.getAll.mockResolvedValue([
      { id: "1", title: "Source", folder: "Work", tags: [], outlinks: [], vector: sourceVector },
      { id: "2", title: "Similar", folder: "Work", tags: [], outlinks: [], vector: [0.9, 0.1, 0] },
    ]);

    mockStore.search.mockResolvedValue([
      { id: "2", title: "Similar", folder: "Work", content: "...", modified: "2026-01-01", score: 0.95 },
    ]);

    const result = await findRelatedNotes("1", { types: ["similar"] });

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Similar");
    expect(result[0].relationship).toBe("similar");
  });

  it("combines multiple relationship types", async () => {
    const { getVectorStore } = await import("../db/lancedb.js");
    const mockStore = getVectorStore() as any;

    mockStore.getAll.mockResolvedValue([
      { id: "1", title: "Source", folder: "Work", tags: ["project"], outlinks: ["Linked"], vector: [1,0,0] },
      { id: "2", title: "Tagged", folder: "Work", tags: ["project"], outlinks: [], vector: [0,1,0] },
      { id: "3", title: "Linked", folder: "Work", tags: [], outlinks: [], vector: [0,0,1] },
    ]);

    mockStore.search.mockResolvedValue([
      { id: "2", title: "Tagged", folder: "Work", content: "...", modified: "2026-01-01", score: 0.8 },
    ]);

    const result = await findRelatedNotes("1", { types: ["tag", "link", "similar"] });

    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result.some(r => r.relationship === "tag")).toBe(true);
    expect(result.some(r => r.relationship === "link")).toBe(true);
  });
});
```

**Step 9: Implement findRelatedNotes**

```typescript
// Add to src/graph/queries.ts

export type RelationshipType = "tag" | "link" | "similar";

export interface RelatedNote {
  id: string;
  title: string;
  folder: string;
  relationship: RelationshipType;
  score: number;
  // For tag relationships
  sharedTags?: string[];
  // For link relationships
  direction?: "outgoing" | "incoming";
}

export interface FindRelatedOptions {
  types?: RelationshipType[];
  limit?: number;
}

/**
 * Find notes related to a source note by tags, links, or semantic similarity.
 */
export async function findRelatedNotes(
  sourceId: string,
  options: FindRelatedOptions = {}
): Promise<RelatedNote[]> {
  const { types = ["tag", "link", "similar"], limit = 10 } = options;

  debug(`Finding related notes for: ${sourceId}`);

  const store = getVectorStore();
  const allRecords = await store.getAll();

  // Find source note
  const source = allRecords.find(r => r.id === sourceId);
  if (!source) {
    throw new Error(`Note not found with ID: ${sourceId}`);
  }

  const results: RelatedNote[] = [];
  const seen = new Set<string>();

  // Find by shared tags
  if (types.includes("tag") && source.tags?.length > 0) {
    for (const record of allRecords) {
      if (record.id === sourceId || seen.has(record.id)) continue;

      const shared = (record.tags ?? []).filter(t => source.tags.includes(t));
      if (shared.length > 0) {
        results.push({
          id: record.id,
          title: record.title,
          folder: record.folder,
          relationship: "tag",
          score: 0.8 * (shared.length / source.tags.length),
          sharedTags: shared,
        });
        seen.add(record.id);
      }
    }
  }

  // Find by outlinks (notes this note links to)
  if (types.includes("link")) {
    for (const linkTitle of source.outlinks ?? []) {
      const linked = allRecords.find(r =>
        r.title.toLowerCase() === linkTitle.toLowerCase() &&
        r.id !== sourceId &&
        !seen.has(r.id)
      );
      if (linked) {
        results.push({
          id: linked.id,
          title: linked.title,
          folder: linked.folder,
          relationship: "link",
          score: 1.0,
          direction: "outgoing",
        });
        seen.add(linked.id);
      }
    }

    // Find backlinks (notes that link to this note)
    for (const record of allRecords) {
      if (record.id === sourceId || seen.has(record.id)) continue;

      const linksToSource = (record.outlinks ?? []).some(
        l => l.toLowerCase() === source.title.toLowerCase()
      );
      if (linksToSource) {
        results.push({
          id: record.id,
          title: record.title,
          folder: record.folder,
          relationship: "link",
          score: 1.0,
          direction: "incoming",
        });
        seen.add(record.id);
      }
    }
  }

  // Find by semantic similarity
  if (types.includes("similar") && source.vector?.length > 0) {
    const similarResults = await store.search(source.vector, limit + 1);

    for (const similar of similarResults) {
      if (similar.id === sourceId || seen.has(similar.id ?? "")) continue;

      results.push({
        id: similar.id ?? "",
        title: similar.title,
        folder: similar.folder,
        relationship: "similar",
        score: 0.5 * similar.score,
      });
      seen.add(similar.id ?? "");
    }
  }

  // Sort by score and limit
  results.sort((a, b) => b.score - a.score);

  debug(`Found ${results.length} related notes`);
  return results.slice(0, limit);
}
```

**Step 10: Run all tests**

Run: `bun run test src/graph/queries.test.ts`
Expected: PASS

**Step 11: Commit**

```bash
git add src/graph/queries.ts src/graph/queries.test.ts
git commit -m "feat(graph): add query functions for tags and related notes"
```

---

## Task 5: Graph Export Module

**Files:**
- Create: `src/graph/export.ts`
- Test: `src/graph/export.test.ts`

**Step 1: Write failing test for JSON export**

```typescript
// src/graph/export.test.ts
import { describe, it, expect, vi } from "vitest";
import { exportGraph, type GraphFormat } from "./export.js";

vi.mock("../db/lancedb.js", () => ({
  getVectorStore: vi.fn(() => ({
    getAll: vi.fn(),
  })),
}));

describe("exportGraph", () => {
  describe("JSON format", () => {
    it("exports nodes and edges", async () => {
      const { getVectorStore } = await import("../db/lancedb.js");
      const mockStore = getVectorStore() as any;

      mockStore.getAll.mockResolvedValue([
        { id: "1", title: "Note A", folder: "Work", tags: ["project"], outlinks: ["Note B"], vector: [1,0] },
        { id: "2", title: "Note B", folder: "Work", tags: ["project"], outlinks: [], vector: [0,1] },
      ]);

      const result = await exportGraph({ format: "json" });

      expect(result.nodes).toHaveLength(2);
      expect(result.edges.some(e => e.type === "link")).toBe(true);
      expect(result.edges.some(e => e.type === "tag")).toBe(true);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun run test src/graph/export.test.ts`
Expected: FAIL

**Step 3: Implement exportGraph with JSON format**

```typescript
// src/graph/export.ts
/**
 * Knowledge graph export to various formats.
 */

import { getVectorStore } from "../db/lancedb.js";
import { createDebugLogger } from "../utils/debug.js";

const debug = createDebugLogger("EXPORT");

export type GraphFormat = "json" | "graphml" | "obsidian";

export interface GraphNode {
  id: string;
  label: string;
  folder: string;
  tags: string[];
}

export interface GraphEdge {
  source: string;
  target: string;
  type: "link" | "tag" | "similar";
  weight: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ExportOptions {
  format: GraphFormat;
  folder?: string;
  includeSimilar?: boolean;
  outputPath?: string;  // For obsidian format
}

/**
 * Export knowledge graph to specified format.
 */
export async function exportGraph(options: ExportOptions): Promise<GraphData | string> {
  const { format, folder, includeSimilar = false } = options;

  debug(`Exporting graph in ${format} format`);

  const store = getVectorStore();
  let records = await store.getAll();

  // Filter by folder if specified
  if (folder) {
    const normalizedFolder = folder.toLowerCase();
    records = records.filter(r => r.folder.toLowerCase() === normalizedFolder);
  }

  // Build graph data
  const nodes: GraphNode[] = records.map(r => ({
    id: r.id,
    label: r.title,
    folder: r.folder,
    tags: r.tags ?? [],
  }));

  const edges: GraphEdge[] = [];
  const nodeIds = new Set(records.map(r => r.id));

  // Add link edges
  for (const record of records) {
    for (const linkTitle of record.outlinks ?? []) {
      const target = records.find(r => r.title.toLowerCase() === linkTitle.toLowerCase());
      if (target && nodeIds.has(target.id)) {
        edges.push({
          source: record.id,
          target: target.id,
          type: "link",
          weight: 1.0,
        });
      }
    }
  }

  // Add tag edges (notes sharing same tag)
  const tagGroups = new Map<string, string[]>();
  for (const record of records) {
    for (const tag of record.tags ?? []) {
      if (!tagGroups.has(tag)) {
        tagGroups.set(tag, []);
      }
      tagGroups.get(tag)!.push(record.id);
    }
  }

  for (const [, noteIds] of tagGroups) {
    if (noteIds.length < 2) continue;
    // Create edges between all pairs
    for (let i = 0; i < noteIds.length; i++) {
      for (let j = i + 1; j < noteIds.length; j++) {
        // Avoid duplicate edges
        const edgeKey = [noteIds[i], noteIds[j]].sort().join("-");
        const exists = edges.some(e =>
          [e.source, e.target].sort().join("-") === edgeKey && e.type === "tag"
        );
        if (!exists) {
          edges.push({
            source: noteIds[i],
            target: noteIds[j],
            type: "tag",
            weight: 0.8,
          });
        }
      }
    }
  }

  const graphData: GraphData = { nodes, edges };

  if (format === "json") {
    return graphData;
  }

  if (format === "graphml") {
    return toGraphML(graphData);
  }

  if (format === "obsidian") {
    return toObsidian(records, options.outputPath);
  }

  throw new Error(`Unknown format: ${format}`);
}

function toGraphML(data: GraphData): string {
  // Will implement in next step
  throw new Error("Not implemented");
}

async function toObsidian(records: any[], outputPath?: string): Promise<string> {
  // Will implement in next step
  throw new Error("Not implemented");
}
```

**Step 4: Run test**

Run: `bun run test src/graph/export.test.ts`
Expected: PASS

**Step 5: Add test for GraphML export**

```typescript
// Add to src/graph/export.test.ts
describe("GraphML format", () => {
  it("exports valid GraphML XML", async () => {
    const { getVectorStore } = await import("../db/lancedb.js");
    const mockStore = getVectorStore() as any;

    mockStore.getAll.mockResolvedValue([
      { id: "1", title: "Note A", folder: "Work", tags: [], outlinks: ["Note B"], vector: [] },
      { id: "2", title: "Note B", folder: "Work", tags: [], outlinks: [], vector: [] },
    ]);

    const result = await exportGraph({ format: "graphml" });

    expect(typeof result).toBe("string");
    expect(result).toContain('<?xml version="1.0"');
    expect(result).toContain("<graphml");
    expect(result).toContain("<node");
    expect(result).toContain("<edge");
  });
});
```

**Step 6: Implement GraphML export**

```typescript
// Update toGraphML in src/graph/export.ts

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function toGraphML(data: GraphData): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
    '  <key id="label" for="node" attr.name="label" attr.type="string"/>',
    '  <key id="folder" for="node" attr.name="folder" attr.type="string"/>',
    '  <key id="tags" for="node" attr.name="tags" attr.type="string"/>',
    '  <key id="type" for="edge" attr.name="type" attr.type="string"/>',
    '  <key id="weight" for="edge" attr.name="weight" attr.type="double"/>',
    '  <graph id="G" edgedefault="directed">',
  ];

  // Add nodes
  for (const node of data.nodes) {
    lines.push(`    <node id="${escapeXml(node.id)}">`);
    lines.push(`      <data key="label">${escapeXml(node.label)}</data>`);
    lines.push(`      <data key="folder">${escapeXml(node.folder)}</data>`);
    lines.push(`      <data key="tags">${escapeXml(node.tags.join(","))}</data>`);
    lines.push("    </node>");
  }

  // Add edges
  for (const edge of data.edges) {
    lines.push(`    <edge source="${escapeXml(edge.source)}" target="${escapeXml(edge.target)}">`);
    lines.push(`      <data key="type">${edge.type}</data>`);
    lines.push(`      <data key="weight">${edge.weight}</data>`);
    lines.push("    </edge>");
  }

  lines.push("  </graph>");
  lines.push("</graphml>");

  return lines.join("\n");
}
```

**Step 7: Run test**

Run: `bun run test src/graph/export.test.ts`
Expected: PASS

**Step 8: Add test for Obsidian export**

```typescript
// Add to src/graph/export.test.ts
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("Obsidian format", () => {
  it("creates vault structure with frontmatter", async () => {
    const { getVectorStore } = await import("../db/lancedb.js");
    const mockStore = getVectorStore() as any;

    mockStore.getAll.mockResolvedValue([
      {
        id: "1",
        title: "Note A",
        folder: "Work",
        tags: ["project"],
        outlinks: ["Note B"],
        content: "# Note A\n\nContent with [[Note B]] link.",
        created: "2026-01-09T10:00:00Z",
        modified: "2026-01-09T12:00:00Z",
      },
    ]);

    const tempDir = path.join(os.tmpdir(), `obsidian-test-${Date.now()}`);

    const result = await exportGraph({
      format: "obsidian",
      outputPath: tempDir
    });

    expect(typeof result).toBe("string");
    expect(result).toContain(tempDir);

    // Check file was created
    const notePath = path.join(tempDir, "Work", "Note A.md");
    const content = await fs.readFile(notePath, "utf-8");

    expect(content).toContain("---");
    expect(content).toContain("tags:");
    expect(content).toContain("- project");
    expect(content).toContain("[[Note B]]");

    // Cleanup
    await fs.rm(tempDir, { recursive: true });
  });
});
```

**Step 9: Implement Obsidian export**

```typescript
// Update toObsidian in src/graph/export.ts
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { NoteRecord } from "../db/lancedb.js";

async function toObsidian(records: NoteRecord[], outputPath?: string): Promise<string> {
  const vaultPath = outputPath ?? path.join(os.homedir(), "apple-notes-obsidian-export");

  debug(`Exporting to Obsidian vault: ${vaultPath}`);

  // Create vault directory
  await fs.mkdir(vaultPath, { recursive: true });

  for (const record of records) {
    // Create folder structure
    const folderPath = path.join(vaultPath, record.folder);
    await fs.mkdir(folderPath, { recursive: true });

    // Build frontmatter
    const frontmatter = [
      "---",
      "tags:",
      ...(record.tags ?? []).map(t => `  - ${t}`),
      `created: ${record.created}`,
      `modified: ${record.modified}`,
      `source_id: ${record.id}`,
      "---",
      "",
    ];

    // Content already has [[wiki-links]] preserved from markdown
    const fileContent = frontmatter.join("\n") + record.content;

    // Sanitize filename
    const safeTitle = record.title.replace(/[/\\:*?"<>|]/g, "-");
    const filePath = path.join(folderPath, `${safeTitle}.md`);

    await fs.writeFile(filePath, fileContent, "utf-8");
    debug(`Created: ${filePath}`);
  }

  return `Exported ${records.length} notes to ${vaultPath}`;
}
```

**Step 10: Run all export tests**

Run: `bun run test src/graph/export.test.ts`
Expected: PASS

**Step 11: Commit**

```bash
git add src/graph/export.ts src/graph/export.test.ts
git commit -m "feat(graph): add export to JSON, GraphML, and Obsidian formats"
```

---

## Task 6: MCP Tools Integration

**Files:**
- Modify: `src/index.ts`

**Step 1: Add imports**

```typescript
// Add to imports in src/index.ts
import { listTags, searchByTag, findRelatedNotes } from "./graph/queries.js";
import { exportGraph } from "./graph/export.js";
```

**Step 2: Add Zod schemas**

```typescript
// Add after existing schemas in src/index.ts

const ListTagsSchema = z.object({});

const SearchByTagSchema = z.object({
  tag: z.string().min(1).max(100),
  folder: z.string().max(200).optional(),
  limit: z.number().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_SEARCH_LIMIT),
});

const RelatedNotesSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
  types: z.array(z.enum(["tag", "link", "similar"])).default(["tag", "link", "similar"]),
  limit: z.number().min(1).max(50).default(10),
});

const ExportGraphSchema = z.object({
  format: z.enum(["json", "graphml", "obsidian"]),
  folder: z.string().max(200).optional(),
  include_similar: z.boolean().default(false),
  output_path: z.string().max(500).optional(),
});
```

**Step 3: Register new tools**

```typescript
// Add to the tools array in ListToolsRequestSchema handler

{
  name: "list-tags",
  description: "List all tags with occurrence counts",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
},
{
  name: "search-by-tag",
  description: "Find notes with a specific tag",
  inputSchema: {
    type: "object",
    properties: {
      tag: { type: "string", description: "Tag to search for (without #)" },
      folder: { type: "string", description: "Filter by folder (optional)" },
      limit: { type: "number", description: "Max results (default: 20)" },
    },
    required: ["tag"],
  },
},
{
  name: "related-notes",
  description: "Find notes related to a source note by tags, links, or semantic similarity",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Source note title (use folder/title or id:xxx)" },
      types: {
        type: "array",
        items: { type: "string", enum: ["tag", "link", "similar"] },
        description: "Relationship types to include (default: all)"
      },
      limit: { type: "number", description: "Max results (default: 10)" },
    },
    required: ["title"],
  },
},
{
  name: "export-graph",
  description: "Export knowledge graph to JSON, GraphML, or Obsidian vault format",
  inputSchema: {
    type: "object",
    properties: {
      format: {
        type: "string",
        enum: ["json", "graphml", "obsidian"],
        description: "Export format"
      },
      folder: { type: "string", description: "Filter by folder (optional)" },
      include_similar: { type: "boolean", description: "Include similarity edges (default: false)" },
      output_path: { type: "string", description: "Output path for Obsidian export (optional)" },
    },
    required: ["format"],
  },
},
```

**Step 4: Implement tool handlers**

```typescript
// Add to switch statement in CallToolRequestSchema handler

case "list-tags": {
  ListTagsSchema.parse(args);
  const tags = await listTags();

  if (tags.length === 0) {
    return textResponse("No tags found. Add #tags to your notes and reindex.");
  }

  return textResponse(JSON.stringify(tags, null, 2));
}

case "search-by-tag": {
  const params = SearchByTagSchema.parse(args);
  const results = await searchByTag(params.tag, {
    folder: params.folder,
    limit: params.limit,
  });

  if (results.length === 0) {
    return textResponse(`No notes found with tag: #${params.tag}`);
  }

  return textResponse(JSON.stringify(results, null, 2));
}

case "related-notes": {
  const params = RelatedNotesSchema.parse(args);

  // Resolve note to get ID
  const note = await getNoteByTitle(params.title);
  if (!note) {
    return errorResponse(`Note not found: "${params.title}"`);
  }

  const results = await findRelatedNotes(note.id, {
    types: params.types,
    limit: params.limit,
  });

  if (results.length === 0) {
    return textResponse("No related notes found.");
  }

  return textResponse(JSON.stringify(results, null, 2));
}

case "export-graph": {
  const params = ExportGraphSchema.parse(args);
  const result = await exportGraph({
    format: params.format,
    folder: params.folder,
    includeSimilar: params.include_similar,
    outputPath: params.output_path,
  });

  if (typeof result === "string") {
    return textResponse(result);
  }

  return textResponse(JSON.stringify(result, null, 2));
}
```

**Step 5: Run type check**

Run: `bun run check`
Expected: PASS

**Step 6: Run all tests**

Run: `bun run test`
Expected: PASS

**Step 7: Commit**

```bash
git add src/index.ts
git commit -m "feat(mcp): add knowledge graph tools - list-tags, search-by-tag, related-notes, export-graph"
```

---

## Task 7: Update README and CHANGELOG

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Step 1: Add Knowledge Graph section to README**

Add after CRUD Operations section:

```markdown
### Knowledge Graph

#### `list-tags`
List all tags with occurrence counts.

#### `search-by-tag`
Find notes with a specific tag.

```
tag: "project"
folder: "Work"    # optional
limit: 20         # default: 20
```

#### `related-notes`
Find notes related to a source note.

```
title: "My Note"
types: ["tag", "link", "similar"]  # default: all
limit: 10                           # default: 10
```

#### `export-graph`
Export knowledge graph to various formats.

```
format: "json"          # json, graphml, or obsidian
folder: "Work"          # optional filter
include_similar: false  # include similarity edges
output_path: "~/vault"  # for obsidian format
```

**Supported Formats:**
- `json` - For custom visualization (D3.js, web apps)
- `graphml` - For professional tools (Gephi, yEd, Cytoscape)
- `obsidian` - Full vault export with frontmatter metadata
```

**Step 2: Update CHANGELOG**

```markdown
## [Unreleased]

### Added
- Knowledge Graph features:
  - `#tag` parsing during indexing
  - `[[wiki-link]]` parsing for note connections
  - `list-tags` tool - view all tags with counts
  - `search-by-tag` tool - find notes by tag
  - `related-notes` tool - discover connected notes
  - `export-graph` tool with JSON, GraphML, and Obsidian formats
```

**Step 3: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: add knowledge graph documentation"
```

---

## Task 8: Final Verification

**Step 1: Run full test suite**

Run: `bun run test`
Expected: All PASS

**Step 2: Type check**

Run: `bun run check`
Expected: No errors

**Step 3: Manual smoke test**

```bash
# Start server in debug mode
DEBUG=true bun run start

# In Claude Code, test:
# 1. Index notes (to populate tags/outlinks)
# 2. list-tags
# 3. search-by-tag with a tag that exists
# 4. related-notes on a note with tags/links
# 5. export-graph format=json
```

**Step 4: Final commit**

```bash
git status  # Review all changes
git log --oneline -10  # Review commit history
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Metadata extraction | `src/graph/extract.ts` |
| 2 | Schema extension | `src/db/lancedb.ts` |
| 3 | Indexer update | `src/search/indexer.ts` |
| 4 | Query module | `src/graph/queries.ts` |
| 5 | Export module | `src/graph/export.ts` |
| 6 | MCP tools | `src/index.ts` |
| 7 | Documentation | `README.md`, `CHANGELOG.md` |
| 8 | Verification | Manual testing |
