// src/config/paths.test.ts
import { describe, it, expect } from "vitest";

describe("config paths", () => {
  describe("getConfigDir", () => {
    it("should return ~/.apple-notes-mcp", async () => {
      const { getConfigDir } = await import("./paths.js");
      expect(getConfigDir()).toMatch(/\.apple-notes-mcp$/);
    });
  });

  describe("getEnvPath", () => {
    it("should return config dir + .env", async () => {
      const { getEnvPath, getConfigDir } = await import("./paths.js");
      expect(getEnvPath()).toBe(`${getConfigDir()}/.env`);
    });
  });

  describe("getDataDir", () => {
    it("should return config dir + data", async () => {
      const { getDataDir, getConfigDir } = await import("./paths.js");
      expect(getDataDir()).toBe(`${getConfigDir()}/data`);
    });
  });

  describe("isNpmInstall", () => {
    it("should detect npm install from path", async () => {
      const { isNpmInstall } = await import("./paths.js");
      // Running from source, should be false
      expect(isNpmInstall()).toBe(false);
    });
  });

  describe("getProjectRoot", () => {
    it("should return project root directory", async () => {
      const { getProjectRoot } = await import("./paths.js");
      expect(getProjectRoot()).toMatch(/apple-notes-mcp$/);
    });
  });
});
