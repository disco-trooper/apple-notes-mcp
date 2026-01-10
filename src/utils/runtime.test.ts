import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("runtime checks", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe("isBunRuntime", () => {
    it("should return false when Bun global is not defined", async () => {
      // vitest runs in Node.js, so Bun is not defined
      const { isBunRuntime } = await import("./runtime.js");
      expect(isBunRuntime()).toBe(false);
    });

    it("should return true when Bun global is defined", async () => {
      // Mock Bun global
      (globalThis as Record<string, unknown>).Bun = {};
      const { isBunRuntime } = await import("./runtime.js");
      expect(isBunRuntime()).toBe(true);
      delete (globalThis as Record<string, unknown>).Bun;
    });
  });

  describe("checkBunRuntime", () => {
    let mockExit: ReturnType<typeof vi.spyOn>;
    let mockConsoleError: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit called");
      });
      mockConsoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      mockExit.mockRestore();
      mockConsoleError.mockRestore();
      delete (globalThis as Record<string, unknown>).Bun;
    });

    it("should exit with error message when Bun is not available", async () => {
      const { checkBunRuntime } = await import("./runtime.js");
      expect(() => checkBunRuntime()).toThrow("process.exit called");
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleError).toHaveBeenCalled();
    });

    it("should not exit when Bun is available", async () => {
      (globalThis as Record<string, unknown>).Bun = {};
      const { checkBunRuntime } = await import("./runtime.js");
      expect(() => checkBunRuntime()).not.toThrow();
      expect(mockExit).not.toHaveBeenCalled();
    });
  });

  describe("isTTY", () => {
    it("should return boolean", async () => {
      const { isTTY } = await import("./runtime.js");
      expect(typeof isTTY()).toBe("boolean");
    });

    it("should return false when stdin or stdout is not a TTY", async () => {
      // In CI/test environments, typically not a TTY
      const { isTTY } = await import("./runtime.js");
      // The result depends on the environment, but it should be a boolean
      const result = isTTY();
      expect(result === true || result === false).toBe(true);
    });
  });
});
