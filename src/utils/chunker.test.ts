import { describe, expect, it } from "vitest";
import { chunkText, type ChunkOptions, findSplitPoint } from "./chunker.js";

/** Deterministic pseudo-random prose with mixed separators. */
function sampleText(length: number, seed = 1): string {
  const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
  const seps = [" ", " ", " ", ", ", ". ", "\n", "\n\n", " "];
  let out = "";
  let s = seed;
  while (out.length < length) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out += words[s % words.length] + seps[(s >> 8) % seps.length];
  }
  return out.slice(0, length);
}

describe("chunker", () => {
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

    it("never splits after the target", () => {
      const text = "aaaaaaaaaa bbbbbbbbbb\n\ncccc";
      expect(findSplitPoint(text, 15)).toBe(11);
    });

    it("does not search before minPos", () => {
      const text = "abcdefgh ijklmnopqrst";
      expect(findSplitPoint(text, 12)).toBe(9);
      expect(findSplitPoint(text, 12, 6)).toBe(12);
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

    describe("invariants on long text", () => {
      const cases: Array<[string, ChunkOptions]> = [
        ["defaults", { chunkSize: 500, overlap: 100 }],
        ["small", { chunkSize: 60, overlap: 15 }],
        ["no overlap", { chunkSize: 80, overlap: 0 }],
      ];

      it.each(cases)("%s: chunks fit, overlap exactly and cover the text", (_name, options) => {
        const text = sampleText(5000, 7);
        const result = chunkText(text, options);

        expect(result[0].startPos).toBe(0);
        expect(result[result.length - 1].endPos).toBe(text.length);
        for (const chunk of result) {
          expect(chunk.content.length).toBeLessThanOrEqual(options.chunkSize);
          expect(chunk.content).toBe(text.slice(chunk.startPos, chunk.endPos));
        }
        for (let i = 1; i < result.length; i++) {
          expect(result[i].startPos).toBe(result[i - 1].endPos - options.overlap);
        }
      });

      it("makes progress when overlap is not smaller than chunk size", () => {
        const text = "x".repeat(50);
        const result = chunkText(text, { chunkSize: 10, overlap: 10 });

        for (let i = 1; i < result.length; i++) {
          expect(result[i].startPos).toBeGreaterThan(result[i - 1].startPos);
        }
        expect(result[result.length - 1].endPos).toBe(50);
      });

      it("never splits a surrogate pair", () => {
        const text = "😀".repeat(200); // no separators, every char is a pair
        const result = chunkText(text, { chunkSize: 25, overlap: 5 });

        for (const chunk of result) {
          expect(chunk.content.length).toBeLessThanOrEqual(25);
          expect(chunk.content).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
        }
        expect(result[result.length - 1].endPos).toBe(text.length);
      });
    });
  });
});
