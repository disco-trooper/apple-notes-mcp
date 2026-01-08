import { describe, it, expect } from "vitest";
import { sanitizeErrorMessage } from "./errors.js";

describe("sanitizeErrorMessage", () => {
  it("preserves user-friendly messages", () => {
    expect(sanitizeErrorMessage("Note not found")).toBe("Note not found");
    expect(sanitizeErrorMessage("Invalid title")).toBe("Invalid title");
  });

  it("removes file paths", () => {
    const error = "ENOENT: no such file at /Users/john/secret/file.ts";
    expect(sanitizeErrorMessage(error)).not.toContain("/Users/john");
  });

  it("removes stack traces", () => {
    const error = "Error: failed\n    at Function.module (/path/to/file.js:123:45)";
    expect(sanitizeErrorMessage(error)).not.toContain("/path/to");
  });

  it("handles generic errors gracefully", () => {
    const error = "TypeError: Cannot read property 'x' of undefined";
    expect(sanitizeErrorMessage(error)).toBe("An internal error occurred");
  });

  it("preserves known safe error patterns", () => {
    expect(sanitizeErrorMessage("Title must be a non-empty string")).toBe("Title must be a non-empty string");
    expect(sanitizeErrorMessage("Note not found: \"My Note\"")).toBe("Note not found: \"My Note\"");
  });
});
