import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChunkRecord, NoteRecord } from "../db/lancedb.js";
import type { NoteDetails } from "../notes/read.js";

/** In-memory stand-ins for the two LanceDB tables (state, not call echo). */
const db = vi.hoisted(() => {
  class NotesTable {
    exists = false;
    rows = new Map<string, NoteRecord>();
    async getIndexMetadata() {
      if (!this.exists) throw new Error("Index not found. Run index-notes first.");
      return [...this.rows.values()].map(({ id, title, folder, modified, indexed_at }) => ({
        id,
        title,
        folder,
        modified,
        indexed_at,
      }));
    }
    async index(records: NoteRecord[]) {
      this.exists = true;
      this.rows = new Map(records.map((r) => [r.id, r]));
    }
    async upsert(records: NoteRecord[]) {
      for (const r of records) this.rows.set(r.id, r);
    }
    async deleteByIds(ids: string[]) {
      for (const id of ids) this.rows.delete(id);
    }
    async rebuildFtsIndex() {}
    async count() {
      return this.exists ? this.rows.size : 0;
    }
    async clear() {
      this.exists = false;
      this.rows.clear();
    }
  }

  class ChunksTable {
    exists = false;
    rows: ChunkRecord[] = [];
    async getNoteMetadata() {
      if (!this.exists) throw new Error("Chunk index not found. Run index-notes first.");
      const byNote = new Map(this.rows.map((r) => [r.note_id, r.modified]));
      return [...byNote].map(([note_id, modified]) => ({ note_id, modified }));
    }
    async indexChunks(chunks: ChunkRecord[]) {
      this.exists = true;
      this.rows = [...chunks];
    }
    async addChunks(chunks: ChunkRecord[]) {
      this.rows.push(...chunks);
    }
    async deleteChunksByNoteIds(ids: string[]) {
      const drop = new Set(ids);
      this.rows = this.rows.filter((r) => !drop.has(r.note_id));
    }
    async rebuildFtsIndex() {}
    async count() {
      return this.exists ? this.rows.length : 0;
    }
    async clear() {
      this.exists = false;
      this.rows = [];
    }
  }

  return { notes: new NotesTable(), chunks: new ChunksTable(), NotesTable, ChunksTable };
});

vi.mock("../db/lancedb.js", () => ({
  getVectorStore: () => db.notes,
  getChunkStore: () => db.chunks,
  assertIndexCompatible: vi.fn(),
  recordIndexModel: vi.fn(),
}));

vi.mock("../notes/read.js", () => ({
  getAllNotesWithFallback: vi.fn(),
  getNoteById: vi.fn(),
  getNoteByTitle: vi.fn(),
}));

vi.mock("../embeddings/index.js", () => ({
  getEmbeddingBatch: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
  getProviderDescription: () => "Test (model, 3 dims)",
}));

import { indexNotes, reindexNote, syncNotesById } from "./indexer.js";
import { getAllNotesWithFallback, getNoteById, getNoteByTitle } from "../notes/read.js";
import { getEmbeddingBatch } from "../embeddings/index.js";
import { assertIndexCompatible } from "../db/lancedb.js";

function makeNote(id: string, title: string, content: string, modified = "2026-01-01T00:00:00Z", folder = "Work"): NoteDetails {
  return { id, title, folder, content, htmlContent: "", created: "2026-01-01T00:00:00Z", modified };
}

function library(notes: NoteDetails[], skipped: string[] = []): void {
  vi.mocked(getAllNotesWithFallback).mockResolvedValue({ notes, skipped });
}

function chunkContents(noteId: string): string[] {
  return db.chunks.rows.filter((r) => r.note_id === noteId).map((r) => r.content);
}

beforeEach(() => {
  vi.clearAllMocks();
  db.notes = new db.NotesTable();
  db.chunks = new db.ChunksTable();
});

describe("indexNotes full", () => {
  it("builds both tables from one fetch", async () => {
    library([makeNote("a", "A", "alpha"), makeNote("b", "B", "beta")]);

    const result = await indexNotes("full");

    expect(getAllNotesWithFallback).toHaveBeenCalledTimes(1);
    expect([...db.notes.rows.keys()].sort()).toEqual(["a", "b"]);
    expect(chunkContents("a")).toEqual(["alpha"]);
    expect(result).toMatchObject({ indexed: 2, chunks: 2 });
    expect(assertIndexCompatible).not.toHaveBeenCalled();
  });

  it("throws before writing when already cancelled", async () => {
    library([makeNote("a", "A", "alpha")]);
    const controller = new AbortController();
    controller.abort();

    await expect(indexNotes("full", { signal: controller.signal })).rejects.toThrow("Indexing cancelled");
    expect(db.notes.exists).toBe(false);
  });
});

describe("indexNotes incremental", () => {
  it("rewrites changed notes in both tables, leaving no stale chunks", async () => {
    library([makeNote("a", "A", "old text"), makeNote("b", "B", "beta")]);
    await indexNotes("full");

    library([makeNote("a", "A", "new text", "2026-02-01T00:00:00Z"), makeNote("b", "B", "beta")]);
    vi.mocked(getEmbeddingBatch).mockClear();
    const result = await indexNotes("incremental");

    expect(chunkContents("a")).toEqual(["new text"]);
    expect(db.notes.rows.get("a")?.content).toBe("new text");
    expect(result.breakdown).toEqual({ added: 0, updated: 1, deleted: 0, skipped: 1 });
    // Only the changed note is embedded (once for the notes table, once per chunk).
    expect(vi.mocked(getEmbeddingBatch).mock.calls.flatMap((c) => c[0])).toEqual(["new text", "new text"]);
  });

  it("removes deleted notes from both tables in a deletion-only run", async () => {
    library([makeNote("a", "A", "alpha"), makeNote("b", "B", "beta")]);
    await indexNotes("full");

    library([makeNote("a", "A", "alpha")]);
    const result = await indexNotes("incremental");

    expect(db.notes.rows.has("b")).toBe(false);
    expect(chunkContents("b")).toEqual([]);
    expect(result.breakdown?.deleted).toBe(1);
    expect(getEmbeddingBatch).toHaveBeenCalledTimes(1); // only the full run
  });

  it("deletes a note whose title contains '/'", async () => {
    library([makeNote("q", "Q1/Q2 plan", "quarterly"), makeNote("a", "A", "alpha")]);
    await indexNotes("full");

    library([makeNote("a", "A", "alpha")]);
    await indexNotes("incremental");

    expect(db.notes.rows.has("q")).toBe(false);
    expect(chunkContents("q")).toEqual([]);
  });

  it("keys same-title notes in one folder by id", async () => {
    library([makeNote("n1", "New Note", "first"), makeNote("n2", "New Note", "second")]);
    await indexNotes("full");

    library([makeNote("n1", "New Note", "first"), makeNote("n2", "New Note", "second")]);
    const result = await indexNotes("incremental");

    expect(db.notes.rows.size).toBe(2);
    expect(chunkContents("n1")).toEqual(["first"]);
    expect(chunkContents("n2")).toEqual(["second"]);
    expect(result.indexed).toBe(0);
  });

  it("drops old rows and chunks when a note becomes empty", async () => {
    library([makeNote("a", "A", "alpha"), makeNote("b", "B", "beta")]);
    await indexNotes("full");

    library([makeNote("a", "A", "", "2026-02-01T00:00:00Z"), makeNote("b", "B", "beta")]);
    await indexNotes("incremental");

    expect(db.notes.rows.has("a")).toBe(false);
    expect(chunkContents("a")).toEqual([]);
  });

  it("keeps rows of notes that could not be fetched this run", async () => {
    library([makeNote("a", "A", "alpha"), makeNote("b", "B", "beta")]);
    await indexNotes("full");

    library([makeNote("a", "A", "alpha")], ["Work/B"]);
    await indexNotes("incremental");

    expect(db.notes.rows.has("b")).toBe(true);
    expect(chunkContents("b")).toEqual(["beta"]);
  });

  it("builds a missing chunk table from an existing notes table", async () => {
    library([makeNote("a", "A", "alpha")]);
    await indexNotes("full");
    await db.chunks.clear();

    await indexNotes("incremental");

    expect(chunkContents("a")).toEqual(["alpha"]);
  });

  it("checks embedding-model compatibility before writing", async () => {
    library([makeNote("a", "A", "alpha")]);
    await indexNotes("full");

    library([makeNote("a", "A", "changed", "2026-02-01T00:00:00Z")]);
    vi.mocked(assertIndexCompatible).mockRejectedValueOnce(new Error("Embedding model changed"));

    await expect(indexNotes("incremental")).rejects.toThrow("Embedding model changed");
    expect(chunkContents("a")).toEqual(["alpha"]);
  });
});

describe("index lock", () => {
  it("serializes concurrent indexNotes runs", async () => {
    let releaseFirst!: () => void;
    const firstFetch = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    vi.mocked(getAllNotesWithFallback)
      .mockImplementationOnce(async () => {
        await firstFetch;
        return { notes: [makeNote("a", "A", "alpha")], skipped: [] };
      })
      .mockResolvedValueOnce({ notes: [makeNote("a", "A", "alpha")], skipped: [] });

    const first = indexNotes("full");
    const second = indexNotes("incremental");
    await vi.waitFor(() => expect(getAllNotesWithFallback).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 20; i++) await Promise.resolve(); // give the second run every chance to start

    expect(getAllNotesWithFallback).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.all([first, second]);
    expect(getAllNotesWithFallback).toHaveBeenCalledTimes(2);
  });
});

describe("single-note sync", () => {
  it("syncNotesById replaces a renamed note's rows and removes missing ids", async () => {
    library([makeNote("a", "Old", "alpha"), makeNote("b", "B", "beta")]);
    await indexNotes("full");

    vi.mocked(getNoteById).mockImplementation(async (id) =>
      id === "a" ? makeNote("a", "New", "alpha v2", "2026-02-01T00:00:00Z") : null
    );
    const missing = await syncNotesById(["a", "b"]);

    expect(missing).toEqual(["b"]);
    expect(db.notes.rows.get("a")?.title).toBe("New");
    expect(chunkContents("a")).toEqual(["alpha v2"]);
    expect(db.notes.rows.has("b")).toBe(false);
    expect(chunkContents("b")).toEqual([]);
  });

  it("reindexNote fails when no index exists", async () => {
    vi.mocked(getNoteByTitle).mockResolvedValue(makeNote("a", "A", "alpha"));

    await expect(reindexNote("A")).rejects.toThrow("Run index-notes first");
  });
});
