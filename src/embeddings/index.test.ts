import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("embeddings index", () => {
  const originalApiKey = process.env.OPENROUTER_API_KEY;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.OPENROUTER_API_KEY;
  });

  afterEach(() => {
    if (originalApiKey !== undefined) {
      process.env.OPENROUTER_API_KEY = originalApiKey;
    } else {
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  describe("detectProvider", () => {
    it("should detect local provider when no API key", async () => {
      const { detectProvider } = await import("./index.js");
      expect(detectProvider()).toBe("local");
    });

    it("should detect openrouter provider when API key is set", async () => {
      process.env.OPENROUTER_API_KEY = "test-key";
      const { detectProvider } = await import("./index.js");
      expect(detectProvider()).toBe("openrouter");
    });
  });

  describe("getProvider", () => {
    it("should return detected provider", async () => {
      const { getProvider } = await import("./index.js");
      expect(getProvider()).toBe("local");
    });
  });

  describe("getEmbeddingDimensions", () => {
    it("should return dimensions for local provider", async () => {
      const { getEmbeddingDimensions } = await import("./index.js");
      expect(getEmbeddingDimensions()).toBe(384);
    });
  });

  describe("getProviderDescription", () => {
    it("should return description for local provider", async () => {
      const { getProviderDescription } = await import("./index.js");
      const desc = getProviderDescription();
      expect(desc).toContain("Local");
      expect(desc).toContain("384");
    });
  });
});
