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
      const byNote = new Map(
        this.rows.map((r) => [
          r.note_id,
          { note_id: r.note_id, note_title: r.note_title, folder: r.folder, modified: r.modified },
        ])
      );
      return [...byNote.values()];
    }
    async getContentVectors(noteIds?: string[]) {
      if (!this.exists) throw new Error("Chunk index not found. Run index-notes first.");
      const ids = noteIds && new Set(noteIds);
      return new Map(this.rows.filter((r) => !ids || ids.has(r.note_id)).map((r) => [r.content, r.vector]));
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

  return {
    notes: new NotesTable(),
    chunks: new ChunksTable(),
    NotesTable,
    ChunksTable,
    /** Recorded index model (index-model.json). */
    model: null as { description: string; dims: number } | null,
    /** Active embedding provider. */
    provider: "Test (model, 3 dims)",
  };
});

vi.mock("../db/lancedb.js", () => ({
  getVectorStore: () => db.notes,
  getChunkStore: () => db.chunks,
  assertIndexCompatible: vi.fn(),
  indexModelMatches: async (description: string, dims: number) =>
    db.model?.description === description && db.model.dims === dims,
  recordIndexModel: vi.fn(async (description: string, dims: number) => {
    db.model = { description, dims };
  }),
}));

vi.mock("../notes/read.js", () => ({
  getAllNotesWithFallback: vi.fn(),
  getNoteById: vi.fn(),
  getNoteByTitle: vi.fn(),
}));

// Text-dependent vectors so reuse and note means are observable.
vi.mock("../embeddings/index.js", () => ({
  getEmbeddingBatch: vi.fn(async (texts: string[]) =>
    texts.map((t) => [t.length, t.charCodeAt(0), t.charCodeAt(t.length - 1)])
  ),
  getEmbeddingDimensions: () => 3,
  getProviderDescription: () => db.provider,
}));

import { indexNotes, reindexNote, syncNotesById, getLastIndexCompletedAtMs } from "./indexer.js";
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

function embeddedTexts(): string[] {
  return vi.mocked(getEmbeddingBatch).mock.calls.flatMap((c) => c[0]);
}

function normalizedMean(vectors: number[][]): number[] {
  const sum = vectors[0].map((_, i) => vectors.reduce((acc, v) => acc + v[i], 0));
  const norm = Math.hypot(...sum);
  return sum.map((v) => v / norm);
}

beforeEach(() => {
  vi.clearAllMocks();
  db.notes = new db.NotesTable();
  db.chunks = new db.ChunksTable();
  db.model = null;
  db.provider = "Test (model, 3 dims)";
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

  it("sets each note vector to the normalized mean of its chunk vectors", async () => {
    const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} about something.`).join(" ");
    library([makeNote("a", "A", long)]);

    await indexNotes("full");

    const chunkVectors = db.chunks.rows.map((r) => r.vector);
    expect(chunkVectors.length).toBeGreaterThan(1);
    const noteVector = db.notes.rows.get("a")?.vector ?? [];
    normalizedMean(chunkVectors).forEach((v, i) => expect(noteVector[i]).toBeCloseTo(v, 10));
  });

  it("reuses stored vectors when reindexing with the same model", async () => {
    library([makeNote("a", "A", "alpha"), makeNote("b", "B", "beta")]);
    await indexNotes("full");
    const before = db.chunks.rows.map((r) => r.vector);

    vi.mocked(getEmbeddingBatch).mockClear();
    const result = await indexNotes("full");

    expect(getEmbeddingBatch).not.toHaveBeenCalled();
    expect(db.chunks.rows.map((r) => r.vector)).toEqual(before);
    expect(result).toMatchObject({ embedded: 0, reused: 2, chunks: 2 });
  });

  it("embeds only chunks whose text changed", async () => {
    library([makeNote("a", "A", "alpha"), makeNote("b", "B", "beta")]);
    await indexNotes("full");

    library([makeNote("a", "A", "alpha v2", "2026-02-01T00:00:00Z"), makeNote("b", "B", "beta")]);
    vi.mocked(getEmbeddingBatch).mockClear();
    const result = await indexNotes("full");

    expect(embeddedTexts()).toEqual(["alpha v2"]);
    expect(result).toMatchObject({ embedded: 1, reused: 1 });
  });

  it("embeds everything when the embedding model changed", async () => {
    library([makeNote("a", "A", "alpha"), makeNote("b", "B", "beta")]);
    await indexNotes("full");

    db.provider = "Other (model, 3 dims)";
    vi.mocked(getEmbeddingBatch).mockClear();
    const result = await indexNotes("full");

    expect(embeddedTexts().sort()).toEqual(["alpha", "beta"]);
    expect(result).toMatchObject({ embedded: 2, reused: 0 });
  });

  it("embeds everything when no model was recorded", async () => {
    library([makeNote("a", "A", "alpha")]);
    await indexNotes("full");
    db.model = null;

    vi.mocked(getEmbeddingBatch).mockClear();
    await indexNotes("full");

    expect(embeddedTexts()).toEqual(["alpha"]);
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
    // Only the changed chunk is embedded; the note vector is derived from it.
    expect(embeddedTexts()).toEqual(["new text"]);
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

  it("keeps every row of a folder skipped as a whole, in both tables", async () => {
    library([
      makeNote("a", "A", "alpha", undefined, "Q1/Plans"),
      makeNote("b", "B", "beta", undefined, "Q1/Plans"),
      makeNote("c", "C", "gamma", undefined, "Home"),
      makeNote("d", "D", "delta", undefined, "Home"),
    ]);
    await indexNotes("full");

    library([makeNote("c", "C", "gamma", undefined, "Home")], ["Q1/Plans"]);
    await indexNotes("incremental");

    expect([...db.notes.rows.keys()].sort()).toEqual(["a", "b", "c"]);
    expect(chunkContents("a")).toEqual(["alpha"]);
    expect(chunkContents("b")).toEqual(["beta"]);
    expect(chunkContents("d")).toEqual([]);
  });

  it("keeps every row of a folder with an unidentified skipped note, in both tables", async () => {
    library([
      makeNote("a", "A", "alpha"),
      makeNote("b", "B", "beta"),
      makeNote("c", "C", "gamma", undefined, "Home"),
    ]);
    await indexNotes("full");

    library([makeNote("a", "A", "alpha")], ["Work/#1"]);
    await indexNotes("incremental");

    expect(db.notes.rows.has("b")).toBe(true);
    expect(chunkContents("b")).toEqual(["beta"]);
    expect(db.notes.rows.has("c")).toBe(false);
    expect(chunkContents("c")).toEqual([]);
  });

  it("keeps skipped notes from chunk metadata when the notes table is missing", async () => {
    library([makeNote("a", "A", "alpha"), makeNote("b", "B", "beta")]);
    await indexNotes("full");
    await db.notes.clear();

    library([makeNote("a", "A", "alpha")], ["Work"]);
    await indexNotes("incremental");

    expect(chunkContents("b")).toEqual(["beta"]);
  });

  it("rewrites a note moved to another folder in both tables without embedding", async () => {
    library([makeNote("a", "A", "alpha"), makeNote("b", "B", "beta")]);
    await indexNotes("full");
    const vectorBefore = db.notes.rows.get("a")?.vector;

    library([makeNote("a", "A", "alpha", undefined, "Archive"), makeNote("b", "B", "beta")]);
    vi.mocked(getEmbeddingBatch).mockClear();
    const result = await indexNotes("incremental");

    expect(getEmbeddingBatch).not.toHaveBeenCalled();
    expect(db.notes.rows.get("a")?.folder).toBe("Archive");
    expect(db.notes.rows.get("a")?.vector).toEqual(vectorBefore);
    expect(db.chunks.rows.filter((r) => r.note_id === "a").map((r) => r.folder)).toEqual(["Archive"]);
    expect(result.breakdown).toMatchObject({ updated: 1, added: 0, deleted: 0 });
  });

  it("records completion time after a run that changed nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      library([makeNote("a", "A", "alpha")]);
      vi.setSystemTime(1_000_000);
      await indexNotes("full");
      expect(getLastIndexCompletedAtMs()).toBe(1_000_000);

      vi.setSystemTime(2_000_000);
      const result = await indexNotes("incremental");

      expect(result.indexed).toBe(0);
      expect(getLastIndexCompletedAtMs()).toBe(2_000_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rebuilds a missing notes table from reused chunk vectors", async () => {
    library([makeNote("a", "A", "alpha"), makeNote("b", "B", "beta")]);
    await indexNotes("full");
    await db.notes.clear();

    vi.mocked(getEmbeddingBatch).mockClear();
    const result = await indexNotes("incremental");

    expect(getEmbeddingBatch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ indexed: 2, chunks: 0, embedded: 0, reused: 2 });
    const chunkVector = db.chunks.rows.find((r) => r.note_id === "a")?.vector ?? [];
    expect(db.notes.rows.get("a")?.vector).toEqual(normalizedMean([chunkVector]));
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
