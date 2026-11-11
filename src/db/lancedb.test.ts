import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as lancedb from "@lancedb/lancedb";
import {
  LanceDBStore,
  ChunkStore,
  assertIndexCompatible,
  chunkSchema,
  recordIndexModel,
} from "./lancedb.js";
import type { NoteRecord, ChunkRecord } from "./lancedb.js";

let testDbPath: string;

beforeEach(() => {
  testDbPath = fs.mkdtempSync(path.join(os.tmpdir(), "lancedb-test-"));
});

afterEach(() => {
  fs.rmSync(testDbPath, { recursive: true, force: true });
});

const record = (id: string, overrides: Partial<NoteRecord> = {}): NoteRecord => ({
  id,
  title: `Note ${id}`,
  folder: "Test",
  content: `Content of ${id}`,
  modified: "2026-01-01T00:00:00.000Z",
  created: "2026-01-01T00:00:00.000Z",
  indexed_at: "2026-01-02T00:00:00.000Z",
  vector: Array(8).fill(0.1),
  tags: [],
  outlinks: [],
  ...overrides,
});

const chunk = (noteId: string, index: number, overrides: Partial<ChunkRecord> = {}): ChunkRecord => ({
  chunk_id: `${noteId}_chunk_${index}`,
  note_id: noteId,
  note_title: `Note ${noteId}`,
  folder: "Test",
  chunk_index: index,
  total_chunks: 2,
  content: `Chunk ${index} of ${noteId}`,
  vector: Array(8).fill(0.1),
  created: "2026-01-01T00:00:00.000Z",
  modified: "2026-01-01T00:00:00.000Z",
  indexed_at: "2026-01-02T00:00:00.000Z",
  tags: [],
  outlinks: [],
  ...overrides,
});

describe("LanceDBStore", () => {
  let store: LanceDBStore;

  beforeEach(() => {
    store = new LanceDBStore(testDbPath);
  });

  it("indexes a first batch whose tags and outlinks are all empty", async () => {
    await store.index([record("1"), record("2")]);
    await store.addRecords([record("3")]);

    const all = await store.getAllMetadata();
    expect(all).toHaveLength(3);
    for (const row of all) {
      expect(row.tags).toEqual([]);
      expect(row.outlinks).toEqual([]);
    }
  });

  it("keeps mixed list values per record", async () => {
    await store.index([
      record("1", { tags: ["a", "b"] }),
      record("2", { outlinks: ["Note 1"] }),
    ]);

    expect((await store.getById("1"))?.tags).toEqual(["a", "b"]);
    expect((await store.getById("1"))?.outlinks).toEqual([]);
    expect((await store.getById("2"))?.outlinks).toEqual(["Note 1"]);
  });

  it("overwrites an existing table, including one with different vector dims", async () => {
    await store.index([record("old")]);
    await store.index([record("new", { vector: Array(16).fill(0.2) })]);

    expect(await store.count()).toBe(1);
    expect((await store.getById("new"))?.vector).toHaveLength(16);
    expect(await store.getById("old")).toBeNull();
  });

  it("upserting one of two same-title notes in different folders keeps the other", async () => {
    await store.index([
      record("a", { title: "Untitled", folder: "Work" }),
      record("b", { title: "Untitled", folder: "Home" }),
    ]);

    await store.upsert([record("a", { title: "Untitled", folder: "Work", content: "edited" })]);

    expect(await store.count()).toBe(2);
    expect((await store.getById("a"))?.content).toBe("edited");
    expect((await store.getById("b"))?.folder).toBe("Home");
  });

  it("upsert inserts unknown ids", async () => {
    await store.index([record("a")]);
    await store.upsert([record("b")]);
    expect(await store.count()).toBe(2);
  });

  it("deleteByIds removes only the given ids", async () => {
    await store.index([record("a"), record("b"), record("c")]);
    await store.deleteByIds(["a", "c", "missing"]);

    const ids = (await store.getIndexMetadata()).map((r) => r.id);
    expect(ids).toEqual(["b"]);
  });

  it("getIndexMetadata includes the note's modified date", async () => {
    await store.index([record("a", { modified: "2026-03-04T05:06:07.000Z" })]);
    expect(await store.getIndexMetadata()).toEqual([
      {
        id: "a",
        title: "Note a",
        folder: "Test",
        modified: "2026-03-04T05:06:07.000Z",
        indexed_at: "2026-01-02T00:00:00.000Z",
      },
    ]);
  });

  it("getAllMetadata returns rows without vectors", async () => {
    await store.index([record("a", { tags: ["x"] })]);
    const [row] = await store.getAllMetadata();
    expect(row).not.toHaveProperty("vector");
    expect(row.tags).toEqual(["x"]);
    expect(row.content).toBe("Content of a");
  });

  it("matches titles and folders with backslash, quote and newline in filters", async () => {
    const tricky = [
      record("x\\1", { title: "a\\b", folder: "C:\\dir" }),
      record("x'2", { title: "O'Brien", folder: "it's" }),
      record("x\n3", { title: "line1\nline2", folder: "tab\there" }),
    ];
    await store.index([...tricky, record("keep")]);

    for (const r of tricky) {
      expect((await store.getById(r.id))?.title).toBe(r.title);
    }

    await store.deleteByIds(tricky.map((r) => r.id));
    expect((await store.getIndexMetadata()).map((r) => r.id)).toEqual(["keep"]);
  });

  it("vector search returns note rows with ids", async () => {
    await store.index([record("a"), record("b")]);
    const results = await store.search(Array(8).fill(0.1), 2);
    expect(results.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("searchFTS finds matching content", async () => {
    await store.index([
      record("a", { content: "Meeting notes about planning" }),
      record("b", { content: "Shopping list" }),
    ]);
    const results = await store.searchFTS("Meeting", 10);
    expect(results.map((r) => r.id)).toEqual(["a"]);
  });

  it("count is 0 and getIndexMetadata throws when no table exists", async () => {
    expect(await store.count()).toBe(0);
    await expect(store.getIndexMetadata()).rejects.toThrow("Index not found");
  });

  it("clear drops the table and lets a later index recreate it", async () => {
    await store.index([record("a")]);
    await store.clear();
    expect(await store.count()).toBe(0);

    await store.index([record("b")]);
    expect((await store.getIndexMetadata()).map((r) => r.id)).toEqual(["b"]);
  });
});

describe("ChunkStore", () => {
  let chunkStore: ChunkStore;

  beforeEach(() => {
    chunkStore = new ChunkStore(testDbPath);
  });

  it("indexes chunks whose tags and outlinks are all empty", async () => {
    await chunkStore.indexChunks([chunk("n1", 0), chunk("n1", 1)]);
    await chunkStore.addChunks([chunk("n2", 0)]);
    expect(await chunkStore.count()).toBe(3);
  });

  it("deleteChunksByNoteIds removes every chunk of the given notes only", async () => {
    await chunkStore.indexChunks([chunk("n1", 0), chunk("n1", 1), chunk("n2", 0), chunk("n3", 0)]);
    await chunkStore.deleteChunksByNoteIds(["n1", "n3"]);

    expect((await chunkStore.getNoteMetadata()).map((m) => m.note_id)).toEqual(["n2"]);
  });

  it("getNoteMetadata returns one entry per note with modified", async () => {
    await chunkStore.indexChunks([
      chunk("n1", 0, { modified: "2026-05-01T00:00:00.000Z" }),
      chunk("n1", 1, { modified: "2026-05-01T00:00:00.000Z" }),
      chunk("n2", 0, { modified: "2026-06-01T00:00:00.000Z" }),
    ]);

    const metadata = await chunkStore.getNoteMetadata();
    expect(metadata.sort((a, b) => a.note_id.localeCompare(b.note_id))).toEqual([
      { note_id: "n1", modified: "2026-05-01T00:00:00.000Z" },
      { note_id: "n2", modified: "2026-06-01T00:00:00.000Z" },
    ]);
  });

  it("searchChunks returns chunk rows with note ids and numeric indexes", async () => {
    await chunkStore.indexChunks([chunk("n1", 0), chunk("n1", 1)]);
    const results = await chunkStore.searchChunks(Array(8).fill(0.1), 2);
    expect(results.map((r) => r.note_id)).toEqual(["n1", "n1"]);
    expect(results.map((r) => r.chunk_index).sort()).toEqual([0, 1]);
  });

  it("searchChunksFTS finds content, including chunks added later after a rebuild", async () => {
    await chunkStore.indexChunks([chunk("n1", 0, { content: "Meeting notes about planning" })]);
    await chunkStore.addChunks([chunk("n2", 0, { content: "Grocery shopping list" })]);
    await chunkStore.rebuildFtsIndex();

    expect((await chunkStore.searchChunksFTS("Meeting", 10)).map((r) => r.note_id)).toEqual(["n1"]);
    expect((await chunkStore.searchChunksFTS("Grocery", 10)).map((r) => r.note_id)).toEqual(["n2"]);
  });

  it("searchChunksFTS returns [] when the table has no FTS index", async () => {
    // A table created outside indexChunks (e.g. a legacy table) may lack the FTS index.
    const db = await lancedb.connect(testDbPath);
    await db.createTable("chunks", [chunk("n1", 0)], { schema: chunkSchema(8) });

    expect(await chunkStore.searchChunksFTS("Chunk", 10)).toEqual([]);
  });
});

describe("embedding model guard", () => {
  it("passes when nothing was recorded", async () => {
    await expect(assertIndexCompatible("Local (e5)", 384, testDbPath)).resolves.toBeUndefined();
  });

  it("passes for the recorded model and throws when provider or dims differ", async () => {
    await recordIndexModel("Local (e5)", 384, testDbPath);

    await expect(assertIndexCompatible("Local (e5)", 384, testDbPath)).resolves.toBeUndefined();
    await expect(assertIndexCompatible("OpenRouter (qwen)", 4096, testDbPath)).rejects.toThrow(
      "Embedding model changed (Local (e5), 384 dims -> OpenRouter (qwen), 4096 dims). Run purge-index, then index-notes mode=full."
    );
    await expect(assertIndexCompatible("Local (e5)", 1024, testDbPath)).rejects.toThrow("Embedding model changed");
  });

  it("clear (purge) removes the record", async () => {
    const store = new LanceDBStore(testDbPath);
    await store.index([record("a")]);
    await recordIndexModel("Local (e5)", 8, testDbPath);

    await store.clear();

    await expect(assertIndexCompatible("Other", 4096, testDbPath)).resolves.toBeUndefined();
  });
});
