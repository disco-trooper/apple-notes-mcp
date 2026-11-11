import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChunkRow } from "../db/lancedb.js";

vi.mock("../embeddings/index.js", () => ({
  getQueryEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  getProviderDescription: () => "Test (model, 3 dims)",
}));

vi.mock("../db/lancedb.js", () => ({
  getChunkStore: vi.fn(),
  assertIndexCompatible: vi.fn(),
}));

import { deduplicateByNote, searchChunks, type ChunkSearchResult } from "./chunk-search.js";
import { getChunkStore } from "../db/lancedb.js";
import { getQueryEmbedding } from "../embeddings/index.js";

function row(noteId: string, chunkIndex: number, score: number, folder = "Work"): ChunkRow {
  return {
    chunk_id: `${noteId}_chunk_${chunkIndex}`,
    note_id: noteId,
    note_title: `Title ${noteId}`,
    folder,
    chunk_index: chunkIndex,
    total_chunks: 2,
    content: `${noteId} chunk ${chunkIndex}`,
    modified: "2024-01-01",
    score,
  };
}

function useStore(vectorRows: ChunkRow[], fts: ChunkRow[] | Error = []) {
  const store = {
    searchChunks: vi.fn().mockResolvedValue(vectorRows),
    searchChunksFTS: fts instanceof Error ? vi.fn().mockRejectedValue(fts) : vi.fn().mockResolvedValue(fts),
  };
  vi.mocked(getChunkStore).mockReturnValue(store as never);
  return store;
}

describe("deduplicateByNote", () => {
  it("keeps the best-scoring chunk per note, sorted by score", () => {
    const result = (score: number, noteId: string, idx: number): ChunkSearchResult => ({
      note_id: noteId,
      note_title: noteId,
      folder: "Work",
      matchedChunk: "",
      matchedChunkIndex: idx,
      score,
      modified: "",
    });

    const deduped = deduplicateByNote([result(0.8, "a", 0), result(0.9, "a", 1), result(0.95, "b", 0)]);

    expect(deduped.map((r) => [r.note_id, r.matchedChunkIndex])).toEqual([
      ["b", 0],
      ["a", 1],
    ]);
  });
});

describe("searchChunks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns nothing for a blank query without touching the store", async () => {
    expect(await searchChunks("   ")).toEqual([]);
    expect(getChunkStore).not.toHaveBeenCalled();
  });

  it("embeds the query with the query role", async () => {
    useStore([row("a", 0, 1)]);

    await searchChunks("  project ideas ", { mode: "semantic" });

    expect(getQueryEmbedding).toHaveBeenCalledWith("project ideas");
  });

  it("returns one result per note with its best chunk", async () => {
    useStore([row("a", 0, 0.8), row("a", 1, 0.9), row("b", 0, 0.7)]);

    const results = await searchChunks("q", { mode: "semantic" });

    expect(results.map((r) => [r.note_id, r.matchedChunkIndex])).toEqual([
      ["a", 1],
      ["b", 0],
    ]);
  });

  it("filters by folder case-insensitively and applies the limit", async () => {
    useStore([row("a", 0, 0.9, "Work"), row("b", 0, 0.8, "Personal"), row("c", 0, 0.7, "work")]);

    const results = await searchChunks("q", { mode: "semantic", folder: "WORK", limit: 1 });

    expect(results.map((r) => r.note_id)).toEqual(["a"]);
  });

  it("ranks chunks found by both searches first in hybrid mode", async () => {
    useStore([row("a", 0, 1), row("b", 0, 0.5)], [row("b", 0, 1)]);

    const results = await searchChunks("q");

    expect(results.map((r) => r.note_id)).toEqual(["b", "a"]);
  });

  it("falls back to vector results when full-text search fails in hybrid mode", async () => {
    useStore([row("a", 0, 1)], new Error("bad query syntax"));

    const results = await searchChunks("foo (bar");

    expect(results.map((r) => r.note_id)).toEqual(["a"]);
  });

  it("over-fetches both rankings in hybrid mode", async () => {
    const store = useStore([row("a", 0, 1)]);

    await searchChunks("q", { limit: 20 });
    expect(store.searchChunks).toHaveBeenCalledWith(expect.any(Array), 80);
    expect(store.searchChunksFTS).toHaveBeenCalledWith("q", 80);

    await searchChunks("q", { limit: 20, folder: "Work" });
    expect(store.searchChunks).toHaveBeenLastCalledWith(expect.any(Array), 120);
    expect(store.searchChunksFTS).toHaveBeenLastCalledWith("q", 120);

    await searchChunks("q", { limit: 1 });
    expect(store.searchChunks).toHaveBeenLastCalledWith(expect.any(Array), 80);
  });

  it("surfaces full-text errors in keyword mode", async () => {
    useStore([], new Error("bad query syntax"));

    await expect(searchChunks("foo (bar", { mode: "keyword" })).rejects.toThrow("bad query syntax");
  });
});
