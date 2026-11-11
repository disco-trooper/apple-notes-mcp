/**
 * Side-effect module: loads ~/.apple-notes-mcp/.env into process.env.
 *
 * Must be the first import of the entry point. ES module imports are evaluated
 * before the importing module's body, so calling dotenv.config() inline would
 * run after every other module had already read process.env at load time.
 */
import { loadEnvFile } from "./env.js";
import { getEnvPath } from "./paths.js";

loadEnvFile(getEnvPath());
