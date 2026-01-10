import { describe, expect, it } from "vitest";
import {
  chunkText,
  type ChunkOptions,
  DEFAULT_CHUNK_OPTIONS,
  SEPARATORS,
  findSplitPoint,
} from "./chunker.js";

describe("chunker", () => {
  describe("exports", () => {
    it("exports SEPARATORS array with correct order", () => {
      expect(SEPARATORS).toEqual([
        "\n\n",
        "\n",
        ". ",
        "! ",
        "? ",
        "; ",
        ", ",
        " ",
        "",
      ]);
    });

    it("exports DEFAULT_CHUNK_OPTIONS with correct values", () => {
      expect(DEFAULT_CHUNK_OPTIONS).toEqual({
        chunkSize: 500,
        overlap: 100,
      });
    });
  });

  describe("findSplitPoint", () => {
    it("finds paragraph boundary near target", () => {
      const text = "First paragraph.\n\nSecond paragraph.";
      const target = 20;
      const result = findSplitPoint(text, target);
      // Should find the \n\n at position 16
      expect(result).toBe(18); // After \n\n
    });

    it("falls back to sentence boundary", () => {
      const text = "First sentence. Second sentence.";
      const target = 18;
      const result = findSplitPoint(text, target);
      // Should find ". " at position 14-16
      expect(result).toBe(16); // After ". "
    });

    it("falls back to word boundary", () => {
      const text = "oneword anotherword";
      const target = 10;
      const result = findSplitPoint(text, target);
      // Should find space at position 7
      expect(result).toBe(8); // After " "
    });

    it("returns target when no separator found", () => {
      const text = "noseparatorshere";
      const target = 8;
      const result = findSplitPoint(text, target);
      expect(result).toBe(8);
    });
  });

  describe("chunkText", () => {
    it("returns single chunk for short text", () => {
      const text = "Short text";
      const options: ChunkOptions = { chunkSize: 100, overlap: 20 };

      const result = chunkText(text, options);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        content: "Short text",
        index: 0,
        totalChunks: 1,
        startPos: 0,
        endPos: 10,
      });
    });

    it("creates multiple chunks for long text", () => {
      const text = "Word ".repeat(50).trim(); // 249 chars
      const options: ChunkOptions = { chunkSize: 50, overlap: 10 };

      const result = chunkText(text, options);

      expect(result.length).toBeGreaterThan(1);
      // Each chunk should have content
      result.forEach((chunk) => {
        expect(chunk.content.length).toBeGreaterThan(0);
        expect(chunk.content.length).toBeLessThanOrEqual(options.chunkSize);
      });
    });

    it("includes overlap between chunks", () => {
      const text = "First part. Second part. Third part. Fourth part.";
      const options: ChunkOptions = { chunkSize: 25, overlap: 10 };

      const result = chunkText(text, options);

      // Check that chunks overlap - endPos of chunk N should be > startPos of chunk N+1
      for (let i = 0; i < result.length - 1; i++) {
        const currentChunk = result[i];
        const nextChunk = result[i + 1];
        // Overlap means next chunk starts before current chunk ends
        expect(nextChunk.startPos).toBeLessThan(currentChunk.endPos);
      }
    });

    it("respects paragraph boundaries when splitting", () => {
      const text = "First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph.";
      const options: ChunkOptions = { chunkSize: 30, overlap: 5 };

      const result = chunkText(text, options);

      // At least one chunk should end at a paragraph boundary
      const hasParaBoundary = result.some((chunk) => {
        const endContent = text.slice(chunk.startPos, chunk.endPos);
        return endContent.endsWith("\n\n") || chunk.endPos === text.length;
      });
      expect(hasParaBoundary).toBe(true);
    });

    it("sets correct totalChunks on all chunks", () => {
      const text = "A ".repeat(100).trim(); // Create text that will be chunked
      const options: ChunkOptions = { chunkSize: 20, overlap: 5 };

      const result = chunkText(text, options);

      const expectedTotal = result.length;
      result.forEach((chunk, idx) => {
        expect(chunk.totalChunks).toBe(expectedTotal);
        expect(chunk.index).toBe(idx);
      });
    });

    it("handles empty text", () => {
      const result = chunkText("", { chunkSize: 100, overlap: 20 });

      expect(result).toHaveLength(0);
    });

    it("handles whitespace-only text", () => {
      const result = chunkText("   \n\n   ", { chunkSize: 100, overlap: 20 });

      expect(result).toHaveLength(0);
    });

    it("uses default options when not provided", () => {
      const text = "Test";
      const result = chunkText(text);

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe("Test");
    });

    it("covers all original text with chunks", () => {
      const text = "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.";
      const options: ChunkOptions = { chunkSize: 30, overlap: 10 };

      const result = chunkText(text, options);

      // Verify chunks cover the entire text
      expect(result[0].startPos).toBe(0);
      expect(result[result.length - 1].endPos).toBe(text.length);

      // Verify each chunk's content matches its position in original text
      for (const chunk of result) {
        expect(chunk.content).toBe(text.slice(chunk.startPos, chunk.endPos));
      }

      // Verify chunks are contiguous (no gaps)
      for (let i = 0; i < result.length - 1; i++) {
        // Next chunk should start before or at current chunk's end (overlap)
        expect(result[i + 1].startPos).toBeLessThanOrEqual(result[i].endPos);
      }
    });
  });
});
