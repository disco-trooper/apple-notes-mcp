/**
 * Shared debug logging utility.
 * Logs to stderr to avoid polluting stdout/MCP protocol.
 * Uses dim styling to distinguish from errors.
 */

import { envFlag } from "../config/env.js";

// ANSI color codes
const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
} as const;

/**
 * Create a debug logger with a specific prefix.
 * Checks DEBUG env var (true/1) at call time for runtime control.
 * Output is dim cyan to distinguish from errors.
 */
export function createDebugLogger(prefix: string) {
  return (...args: unknown[]): void => {
    if (envFlag("DEBUG")) {
      const formattedPrefix = `${COLORS.dim}${COLORS.cyan}[${prefix}]${COLORS.reset}`;
      const formattedArgs = args.map(arg =>
        typeof arg === "string" ? `${COLORS.dim}${arg}${COLORS.reset}` : arg
      );
      console.error(formattedPrefix, ...formattedArgs);
    }
  };
}
