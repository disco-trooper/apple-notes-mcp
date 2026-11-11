import * as dotenv from "dotenv";
import { z } from "zod";

const TRUE_VALUES = ["true", "1"];
const BOOLEAN_VALUES = [...TRUE_VALUES, "false", "0"];

/** True for "true"/"1" (case-insensitive, trimmed); false for anything else. */
export function parseFlag(value: string | undefined): boolean {
  return TRUE_VALUES.includes(value?.trim().toLowerCase() ?? "");
}

/**
 * Read a boolean env flag. Accepts true/false/1/0 (case-insensitive);
 * unset, empty or any other value is false.
 */
export function envFlag(name: string): boolean {
  return parseFlag(process.env[name]);
}

/** Empty or whitespace-only values count as unset. */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), schema.optional());

const flag = optional(
  z.string().refine((v) => BOOLEAN_VALUES.includes(v.trim().toLowerCase()), {
    message: "Expected true, false, 1 or 0",
  })
);

const positiveInt = optional(
  z.string().regex(/^\s*\d+\s*$/, "Expected a positive integer").refine((v) => Number(v) > 0, {
    message: "Expected a positive integer",
  })
);

/** INDEX_TTL=0 disables auto-refresh, so zero is allowed there. */
const nonNegativeInt = optional(z.string().regex(/^\s*\d+\s*$/, "Expected a non-negative integer"));

const EnvSchema = z.object({
  OPENROUTER_API_KEY: optional(z.string().startsWith("sk-or-")),
  EMBEDDING_MODEL: optional(z.string()),
  EMBEDDING_DIMS: positiveInt,
  READONLY_MODE: flag,
  INDEX_TTL: nonNegativeInt,
  SEARCH_REFRESH_TIMEOUT_MS: positiveInt,
  INDEX_JOB_RETENTION_SECONDS: positiveInt,
  EMBEDDING_BATCH_SIZE: positiveInt,
  NOTES_FETCH_BATCH_SIZE: positiveInt,
  JXA_TIMEOUT_MS: positiveInt,
  DEBUG: flag,
  /** Extra name of the Notes trash folder, for localizations not built in. */
  NOTES_TRASH_FOLDER: optional(z.string()),
});

/** Every variable the server reads from the environment / .env file. */
export const ENV_KEYS = Object.keys(EnvSchema.shape) as Array<keyof typeof EnvSchema.shape>;

/**
 * Load a .env file into `env` without overriding real values. Known keys that
 * are set but blank (e.g. `READONLY_MODE=` from an MCP client config) are
 * removed first: dotenv treats any existing key as set, so a blank value would
 * otherwise shadow the file and silently count as unset.
 */
export function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): void {
  for (const key of ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && value.trim() === "") {
      delete env[key];
    }
  }
  // quiet: dotenv >= 16.6 can log to stdout, which would corrupt the MCP stdio stream.
  dotenv.config({ path, processEnv: env as Record<string, string>, quiet: true });
}

export type Env = z.infer<typeof EnvSchema>;

export function validateEnv(): Env {
  const result = EnvSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.issues
      .map((e) => `  ${e.path.join(".")}: ${e.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${errors}`);
  }

  return result.data;
}
