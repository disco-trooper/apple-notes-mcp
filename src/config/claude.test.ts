// src/config/claude.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock paths.js before importing claude.ts
vi.mock("./paths.js", () => ({
  isNpmInstall: vi.fn(),
  getProjectRoot: vi.fn(() => "/mock/project"),
}));

describe("claude config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe("getClaudeConfigEntry", () => {
    it("should return npm command when npm install", async () => {
      const { isNpmInstall } = await import("./paths.js");
      vi.mocked(isNpmInstall).mockReturnValue(true);

      const { getClaudeConfigEntry } = await import("./claude.js");
      const entry = getClaudeConfigEntry();

      expect(entry.command).toBe("apple-notes-mcp");
      expect(entry.args).toEqual([]);
    });

    it("should return bun command when source install", async () => {
      const { isNpmInstall } = await import("./paths.js");
      vi.mocked(isNpmInstall).mockReturnValue(false);

      const { getClaudeConfigEntry } = await import("./claude.js");
      const entry = getClaudeConfigEntry();

      expect(entry.command).toBe("bun");
      expect(entry.args[0]).toBe("run");
      expect(entry.args[1]).toContain("/mock/project/src/index.ts");
    });
  });

  describe("getClaudeConfigPath", () => {
    it("should return path to ~/.claude.json", async () => {
      const { getClaudeConfigPath } = await import("./claude.js");
      expect(getClaudeConfigPath()).toMatch(/\.claude\.json$/);
    });
  });
});
