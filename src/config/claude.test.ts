// src/config/claude.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getClaudeConfigEntry,
  getClaudeConfigPath,
  getExistingInstallMethod,
  readClaudeConfig,
  writeClaudeConfig,
} from "./claude.js";

const entry = { command: "bun", args: ["run", "/x/src/index.ts"], env: {} };

let home: string;
let configPath: string;
const originalHome = process.env.HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-config-"));
  process.env.HOME = home;
  configPath = path.join(home, ".claude.json");
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("getClaudeConfigEntry", () => {
  it("points a source install at this checkout's src/index.ts", () => {
    const { command, args } = getClaudeConfigEntry();
    expect(command).toBe("bun");
    expect(fs.existsSync(args[1])).toBe(true);
    expect(args[1].endsWith(path.join("src", "index.ts"))).toBe(true);
  });
});

describe("readClaudeConfig", () => {
  it("reports missing only when the file does not exist", () => {
    expect(getClaudeConfigPath()).toBe(configPath);
    expect(readClaudeConfig()).toEqual({ status: "missing" });
  });

  it("reports invalid JSON and non-object JSON as invalid", () => {
    fs.writeFileSync(configPath, "{ broken");
    expect(readClaudeConfig().status).toBe("invalid");

    fs.writeFileSync(configPath, "[]");
    expect(readClaudeConfig().status).toBe("invalid");
  });
});

describe("writeClaudeConfig", () => {
  it("creates the file when missing", () => {
    expect(writeClaudeConfig(entry)).toBe(true);
    expect(JSON.parse(fs.readFileSync(configPath, "utf-8"))).toEqual({ mcpServers: { "apple-notes": entry } });
  });

  it("never overwrites a file it cannot parse", () => {
    fs.writeFileSync(configPath, '{"projects": {"/a": {}}, ');

    expect(writeClaudeConfig(entry)).toBe(false);
    expect(fs.readFileSync(configPath, "utf-8")).toBe('{"projects": {"/a": {}}, ');
  });

  it("merges into existing config, keeps other keys and writes a backup", () => {
    const original = {
      oauthAccount: { email: "a@b.c" },
      projects: { "/p": { history: [1, 2] } },
      mcpServers: { other: { command: "x", args: [], env: {} } },
    };
    fs.writeFileSync(configPath, JSON.stringify(original), { mode: 0o600 });

    expect(writeClaudeConfig(entry)).toBe(true);

    const written = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(written).toEqual({
      ...original,
      mcpServers: { ...original.mcpServers, "apple-notes": entry },
    });
    expect(JSON.parse(fs.readFileSync(`${configPath}.bak`, "utf-8"))).toEqual(original);
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(home).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(getExistingInstallMethod()).toBe("source");
  });
});
