// src/config/paths.test.ts
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getProjectRoot, isNpmInstall } from "./paths.js";

describe("getProjectRoot", () => {
  it("points at the package root that contains this config module", () => {
    const root = getProjectRoot();

    expect(existsSync(join(root, "src", "config", "paths.ts"))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    expect(pkg.name).toBe("@disco_trooper/apple-notes-mcp");
  });

  it("is a decoded filesystem path, not a percent-encoded URL path", () => {
    expect(getProjectRoot()).not.toMatch(/%[0-9A-F]{2}/i);
  });
});

describe("isNpmInstall", () => {
  it.each([
    ["/usr/local/lib/node_modules/@disco_trooper/apple-notes-mcp/src/config/paths.ts", true],
    ["/Users/jan/proj/node_modules/@disco_trooper/apple-notes-mcp/src/config/paths.ts", true],
    ["/Users/jan/.npm/_npx/abc/node_modules/x/src/config/paths.ts", true],
    ["/Users/Jan Novák/code/apple-notes-mcp/src/config/paths.ts", false],
  ])("%s -> %s", (modulePath, expected) => {
    expect(isNpmInstall(modulePath)).toBe(expected);
  });
});
