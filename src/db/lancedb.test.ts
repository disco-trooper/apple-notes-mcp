import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LanceDBStore, ChunkStore } from "./lancedb.js";
import type { NoteRecord, ChunkRecord } from "./lancedb.js";
import * as fs from "node:fs";
import * as path from "node:path";

describe("LanceDBStore", () => {
  let store: LanceDBStore;
  let testDbPath: string;

  beforeEach(() => {
    testDbPath = path.join("/tmp", `lancedb-test-${Date.now()}`);
    store = new LanceDBStore(testDbPath);
  });

  afterEach(() => {
    if (fs.existsSync(testDbPath)) {
      fs.rmSync(testDbPath, { recursive: true, force: true });
    }
  });

  const createTestRecord = (title: string): NoteRecord => ({
    id: `test-id-${title.toLowerCase().replace(/\s+/g, "-")}`,
    title,
    folder: "Test",
    content: `Content of ${title}`,
    modified: new Date().toISOString(),
    created: new Date().toISOString(),
    indexed_at: new Date().toISOString(),
    vector: Array(384).fill(0.1),
    // LanceDB requires at least one element to infer the list type
    tags: ["test-tag"],
    outlinks: ["test-link"],
  });

  describe("index and getByTitle", () => {
    it("indexes and retrieves a record", async () => {
      const record = createTestRecord("Test Note");
      await store.index([record]);
      const retrieved = await store.getByTitle("Test Note");
      expect(retrieved).not.toBeNull();
      expect(retrieved?.title).toBe("Test Note");
    });

    it("returns null for non-existent title", async () => {
      await store.index([createTestRecord("Other")]); // Initialize table
      const retrieved = await store.getByTitle("Does Not Exist");
      expect(retrieved).toBeNull();
    });
  });

  describe("count", () => {
    it("returns correct count", async () => {
      await store.index([createTestRecord("Note 1"), createTestRecord("Note 2")]);
      expect(await store.count()).toBe(2);
    });

    it("returns 0 for empty store", async () => {
      expect(await store.count()).toBe(0);
    });
  });

  describe("delete", () => {
    it("deletes existing record", async () => {
      await store.index([createTestRecord("Delete Me")]);
      await store.delete("Delete Me");
      const retrieved = await store.getByTitle("Delete Me");
      expect(retrieved).toBeNull();
    });

    it("does not throw when deleting non-existent record", async () => {
      await store.index([createTestRecord("Existing")]);
      await expect(store.delete("Non Existent")).resolves.not.toThrow();
    });
  });

  describe("getAll", () => {
    it("returns all indexed records", async () => {
      await store.index([
        createTestRecord("Note 1"),
        createTestRecord("Note 2"),
        createTestRecord("Note 3"),
      ]);
      const all = await store.getAll();
      expect(all).toHaveLength(3);
      const titles = all.map((r) => r.title);
      expect(titles).toContain("Note 1");
      expect(titles).toContain("Note 2");
      expect(titles).toContain("Note 3");
    });
  });

  describe("update", () => {
    it("updates existing record content", async () => {
      await store.index([createTestRecord("Update Me")]);

      const updatedRecord = createTestRecord("Update Me");
      updatedRecord.content = "New updated content";
      await store.update(updatedRecord);

      const retrieved = await store.getByTitle("Update Me");
      expect(retrieved?.content).toBe("New updated content");
    });

    it("adds new record if title does not exist", async () => {
      await store.index([createTestRecord("Existing")]);

      const newRecord = createTestRecord("New Note");
      await store.update(newRecord);

      const retrieved = await store.getByTitle("New Note");
      expect(retrieved).not.toBeNull();
      expect(retrieved?.title).toBe("New Note");
    });
  });

  describe("clear", () => {
    it("removes all records", async () => {
      await store.index([
        createTestRecord("Note 1"),
        createTestRecord("Note 2"),
      ]);
      expect(await store.count()).toBe(2);

      await store.clear();
      expect(await store.count()).toBe(0);
    });
  });

  describe("search", () => {
    it("returns results based on vector similarity", async () => {
      await store.index([
        createTestRecord("Note 1"),
        createTestRecord("Note 2"),
      ]);

      const queryVector = Array(384).fill(0.1);
      const results = await store.search(queryVector, 2);

      expect(results).toHaveLength(2);
      expect(results[0]).toHaveProperty("title");
      expect(results[0]).toHaveProperty("score");
    });
  });

  describe("rebuildFtsIndex", () => {
    it("rebuilds FTS index without error", async () => {
      await store.index([
        createTestRecord("FTS Note 1"),
        createTestRecord("FTS Note 2"),
      ]);

      await expect(store.rebuildFtsIndex()).resolves.not.toThrow();
    });

    it("works after indexing records", async () => {
      await store.index([createTestRecord("Note A")]);

      // Rebuild should work on existing table
      await expect(store.rebuildFtsIndex()).resolves.not.toThrow();

      // Index more records and rebuild again
      await store.index([createTestRecord("Note B")]);
      await expect(store.rebuildFtsIndex()).resolves.not.toThrow();
    });
  });

  describe("searchFTS", () => {
    it("returns results matching query text", async () => {
      await store.index([
        createTestRecord("Meeting notes"),
        createTestRecord("Shopping list"),
      ]);
      await store.rebuildFtsIndex();

      const results = await store.searchFTS("Meeting", 10);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].title).toBe("Meeting notes");
    });

    it("returns empty array for no matches", async () => {
      await store.index([createTestRecord("Test note")]);
      await store.rebuildFtsIndex();

      const results = await store.searchFTS("nonexistentquery12345", 10);
      expect(results).toHaveLength(0);
    });
  });
});

describe("ChunkStore", () => {
  let chunkStore: ChunkStore;
  let testDbPath: string;

  beforeEach(() => {
    testDbPath = path.join("/tmp", `lancedb-chunk-test-${Date.now()}`);
    chunkStore = new ChunkStore(testDbPath);
  });

  afterEach(() => {
    if (fs.existsSync(testDbPath)) {
      fs.rmSync(testDbPath, { recursive: true, force: true });
    }
  });

  const createTestChunk = (
    noteId: string,
    chunkIndex: number,
    totalChunks: number,
    content?: string
  ): ChunkRecord => ({
    chunk_id: `${noteId}_chunk_${chunkIndex}`,
    note_id: noteId,
    note_title: `Note ${noteId}`,
    folder: "Test",
    chunk_index: chunkIndex,
    total_chunks: totalChunks,
    content: content ?? `Chunk ${chunkIndex} content for note ${noteId}`,
    vector: Array(384).fill(0.1),
    created: new Date().toISOString(),
    modified: new Date().toISOString(),
    indexed_at: new Date().toISOString(),
    tags: ["test-tag"],
    outlinks: ["test-link"],
  });

  describe("indexChunks", () => {
    it("indexes chunks and allows retrieval", async () => {
      const chunks = [
        createTestChunk("note-1", 0, 2),
        createTestChunk("note-1", 1, 2),
        createTestChunk("note-2", 0, 1),
      ];

      await chunkStore.indexChunks(chunks);
      const count = await chunkStore.count();

      expect(count).toBe(3);
    });

    it("handles empty chunks array", async () => {
      await chunkStore.indexChunks([]);
      const count = await chunkStore.count();
      expect(count).toBe(0);
    });

    it("handles chunks with empty tags and outlinks", async () => {
      const chunks = [
        { ...createTestChunk("note-1", 0, 1), tags: [], outlinks: [] },
      ];

      await chunkStore.indexChunks(chunks);
      const count = await chunkStore.count();
      expect(count).toBe(1);
    });
  });

  describe("searchChunks", () => {
    it("returns results based on vector similarity", async () => {
      const chunks = [
        createTestChunk("note-1", 0, 2),
        createTestChunk("note-1", 1, 2),
      ];
      await chunkStore.indexChunks(chunks);

      const queryVector = Array(384).fill(0.1);
      const results = await chunkStore.searchChunks(queryVector, 2);

      expect(results).toHaveLength(2);
      expect(results[0]).toHaveProperty("chunk_id");
      expect(results[0]).toHaveProperty("note_id");
      expect(results[0]).toHaveProperty("score");
    });
  });

  describe("searchChunksFTS", () => {
    it("returns results matching query text", async () => {
      const chunks = [
        createTestChunk("note-1", 0, 1, "Meeting notes about project planning"),
        createTestChunk("note-2", 0, 1, "Shopping list for groceries"),
      ];
      await chunkStore.indexChunks(chunks);
      await chunkStore.rebuildFtsIndex();

      const results = await chunkStore.searchChunksFTS("Meeting", 10);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].content).toContain("Meeting");
    });

    it("returns empty array for no matches", async () => {
      const chunks = [createTestChunk("note-1", 0, 1)];
      await chunkStore.indexChunks(chunks);
      await chunkStore.rebuildFtsIndex();

      const results = await chunkStore.searchChunksFTS("nonexistentquery12345", 10);
      expect(results).toHaveLength(0);
    });
  });

  describe("getChunksByNoteId", () => {
    it("returns all chunks for a note sorted by chunk_index", async () => {
      const chunks = [
        createTestChunk("note-1", 2, 3),
        createTestChunk("note-1", 0, 3),
        createTestChunk("note-1", 1, 3),
        createTestChunk("note-2", 0, 1),
      ];
      await chunkStore.indexChunks(chunks);

      const noteChunks = await chunkStore.getChunksByNoteId("note-1");

      expect(noteChunks).toHaveLength(3);
      expect(noteChunks[0].chunk_index).toBe(0);
      expect(noteChunks[1].chunk_index).toBe(1);
      expect(noteChunks[2].chunk_index).toBe(2);
    });

    it("returns empty array for non-existent note", async () => {
      await chunkStore.indexChunks([createTestChunk("note-1", 0, 1)]);

      const chunks = await chunkStore.getChunksByNoteId("non-existent");
      expect(chunks).toHaveLength(0);
    });
  });

  describe("deleteNoteChunks", () => {
    it("deletes all chunks for a note", async () => {
      const chunks = [
        createTestChunk("note-1", 0, 2),
        createTestChunk("note-1", 1, 2),
        createTestChunk("note-2", 0, 1),
      ];
      await chunkStore.indexChunks(chunks);

      await chunkStore.deleteNoteChunks("note-1");

      const remaining = await chunkStore.count();
      expect(remaining).toBe(1);

      const note1Chunks = await chunkStore.getChunksByNoteId("note-1");
      expect(note1Chunks).toHaveLength(0);

      const note2Chunks = await chunkStore.getChunksByNoteId("note-2");
      expect(note2Chunks).toHaveLength(1);
    });

    it("does not throw when deleting non-existent note chunks", async () => {
      await chunkStore.indexChunks([createTestChunk("note-1", 0, 1)]);
      await expect(chunkStore.deleteNoteChunks("non-existent")).resolves.not.toThrow();
    });
  });

  describe("count", () => {
    it("returns correct count", async () => {
      const chunks = [
        createTestChunk("note-1", 0, 2),
        createTestChunk("note-1", 1, 2),
        createTestChunk("note-2", 0, 1),
      ];
      await chunkStore.indexChunks(chunks);

      expect(await chunkStore.count()).toBe(3);
    });

    it("returns 0 for empty store", async () => {
      expect(await chunkStore.count()).toBe(0);
    });
  });

  describe("clear", () => {
    it("removes all chunks", async () => {
      await chunkStore.indexChunks([
        createTestChunk("note-1", 0, 1),
        createTestChunk("note-2", 0, 1),
      ]);
      expect(await chunkStore.count()).toBe(2);

      await chunkStore.clear();
      expect(await chunkStore.count()).toBe(0);
    });
  });

  describe("rebuildFtsIndex", () => {
    it("rebuilds FTS index without error", async () => {
      await chunkStore.indexChunks([
        createTestChunk("note-1", 0, 1),
        createTestChunk("note-2", 0, 1),
      ]);

      await expect(chunkStore.rebuildFtsIndex()).resolves.not.toThrow();
    });
  });
});
