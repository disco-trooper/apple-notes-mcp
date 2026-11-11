import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { envFlag, loadEnvFile, parseFlag, validateEnv } from "./env.js";

const KEYS = [
  "OPENROUTER_API_KEY",
  "EMBEDDING_MODEL",
  "EMBEDDING_DIMS",
  "READONLY_MODE",
  "INDEX_TTL",
  "SEARCH_REFRESH_TIMEOUT_MS",
  "INDEX_JOB_RETENTION_SECONDS",
  "EMBEDDING_BATCH_SIZE",
  "NOTES_FETCH_BATCH_SIZE",
  "JXA_TIMEOUT_MS",
  "DEBUG",
  "NOTES_TRASH_FOLDER",
];

const originalEnv = { ...process.env };

function setEnv(values: Record<string, string>): void {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, values);
}

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("validateEnv", () => {
  it("accepts an empty configuration", () => {
    setEnv({});
    expect(() => validateEnv()).not.toThrow();
  });

  it("treats empty strings as unset", () => {
    setEnv({ OPENROUTER_API_KEY: "", DEBUG: "", EMBEDDING_DIMS: " ", READONLY_MODE: "" });
    expect(validateEnv()).toMatchObject({ OPENROUTER_API_KEY: undefined, DEBUG: undefined });
  });

  it.each(["true", "false", "1", "0", "TRUE", "False"])("accepts boolean value %s", (value) => {
    setEnv({ DEBUG: value, READONLY_MODE: value });
    expect(() => validateEnv()).not.toThrow();
  });

  it("rejects other boolean values with the variable name", () => {
    setEnv({ DEBUG: "yes" });
    expect(() => validateEnv()).toThrow(/DEBUG: Expected true, false, 1 or 0/);
  });

  it("validates OPENROUTER_API_KEY format", () => {
    setEnv({ OPENROUTER_API_KEY: "invalid-key" });
    expect(() => validateEnv()).toThrow(/OPENROUTER_API_KEY/);

    setEnv({ OPENROUTER_API_KEY: "sk-or-valid-key-123" });
    expect(() => validateEnv()).not.toThrow();
  });

  it.each([
    "EMBEDDING_DIMS",
    "SEARCH_REFRESH_TIMEOUT_MS",
    "INDEX_JOB_RETENTION_SECONDS",
    "EMBEDDING_BATCH_SIZE",
    "NOTES_FETCH_BATCH_SIZE",
    "JXA_TIMEOUT_MS",
  ])("requires %s to be a positive integer", (key) => {
    for (const bad of ["abc", "0", "-5", "1.5"]) {
      setEnv({ [key]: bad });
      expect(() => validateEnv(), `${key}=${bad}`).toThrow(new RegExp(key));
    }
    setEnv({ [key]: "100" });
    expect(() => validateEnv()).not.toThrow();
  });

  it("allows INDEX_TTL=0 (auto-refresh disabled) but not garbage", () => {
    setEnv({ INDEX_TTL: "0" });
    expect(() => validateEnv()).not.toThrow();
    setEnv({ INDEX_TTL: "1h" });
    expect(() => validateEnv()).toThrow(/INDEX_TTL/);
  });
});

describe("envFlag", () => {
  it.each([
    ["true", true],
    ["TRUE", true],
    ["1", true],
    ["false", false],
    ["0", false],
    ["", false],
    ["yes", false],
  ])("DEBUG=%j -> %s", (value, expected) => {
    setEnv({ DEBUG: value });
    expect(envFlag("DEBUG")).toBe(expected);
  });

  it("is false when unset", () => {
    setEnv({});
    expect(envFlag("DEBUG")).toBe(false);
  });
});

describe("loadEnvFile", () => {
  function writeTempEnv(content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-env-"));
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, content);
    return file;
  }

  it("lets .env fill keys that are set but blank in the environment", () => {
    const file = writeTempEnv("READONLY_MODE=true\nOPENROUTER_API_KEY=sk-or-from-file\n");
    const env: NodeJS.ProcessEnv = { READONLY_MODE: "", OPENROUTER_API_KEY: "   " };

    loadEnvFile(file, env);

    expect(parseFlag(env.READONLY_MODE)).toBe(true);
    expect(env.OPENROUTER_API_KEY).toBe("sk-or-from-file");
  });

  it("keeps non-blank environment values over the file", () => {
    const file = writeTempEnv("READONLY_MODE=true\n");
    const env: NodeJS.ProcessEnv = { READONLY_MODE: "false" };

    loadEnvFile(file, env);

    expect(env.READONLY_MODE).toBe("false");
  });

  it("leaves blank unknown variables alone", () => {
    const file = writeTempEnv("");
    const env: NodeJS.ProcessEnv = { SOMETHING_ELSE: "" };

    loadEnvFile(file, env);

    expect(env).toEqual({ SOMETHING_ELSE: "" });
  });
});
