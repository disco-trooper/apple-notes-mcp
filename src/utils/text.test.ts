import { describe, it, expect } from "vitest";
import { truncateForEmbedding } from "./text.js";
import { MAX_INPUT_LENGTH } from "../config/constants.js";

describe("truncateForEmbedding", () => {
  it("should return text unchanged if within limit", () => {
    const text = "Short text";
    expect(truncateForEmbedding(text)).toBe(text);
  });

  it("should truncate text exceeding default limit", () => {
    const text = "a".repeat(MAX_INPUT_LENGTH + 100);
    const result = truncateForEmbedding(text);
    expect(result.length).toBe(MAX_INPUT_LENGTH);
    expect(result).toBe("a".repeat(MAX_INPUT_LENGTH));
  });

  it("should use custom maxLength when provided", () => {
    const text = "Hello World";
    const result = truncateForEmbedding(text, 5);
    expect(result).toBe("Hello");
  });

  it("should handle empty string", () => {
    expect(truncateForEmbedding("")).toBe("");
  });

  it("should handle text exactly at limit", () => {
    const text = "a".repeat(MAX_INPUT_LENGTH);
    expect(truncateForEmbedding(text)).toBe(text);
  });
});
