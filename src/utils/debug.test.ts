import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("debug utility", () => {
  const originalEnv = process.env.DEBUG;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.DEBUG = originalEnv;
    } else {
      delete process.env.DEBUG;
    }
  });

  it("createDebugLogger returns a function", async () => {
    const { createDebugLogger } = await import("./debug.js");
    const logger = createDebugLogger("TEST");
    expect(typeof logger).toBe("function");
  });

  it("isDebugEnabled returns false when DEBUG not set", async () => {
    delete process.env.DEBUG;
    const { isDebugEnabled } = await import("./debug.js");
    expect(isDebugEnabled()).toBe(false);
  });

  it("isDebugEnabled returns true when DEBUG is true", async () => {
    process.env.DEBUG = "true";
    const { isDebugEnabled } = await import("./debug.js");
    expect(isDebugEnabled()).toBe(true);
  });

  it("isDebugEnabled returns false when DEBUG is false", async () => {
    process.env.DEBUG = "false";
    const { isDebugEnabled } = await import("./debug.js");
    expect(isDebugEnabled()).toBe(false);
  });
});
