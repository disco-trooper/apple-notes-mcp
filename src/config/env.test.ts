import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We need to test validateEnv with different env vars
// The module reads process.env at import time, so we need dynamic imports

describe("validateEnv", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("accepts valid configuration", async () => {
    process.env.DEBUG = "true";
    process.env.READONLY_MODE = "false";
    const { validateEnv } = await import("./env.js");
    expect(() => validateEnv()).not.toThrow();
  });

  it("accepts empty configuration", async () => {
    // Clear relevant env vars
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.DEBUG;
    delete process.env.READONLY_MODE;
    delete process.env.EMBEDDING_DIMS;
    delete process.env.INDEX_TTL;
    const { validateEnv } = await import("./env.js");
    expect(() => validateEnv()).not.toThrow();
  });

  it("validates OPENROUTER_API_KEY format", async () => {
    process.env.OPENROUTER_API_KEY = "invalid-key";
    const { validateEnv } = await import("./env.js");
    expect(() => validateEnv()).toThrow();
  });

  it("accepts valid OPENROUTER_API_KEY", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-valid-key-123";
    const { validateEnv } = await import("./env.js");
    expect(() => validateEnv()).not.toThrow();
  });

  it("validates EMBEDDING_DIMS is numeric", async () => {
    process.env.EMBEDDING_DIMS = "not-a-number";
    const { validateEnv } = await import("./env.js");
    expect(() => validateEnv()).toThrow();
  });

  it("validates DEBUG is boolean string", async () => {
    process.env.DEBUG = "yes";
    const { validateEnv } = await import("./env.js");
    expect(() => validateEnv()).toThrow();
  });
});
