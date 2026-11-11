#!/usr/bin/env bun
// Must stay first: loads ~/.apple-notes-mcp/.env before any module reads process.env.
import "./config/load-env.js";

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { hasConfig } from "./config/paths.js";
import { validateEnv } from "./config/env.js";
import { checkBunRuntime, isTTY } from "./utils/runtime.js";
import { createDebugLogger } from "./utils/debug.js";
import { sanitizeErrorMessage } from "./utils/errors.js";
import { getIndexJobManager } from "./indexing/job-manager.js";
import { createServer } from "./server.js";

const debug = createDebugLogger("MCP");

checkBunRuntime();

if (!hasConfig()) {
  if (isTTY()) {
    // Interactive terminal: run the setup wizard, then exit with its status.
    console.error("No configuration found. Starting setup wizard...\n");
    const setupPath = fileURLToPath(new URL("./setup.ts", import.meta.url));
    const child = spawn("bun", ["run", setupPath], { stdio: "inherit" });
    child.on("error", (error) => {
      console.error(`Failed to start setup wizard: ${error.message}`);
      process.exit(1);
    });
    child.on("exit", (code) => process.exit(code ?? 0));
    await new Promise(() => {}); // the exit/error handlers end the process
  } else {
    console.error(`
╭─────────────────────────────────────────────────────────────╮
│  apple-notes-mcp: Configuration required                    │
│                                                             │
│  Run this command in your terminal first:                   │
│                                                             │
│      apple-notes-mcp                                        │
│                                                             │
│  The setup wizard will guide you through configuration.     │
╰─────────────────────────────────────────────────────────────╯
`);
    process.exit(1);
  }
}

let shuttingDown = false;

/** Cancel active index jobs (kills their osascript children) and exit. */
function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  debug(`Shutting down (${reason})`);

  const jobs = getIndexJobManager();
  for (const job of jobs.list()) {
    if (job.status === "queued" || job.status === "running") {
      jobs.cancel(job.id);
    }
  }
  process.exit(0);
}

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

async function main(): Promise<void> {
  validateEnv();

  debug("Starting apple-notes-mcp server...");
  const server = createServer();
  server.server.onclose = () => shutdown("transport closed");

  // The stdio transport does not notice a client disconnect on its own.
  process.stdin.on("end", () => shutdown("stdin closed"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await server.connect(new StdioServerTransport());
  debug("Server connected");
}

main().catch((error) => {
  console.error("Fatal error:", sanitizeErrorMessage(error));
  process.exit(1);
});
