import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NoteDetails } from "../notes/read.js";

vi.mock("../db/lancedb.js", () => ({
  getChunkStore: vi.fn(),
}));

import { chunkNote, prepareNote, hasChunkIndex } from "./chunk-indexer.js";
import { getChunkStore } from "../db/lancedb.js";

function makeNote(overrides: Partial<NoteDetails> = {}): NoteDetails {
  return {
    id: "note-123",
    title: "Test Note",
    folder: "Work",
    content: "This is a test note.",
    htmlContent: "",
    created: "2024-01-01T00:00:00.000Z",
    modified: "2024-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function chunksOf(note: NoteDetails) {
  const prepared = prepareNote(note);
  if (!prepared) throw new Error("expected an indexable note");
  return chunkNote(prepared);
}

describe("prepareNote", () => {
  it("returns null for empty and whitespace-only notes", () => {
    expect(prepareNote(makeNote({ content: "" }))).toBeNull();
    expect(prepareNote(makeNote({ content: "   \n\n   " }))).toBeNull();
  });

  it("keeps short notes", () => {
    expect(prepareNote(makeNote({ content: "Buy milk" }))?.text).toBe("Buy milk");
  });

  it("redacts secrets before anything is embedded or stored", () => {
    const fakeAwsKey = ["AKIA", "ABCDEFGH", "IJKLMNOP"].join("");
    const prepared = prepareNote(makeNote({ content: `AWS key ${fakeAwsKey} for the staging bucket` }));
    expect(prepared?.text).not.toContain(fakeAwsKey);
    expect(prepared?.text).toContain("staging bucket");
  });

  it("extracts tags from the original content", () => {
    const prepared = prepareNote(makeNote({ content: "This note has #important and #work tags." }));
    expect(prepared?.tags).toEqual(expect.arrayContaining(["important", "work"]));
  });
});

describe("chunkNote", () => {
  it("creates one chunk keyed by note id for a short note", () => {
    const chunks = chunksOf(makeNote());

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      chunk_id: "note-123_chunk_0",
      note_id: "note-123",
      note_title: "Test Note",
      folder: "Work",
      chunk_index: 0,
      total_chunks: 1,
      content: "This is a test note.",
      modified: "2024-01-02T00:00:00.000Z",
    });
  });

  it("creates multiple consistently numbered chunks for long notes", () => {
    const content = "This is paragraph one. ".repeat(50) + "\n\n" + "This is paragraph two. ".repeat(50);
    const chunks = chunksOf(makeNote({ id: "long-note", content }));

    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((chunk, i) => {
      expect(chunk.chunk_index).toBe(i);
      expect(chunk.total_chunks).toBe(chunks.length);
      expect(chunk.chunk_id).toBe(`long-note_chunk_${i}`);
    });
  });
});

describe("hasChunkIndex", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is true only when the chunk table has rows", async () => {
    vi.mocked(getChunkStore).mockReturnValue({ count: vi.fn().mockResolvedValue(10) } as never);
    expect(await hasChunkIndex()).toBe(true);

    vi.mocked(getChunkStore).mockReturnValue({ count: vi.fn().mockResolvedValue(0) } as never);
    expect(await hasChunkIndex()).toBe(false);
  });
});
