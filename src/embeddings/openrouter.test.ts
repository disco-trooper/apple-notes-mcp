import { describe, it, expect } from "vitest";
import { getCacheKey } from "./openrouter.js";

describe("getCacheKey", () => {
  it("generates different keys for texts with same prefix", () => {
    const prefix = "a".repeat(100);
    const text1 = prefix + " first document content";
    const text2 = prefix + " second document content";
    expect(getCacheKey(text1)).not.toBe(getCacheKey(text2));
  });

  it("generates same key for identical texts", () => {
    const text = "This is a test document for embedding";
    expect(getCacheKey(text)).toBe(getCacheKey(text));
  });

  it("generates consistent hash format", () => {
    const key = getCacheKey("test");
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });
});
