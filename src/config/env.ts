import { z } from "zod";

const EnvSchema = z.object({
  OPENROUTER_API_KEY: z.string().startsWith("sk-or-").optional(),
  EMBEDDING_MODEL: z.string().optional(),
  EMBEDDING_DIMS: z.string().regex(/^\d+$/).optional(),
  READONLY_MODE: z.enum(["true", "false"]).optional(),
  INDEX_TTL: z.string().regex(/^\d+$/).optional(),
  SEARCH_REFRESH_TIMEOUT_MS: z.string().regex(/^\d+$/).optional(),
  INDEX_JOB_RETENTION_SECONDS: z.string().regex(/^\d+$/).optional(),
  DEBUG: z.enum(["true", "false"]).optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export function validateEnv(): Env {
  const result = EnvSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.errors
      .map((e) => `  ${e.path.join(".")}: ${e.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${errors}`);
  }

  return result.data;
}
