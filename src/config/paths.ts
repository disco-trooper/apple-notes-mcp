// src/config/paths.ts
/**
 * Unified configuration paths for both source and npm installations.
 * All user config lives in ~/.apple-notes-mcp/ regardless of install method.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * Get the config directory path.
 * Always ~/.apple-notes-mcp/ for consistency across install methods.
 */
export function getConfigDir(): string {
  return path.join(os.homedir(), ".apple-notes-mcp");
}

/**
 * Get the .env file path.
 */
export function getEnvPath(): string {
  return path.join(getConfigDir(), ".env");
}

/**
 * Get the data directory path (for LanceDB).
 */
export function getDataDir(): string {
  return path.join(getConfigDir(), "data");
}

/**
 * Check if configuration exists.
 */
export function hasConfig(): boolean {
  return fs.existsSync(getEnvPath());
}

/**
 * Ensure config directory exists.
 */
export function ensureConfigDir(): void {
  const configDir = getConfigDir();
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
}

/**
 * Detect if running from npm global install vs source.
 * Used to generate appropriate Claude Code config.
 */
export function isNpmInstall(): boolean {
  const scriptPath = new URL(import.meta.url).pathname;
  return (
    scriptPath.includes("/node_modules/") ||
    scriptPath.includes("/.npm/") ||
    // Global npm install on macOS
    scriptPath.includes("/lib/node_modules/")
  );
}

/**
 * Get the project root directory (for source installs).
 */
export function getProjectRoot(): string {
  // Navigate up from src/config/paths.ts to project root
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
}

/**
 * Check if legacy config exists in project root.
 * Used for migration from old setup.
 */
export function hasLegacyConfig(): boolean {
  const legacyPath = path.join(getProjectRoot(), ".env");
  return fs.existsSync(legacyPath) && !isNpmInstall();
}

/**
 * Get legacy config path for migration.
 */
export function getLegacyEnvPath(): string {
  return path.join(getProjectRoot(), ".env");
}
