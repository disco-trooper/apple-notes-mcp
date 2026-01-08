/**
 * Shared debug logging utility.
 * Logs to stderr to avoid polluting stdout/MCP protocol.
 */

const IS_DEBUG = process.env.DEBUG === "true";

/**
 * Create a debug logger with a specific prefix.
 */
export function createDebugLogger(prefix: string) {
  return (...args: unknown[]): void => {
    if (IS_DEBUG) {
      console.error(`[${prefix}]`, ...args);
    }
  };
}

/**
 * Check if debug mode is enabled.
 */
export function isDebugEnabled(): boolean {
  return IS_DEBUG;
}
