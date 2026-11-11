// src/config/claude.ts
/**
 * Claude Code configuration management.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { isNpmInstall, getProjectRoot } from "./paths.js";

export interface ClaudeServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ClaudeConfig {
  mcpServers?: Record<string, ClaudeServerEntry>;
  [key: string]: unknown;
}

/**
 * Generate the appropriate MCP server entry based on install method.
 */
export function getClaudeConfigEntry(): ClaudeServerEntry {
  if (isNpmInstall()) {
    return {
      command: "apple-notes-mcp",
      args: [],
      env: {},
    };
  } else {
    const projectRoot = getProjectRoot();
    return {
      command: "bun",
      args: ["run", path.join(projectRoot, "src", "index.ts")],
      env: {},
    };
  }
}

export type ClaudeConfigReadResult =
  | { status: "missing" }
  | { status: "ok"; config: ClaudeConfig }
  | { status: "invalid"; error: string };

/**
 * Read existing Claude config. Only a missing file (ENOENT) counts as
 * "missing"; unreadable or unparseable files are "invalid" and must not be
 * overwritten.
 */
export function readClaudeConfig(): ClaudeConfigReadResult {
  let content: string;
  try {
    content = fs.readFileSync(getClaudeConfigPath(), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing" };
    }
    return { status: "invalid", error: error instanceof Error ? error.message : String(error) };
  }

  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { status: "invalid", error: "top-level value is not a JSON object" };
    }
    return { status: "ok", config: parsed as ClaudeConfig };
  } catch (error) {
    return { status: "invalid", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Write Claude config with our MCP server entry, keeping everything else.
 * Refuses (returns false) when the existing file cannot be read or parsed.
 * Backs up an existing file to `.claude.json.bak` and writes atomically
 * (temp file + rename) so a crash never leaves a truncated config.
 */
export function writeClaudeConfig(entry: ClaudeServerEntry): boolean {
  const existing = readClaudeConfig();
  if (existing.status === "invalid") {
    return false;
  }

  const config: ClaudeConfig = existing.status === "ok" ? existing.config : {};
  config.mcpServers = { ...(config.mcpServers ?? {}), "apple-notes": entry };

  const configPath = getClaudeConfigPath();
  try {
    // Write through a symlinked ~/.claude.json to its target
    const target = existing.status === "ok" ? fs.realpathSync(configPath) : configPath;
    let mode = 0o600;
    if (existing.status === "ok") {
      mode = fs.statSync(target).mode & 0o777;
      fs.copyFileSync(target, `${configPath}.bak`);
    }
    const tmpPath = `${target}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + "\n", { mode });
      fs.renameSync(tmpPath, target);
    } catch (error) {
      fs.rmSync(tmpPath, { force: true });
      throw error;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if existing Claude config uses different install method.
 * Returns null if there is no readable config entry, otherwise the method.
 */
export function getExistingInstallMethod(): "npm" | "source" | null {
  const existing = readClaudeConfig();
  const entry = existing.status === "ok" ? existing.config.mcpServers?.["apple-notes"] : undefined;

  if (!entry) {
    return null;
  }

  return entry.command === "apple-notes-mcp" ? "npm" : "source";
}

/**
 * Get Claude config path (~/.claude.json), resolved at call time.
 */
export function getClaudeConfigPath(): string {
  return path.join(os.homedir(), ".claude.json");
}
