/**
 * Side-effect module: loads ~/.apple-notes-mcp/.env into process.env.
 *
 * Must be the first import of the entry point. ES module imports are evaluated
 * before the importing module's body, so calling dotenv.config() inline would
 * run after every other module had already read process.env at load time.
 */
import * as dotenv from "dotenv";
import { getEnvPath } from "./paths.js";

// quiet: dotenv >= 16.6 can log to stdout, which would corrupt the MCP stdio stream.
dotenv.config({ path: getEnvPath(), quiet: true });
