/**
 * Shared debug logging utility.
 * Logs to stderr to avoid polluting stdout/MCP protocol.
 * Uses dim styling to distinguish from errors.
 */

// ANSI color codes
const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  green: "\x1b[32m",
} as const;

/**
 * Create a debug logger with a specific prefix.
 * Checks DEBUG env var at call time for runtime control.
 * Output is dim cyan to distinguish from errors.
 */
export function createDebugLogger(prefix: string) {
  return (...args: unknown[]): void => {
    // Check at call time, not load time
    if (process.env.DEBUG === "true") {
      const formattedPrefix = `${COLORS.dim}${COLORS.cyan}[${prefix}]${COLORS.reset}`;
      const formattedArgs = args.map(arg =>
        typeof arg === "string" ? `${COLORS.dim}${arg}${COLORS.reset}` : arg
      );
      console.error(formattedPrefix, ...formattedArgs);
    }
  };
}

/**
 * Create a warning logger (yellow output).
 */
export function createWarningLogger(prefix: string) {
  return (...args: unknown[]): void => {
    const formattedPrefix = `${COLORS.yellow}[${prefix}]${COLORS.reset}`;
    console.error(formattedPrefix, ...args);
  };
}

/**
 * Check if debug mode is enabled.
 * Checks at call time for runtime control.
 */
export function isDebugEnabled(): boolean {
  return process.env.DEBUG === "true";
}
