import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type { NoteDetails } from "../notes/read.js";
import type { ChunkRecord } from "../db/lancedb.js";

// Mock dependencies before importing the module under test
vi.mock("../embeddings/index.js", () => ({
  getEmbeddingBatch: vi.fn(),
}));

vi.mock("../db/lancedb.js", () => ({
  getChunkStore: vi.fn(() => ({
    indexChunks: vi.fn(),
    count: vi.fn().mockResolvedValue(0),
  })),
}));

vi.mock("../notes/read.js", () => ({
  getAllNotesWithContent: vi.fn(),
}));

vi.mock("../utils/debug.js", () => ({
  createDebugLogger: vi.fn(() => vi.fn()),
}));

// Import after mocking
import { chunkNote, fullChunkIndex, hasChunkIndex } from "./chunk-indexer.js";
import { getEmbeddingBatch } from "../embeddings/index.js";
import { getChunkStore } from "../db/lancedb.js";
import { getAllNotesWithContent } from "../notes/read.js";

describe("chunk-indexer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("chunkNote", () => {
    // Note: content must be at least 50 chars to pass the content filter
    it("creates chunks for a note with content", () => {
      const content = "This is a test note content that is long enough to pass the minimum content length requirement for indexing.";
      const note: NoteDetails = {
        id: "note-123",
        title: "Test Note",
        folder: "Work",
        content,
        htmlContent: `<p>${content}</p>`,
        created: "2024-01-01T00:00:00.000Z",
        modified: "2024-01-02T00:00:00.000Z",
      };

      const chunks = chunkNote(note);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        chunk_id: "note-123_chunk_0",
        note_id: "note-123",
        note_title: "Test Note",
        folder: "Work",
        chunk_index: 0,
        total_chunks: 1,
        content,
        created: "2024-01-01T00:00:00.000Z",
        modified: "2024-01-02T00:00:00.000Z",
      });
      // Vector should be empty - not generated yet
      expect(chunks[0].vector).toEqual([]);
      // indexed_at should be empty - set during batch processing
      expect(chunks[0].indexed_at).toBe("");
      // Tags and outlinks should be extracted
      expect(chunks[0].tags).toEqual([]);
      expect(chunks[0].outlinks).toEqual([]);
    });

    it("returns single chunk for notes under chunk size", () => {
      const note: NoteDetails = {
        id: "short-note",
        title: "Short",
        folder: "Notes",
        content: "This is a shorter note but still has enough content to pass the minimum length filter requirement.",
        htmlContent: "",
        created: "2024-01-01T00:00:00.000Z",
        modified: "2024-01-01T00:00:00.000Z",
      };

      const chunks = chunkNote(note);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].chunk_index).toBe(0);
      expect(chunks[0].total_chunks).toBe(1);
    });

    it("returns empty array for empty notes", () => {
      const note: NoteDetails = {
        id: "empty-note",
        title: "Empty",
        folder: "Notes",
        content: "",
        htmlContent: "",
        created: "2024-01-01T00:00:00.000Z",
        modified: "2024-01-01T00:00:00.000Z",
      };

      const chunks = chunkNote(note);

      expect(chunks).toHaveLength(0);
    });

    it("returns empty array for whitespace-only notes", () => {
      const note: NoteDetails = {
        id: "whitespace-note",
        title: "Whitespace",
        folder: "Notes",
        content: "   \n\n   ",
        htmlContent: "",
        created: "2024-01-01T00:00:00.000Z",
        modified: "2024-01-01T00:00:00.000Z",
      };

      const chunks = chunkNote(note);

      expect(chunks).toHaveLength(0);
    });

    it("extracts tags from note content", () => {
      const note: NoteDetails = {
        id: "tagged-note",
        title: "Tagged Note",
        folder: "Work",
        content: "This note has #important and #work tags. It also contains enough text to pass the minimum content length requirement.",
        htmlContent: "",
        created: "2024-01-01T00:00:00.000Z",
        modified: "2024-01-01T00:00:00.000Z",
      };

      const chunks = chunkNote(note);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].tags).toContain("important");
      expect(chunks[0].tags).toContain("work");
    });

    it("extracts outlinks from note content", () => {
      const note: NoteDetails = {
        id: "linked-note",
        title: "Linked Note",
        folder: "Work",
        content: "This links to [[Other Note]] and [[Another Note]]. This is additional content to meet the minimum length requirement.",
        htmlContent: "",
        created: "2024-01-01T00:00:00.000Z",
        modified: "2024-01-01T00:00:00.000Z",
      };

      const chunks = chunkNote(note);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].outlinks).toContain("Other Note");
      expect(chunks[0].outlinks).toContain("Another Note");
    });

    it("creates multiple chunks for long notes", () => {
      // Create a long note that will produce multiple chunks
      const longContent = "This is paragraph one. ".repeat(50) + "\n\n" +
                          "This is paragraph two. ".repeat(50);
      const note: NoteDetails = {
        id: "long-note",
        title: "Long Note",
        folder: "Work",
        content: longContent,
        htmlContent: "",
        created: "2024-01-01T00:00:00.000Z",
        modified: "2024-01-01T00:00:00.000Z",
      };

      const chunks = chunkNote(note);

      expect(chunks.length).toBeGreaterThan(1);
      // Verify chunk IDs are unique
      const chunkIds = chunks.map(c => c.chunk_id);
      expect(new Set(chunkIds).size).toBe(chunks.length);
      // Verify indices are correct
      chunks.forEach((chunk, i) => {
        expect(chunk.chunk_index).toBe(i);
        expect(chunk.total_chunks).toBe(chunks.length);
        expect(chunk.chunk_id).toBe(`long-note_chunk_${i}`);
      });
    });
  });

  describe("fullChunkIndex", () => {
    it("processes notes and creates chunks with embeddings", async () => {
      // Note: content must be at least 50 chars to pass content filter
      const mockNotes: NoteDetails[] = [
        {
          id: "note-1",
          title: "Note 1",
          folder: "Work",
          content: "This is the first note content with enough text to pass the minimum length filter requirement.",
          htmlContent: "",
          created: "2024-01-01T00:00:00.000Z",
          modified: "2024-01-02T00:00:00.000Z",
        },
        {
          id: "note-2",
          title: "Note 2",
          folder: "Personal",
          content: "This is the second note content with enough text to pass the minimum length filter requirement.",
          htmlContent: "",
          created: "2024-01-01T00:00:00.000Z",
          modified: "2024-01-02T00:00:00.000Z",
        },
      ];

      const mockVectors = [
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ];

      const mockIndexChunks = vi.fn();
      (getAllNotesWithContent as Mock).mockResolvedValue(mockNotes);
      (getEmbeddingBatch as Mock).mockResolvedValue(mockVectors);
      (getChunkStore as Mock).mockReturnValue({
        indexChunks: mockIndexChunks,
        count: vi.fn().mockResolvedValue(0),
      });

      const result = await fullChunkIndex();

      // Verify all notes were fetched
      expect(getAllNotesWithContent).toHaveBeenCalledOnce();

      // Verify embeddings were generated for chunks
      expect(getEmbeddingBatch).toHaveBeenCalledOnce();
      const embeddingTexts = (getEmbeddingBatch as Mock).mock.calls[0][0];
      expect(embeddingTexts).toHaveLength(2);

      // Verify chunks were stored with vectors
      expect(mockIndexChunks).toHaveBeenCalledOnce();
      const storedChunks = mockIndexChunks.mock.calls[0][0] as ChunkRecord[];
      expect(storedChunks).toHaveLength(2);
      expect(storedChunks[0].vector).toEqual([0.1, 0.2, 0.3]);
      expect(storedChunks[1].vector).toEqual([0.4, 0.5, 0.6]);

      // Verify indexed_at is set
      storedChunks.forEach(chunk => {
        expect(chunk.indexed_at).toBeTruthy();
        // Should be valid ISO date
        expect(new Date(chunk.indexed_at).toISOString()).toBe(chunk.indexed_at);
      });

      // Verify result
      expect(result).toMatchObject({
        totalNotes: 2,
        totalChunks: 2,
        indexed: 2,
      });
      expect(result.timeMs).toBeGreaterThanOrEqual(0);
    });

    it("handles empty note list", async () => {
      (getAllNotesWithContent as Mock).mockResolvedValue([]);
      const mockIndexChunks = vi.fn();
      (getChunkStore as Mock).mockReturnValue({
        indexChunks: mockIndexChunks,
        count: vi.fn().mockResolvedValue(0),
      });

      const result = await fullChunkIndex();

      expect(result).toMatchObject({
        totalNotes: 0,
        totalChunks: 0,
        indexed: 0,
      });
      // Should not call embedding or indexing for empty list
      expect(getEmbeddingBatch).not.toHaveBeenCalled();
      expect(mockIndexChunks).not.toHaveBeenCalled();
    });

    it("skips empty notes in chunking", async () => {
      // Note: content must be at least 50 chars to pass content filter
      const mockNotes: NoteDetails[] = [
        {
          id: "note-1",
          title: "Note 1",
          folder: "Work",
          content: "This is valid note content with enough characters to pass the minimum length requirement for indexing.",
          htmlContent: "",
          created: "2024-01-01T00:00:00.000Z",
          modified: "2024-01-02T00:00:00.000Z",
        },
        {
          id: "note-2",
          title: "Empty Note",
          folder: "Work",
          content: "", // Empty!
          htmlContent: "",
          created: "2024-01-01T00:00:00.000Z",
          modified: "2024-01-02T00:00:00.000Z",
        },
      ];

      const mockIndexChunks = vi.fn();
      (getAllNotesWithContent as Mock).mockResolvedValue(mockNotes);
      (getEmbeddingBatch as Mock).mockResolvedValue([[0.1, 0.2, 0.3]]);
      (getChunkStore as Mock).mockReturnValue({
        indexChunks: mockIndexChunks,
        count: vi.fn().mockResolvedValue(0),
      });

      const result = await fullChunkIndex();

      // Only 1 chunk should be created (empty note skipped)
      expect(result.totalNotes).toBe(2);
      expect(result.totalChunks).toBe(1);
      expect(result.indexed).toBe(1);

      const storedChunks = mockIndexChunks.mock.calls[0][0] as ChunkRecord[];
      expect(storedChunks).toHaveLength(1);
      expect(storedChunks[0].note_title).toBe("Note 1");
    });
  });

  describe("hasChunkIndex", () => {
    it("returns true when chunk index exists", async () => {
      (getChunkStore as Mock).mockReturnValue({
        count: vi.fn().mockResolvedValue(10),
      });

      const result = await hasChunkIndex();

      expect(result).toBe(true);
    });

    it("returns false when chunk index is empty", async () => {
      (getChunkStore as Mock).mockReturnValue({
        count: vi.fn().mockResolvedValue(0),
      });

      const result = await hasChunkIndex();

      expect(result).toBe(false);
    });

    it("returns false when chunk store throws (table not found)", async () => {
      (getChunkStore as Mock).mockReturnValue({
        count: vi.fn().mockRejectedValue(new Error("Chunk index not found")),
      });

      const result = await hasChunkIndex();

      expect(result).toBe(false);
    });
  });
});
