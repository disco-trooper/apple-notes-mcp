// src/config/claude.ts
/**
 * Claude Code configuration management.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { isNpmInstall, getProjectRoot } from "./paths.js";

const CLAUDE_CONFIG_PATH = path.join(os.homedir(), ".claude.json");

interface ClaudeServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface ClaudeConfig {
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

/**
 * Read existing Claude config.
 */
export function readClaudeConfig(): ClaudeConfig | null {
  if (!fs.existsSync(CLAUDE_CONFIG_PATH)) {
    return null;
  }

  try {
    const content = fs.readFileSync(CLAUDE_CONFIG_PATH, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Write Claude config with our MCP server entry.
 */
export function writeClaudeConfig(entry: ClaudeServerEntry): boolean {
  let config = readClaudeConfig();

  if (!config) {
    config = {
      mcpServers: {
        "apple-notes": entry,
      },
    };
  } else {
    const mcpServers = (config.mcpServers || {}) as Record<string, ClaudeServerEntry>;
    mcpServers["apple-notes"] = entry;
    config.mcpServers = mcpServers;
  }

  try {
    fs.writeFileSync(CLAUDE_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if existing Claude config uses different install method.
 * Returns null if no existing config, otherwise returns the method.
 */
export function getExistingInstallMethod(): "npm" | "source" | null {
  const config = readClaudeConfig();
  const entry = config?.mcpServers?.["apple-notes"];

  if (!entry) {
    return null;
  }

  return entry.command === "apple-notes-mcp" ? "npm" : "source";
}

/**
 * Get Claude config path for display.
 */
export function getClaudeConfigPath(): string {
  return CLAUDE_CONFIG_PATH;
}
