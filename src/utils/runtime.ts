/**
 * Runtime environment checks.
 */

/**
 * Check if running in Bun runtime.
 */
export function isBunRuntime(): boolean {
  return typeof Bun !== "undefined";
}

/**
 * Check Bun runtime and throw helpful error if not available.
 */
export function checkBunRuntime(): void {
  if (!isBunRuntime()) {
    console.error(`
╭─────────────────────────────────────────────────────────────╮
│  apple-notes-mcp requires Bun runtime                       │
│                                                             │
│  Install Bun:                                               │
│    curl -fsSL https://bun.sh/install | bash                 │
│                                                             │
│  Or with Homebrew:                                          │
│    brew install bun                                         │
│                                                             │
│  Then run again:                                            │
│    apple-notes-mcp                                          │
╰─────────────────────────────────────────────────────────────╯
`);
    process.exit(1);
  }
}

/**
 * Check if running in interactive terminal (TTY).
 */
export function isTTY(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}
