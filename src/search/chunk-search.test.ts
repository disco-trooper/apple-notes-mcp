import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  rrfScore,
  deduplicateByNote,
  filterByFolder,
  searchChunks,
  type ChunkSearchResult,
} from "./chunk-search.js";

// Mock dependencies
vi.mock("../embeddings/index.js", () => ({
  getEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
}));

vi.mock("../db/lancedb.js", () => ({
  getChunkStore: vi.fn(),
}));

import { getChunkStore } from "../db/lancedb.js";

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

  it("returns correct score for rank 0", () => {
    expect(rrfScore(0)).toBeCloseTo(1 / 60, 5);
  });
});

describe("deduplicateByNote", () => {
  it("keeps best-scoring chunk per note", () => {
    const chunks: ChunkSearchResult[] = [
      {
        note_id: "note1",
        note_title: "Note 1",
        folder: "Work",
        matchedChunk: "chunk 1",
        matchedChunkIndex: 0,
        score: 0.8,
        modified: "2024-01-01",
      },
      {
        note_id: "note1",
        note_title: "Note 1",
        folder: "Work",
        matchedChunk: "chunk 2",
        matchedChunkIndex: 1,
        score: 0.9, // Higher score
        modified: "2024-01-01",
      },
      {
        note_id: "note2",
        note_title: "Note 2",
        folder: "Personal",
        matchedChunk: "chunk 1",
        matchedChunkIndex: 0,
        score: 0.7,
        modified: "2024-01-02",
      },
    ];

    const result = deduplicateByNote(chunks);

    expect(result).toHaveLength(2);
    // note1 should have the higher scoring chunk (0.9)
    const note1 = result.find((r) => r.note_id === "note1");
    expect(note1?.score).toBe(0.9);
    expect(note1?.matchedChunkIndex).toBe(1);
  });

  it("sorts by score descending", () => {
    const chunks: ChunkSearchResult[] = [
      {
        note_id: "note1",
        note_title: "Note 1",
        folder: "Work",
        matchedChunk: "chunk 1",
        matchedChunkIndex: 0,
        score: 0.5,
        modified: "2024-01-01",
      },
      {
        note_id: "note2",
        note_title: "Note 2",
        folder: "Personal",
        matchedChunk: "chunk 1",
        matchedChunkIndex: 0,
        score: 0.9,
        modified: "2024-01-02",
      },
      {
        note_id: "note3",
        note_title: "Note 3",
        folder: "Work",
        matchedChunk: "chunk 1",
        matchedChunkIndex: 0,
        score: 0.7,
        modified: "2024-01-03",
      },
    ];

    const result = deduplicateByNote(chunks);

    expect(result).toHaveLength(3);
    expect(result[0].score).toBe(0.9);
    expect(result[1].score).toBe(0.7);
    expect(result[2].score).toBe(0.5);
  });

  it("handles empty array", () => {
    const result = deduplicateByNote([]);
    expect(result).toHaveLength(0);
  });
});

describe("filterByFolder", () => {
  const mockChunks: ChunkSearchResult[] = [
    {
      note_id: "note1",
      note_title: "Note 1",
      folder: "Work",
      matchedChunk: "content",
      matchedChunkIndex: 0,
      score: 1,
      modified: "2024-01-01",
    },
    {
      note_id: "note2",
      note_title: "Note 2",
      folder: "Personal",
      matchedChunk: "content",
      matchedChunkIndex: 0,
      score: 0.9,
      modified: "2024-01-01",
    },
    {
      note_id: "note3",
      note_title: "Note 3",
      folder: "Work/Projects",
      matchedChunk: "content",
      matchedChunkIndex: 0,
      score: 0.8,
      modified: "2024-01-01",
    },
  ];

  it("filters by exact folder name (case insensitive)", () => {
    const filtered = filterByFolder(mockChunks, "work");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].note_title).toBe("Note 1");
  });

  it("returns all results when folder is undefined", () => {
    const filtered = filterByFolder(mockChunks, undefined);
    expect(filtered).toHaveLength(3);
  });

  it("returns empty array when no matches", () => {
    const filtered = filterByFolder(mockChunks, "NonExistent");
    expect(filtered).toHaveLength(0);
  });
});

describe("searchChunks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles empty query", async () => {
    const result = await searchChunks("");
    expect(result).toHaveLength(0);
  });

  it("handles whitespace-only query", async () => {
    const result = await searchChunks("   ");
    expect(result).toHaveLength(0);
  });

  it("deduplicates results by note", async () => {
    const mockStore = {
      searchChunks: vi.fn().mockResolvedValue([
        {
          chunk_id: "note1_chunk_0",
          note_id: "note1",
          note_title: "Note 1",
          folder: "Work",
          chunk_index: 0,
          total_chunks: 2,
          content: "first chunk",
          modified: "2024-01-01",
          score: 0.8,
        },
        {
          chunk_id: "note1_chunk_1",
          note_id: "note1",
          note_title: "Note 1",
          folder: "Work",
          chunk_index: 1,
          total_chunks: 2,
          content: "second chunk",
          modified: "2024-01-01",
          score: 0.9,
        },
        {
          chunk_id: "note2_chunk_0",
          note_id: "note2",
          note_title: "Note 2",
          folder: "Personal",
          chunk_index: 0,
          total_chunks: 1,
          content: "only chunk",
          modified: "2024-01-02",
          score: 0.7,
        },
      ]),
      searchChunksFTS: vi.fn().mockResolvedValue([]),
    };

    vi.mocked(getChunkStore).mockReturnValue(mockStore as unknown as ReturnType<typeof getChunkStore>);

    const results = await searchChunks("test query", { mode: "semantic" });

    // Should have 2 unique notes, not 3 chunks
    expect(results).toHaveLength(2);
    // note1 should have the higher scoring chunk (index 1, score 0.9)
    const note1 = results.find((r) => r.note_id === "note1");
    expect(note1?.matchedChunkIndex).toBe(1);
  });

  it("applies folder filter", async () => {
    const mockStore = {
      searchChunks: vi.fn().mockResolvedValue([
        {
          chunk_id: "note1_chunk_0",
          note_id: "note1",
          note_title: "Note 1",
          folder: "Work",
          chunk_index: 0,
          total_chunks: 1,
          content: "work content",
          modified: "2024-01-01",
          score: 0.9,
        },
        {
          chunk_id: "note2_chunk_0",
          note_id: "note2",
          note_title: "Note 2",
          folder: "Personal",
          chunk_index: 0,
          total_chunks: 1,
          content: "personal content",
          modified: "2024-01-02",
          score: 0.8,
        },
      ]),
      searchChunksFTS: vi.fn().mockResolvedValue([]),
    };

    vi.mocked(getChunkStore).mockReturnValue(mockStore as unknown as ReturnType<typeof getChunkStore>);

    const results = await searchChunks("test query", {
      mode: "semantic",
      folder: "Work",
    });

    expect(results).toHaveLength(1);
    expect(results[0].folder).toBe("Work");
  });

  it("respects limit option", async () => {
    const mockStore = {
      searchChunks: vi.fn().mockResolvedValue([
        {
          chunk_id: "note1_chunk_0",
          note_id: "note1",
          note_title: "Note 1",
          folder: "Work",
          chunk_index: 0,
          total_chunks: 1,
          content: "content 1",
          modified: "2024-01-01",
          score: 0.9,
        },
        {
          chunk_id: "note2_chunk_0",
          note_id: "note2",
          note_title: "Note 2",
          folder: "Work",
          chunk_index: 0,
          total_chunks: 1,
          content: "content 2",
          modified: "2024-01-02",
          score: 0.8,
        },
        {
          chunk_id: "note3_chunk_0",
          note_id: "note3",
          note_title: "Note 3",
          folder: "Work",
          chunk_index: 0,
          total_chunks: 1,
          content: "content 3",
          modified: "2024-01-03",
          score: 0.7,
        },
      ]),
      searchChunksFTS: vi.fn().mockResolvedValue([]),
    };

    vi.mocked(getChunkStore).mockReturnValue(mockStore as unknown as ReturnType<typeof getChunkStore>);

    const results = await searchChunks("test query", {
      mode: "semantic",
      limit: 2,
    });

    expect(results).toHaveLength(2);
  });
});
