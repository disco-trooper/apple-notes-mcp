/**
 * Shared debug logging utility.
 * Logs to stderr to avoid polluting stdout/MCP protocol.
 */

/**
 * Create a debug logger with a specific prefix.
 * Checks DEBUG env var at call time for runtime control.
 */
export function createDebugLogger(prefix: string) {
  return (...args: unknown[]): void => {
    // Check at call time, not load time
    if (process.env.DEBUG === "true") {
      console.error(`[${prefix}]`, ...args);
    }
  };
}

/**
 * Check if debug mode is enabled.
 * Checks at call time for runtime control.
 */
export function isDebugEnabled(): boolean {
  return process.env.DEBUG === "true";
}
