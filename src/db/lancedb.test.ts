import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LanceDBStore } from "./lancedb.js";
import type { NoteRecord } from "./lancedb.js";
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
});
