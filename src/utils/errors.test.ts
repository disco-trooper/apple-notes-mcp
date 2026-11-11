import { describe, it, expect } from "vitest";
import { sanitizeErrorMessage } from "./errors.js";
import { DuplicateNoteError, NoteNotFoundError, ReadOnlyModeError } from "../errors/index.js";
import { IndexCancelledError } from "../indexing/contracts.js";

describe("sanitizeErrorMessage", () => {
  it("returns typed domain errors in full, including multi-line suggestions", () => {
    const duplicate = new DuplicateNoteError("Note", [
      { id: "a", folder: "Work", title: "Note", created: "2026-01-01T00:00:00Z" },
      { id: "b", folder: "Home", title: "Note", created: "2026-01-02T00:00:00Z" },
    ]);
    expect(sanitizeErrorMessage(duplicate)).toBe(duplicate.message);
    expect(sanitizeErrorMessage(duplicate)).toContain("id:b");

    expect(sanitizeErrorMessage(new NoteNotFoundError("x"))).toBe('Note not found: "x"');
    expect(sanitizeErrorMessage(new ReadOnlyModeError())).toBe("Operation disabled in read-only mode");
    expect(sanitizeErrorMessage(new IndexCancelledError())).toBe("Indexing cancelled");
  });

  it("keeps the full multi-line environment validation message", () => {
    const message = "Invalid environment configuration:\n  EMBEDDING_DIMS: Invalid\n  DEBUG: Invalid enum value";
    expect(sanitizeErrorMessage(new Error(message))).toBe(message);
  });

  it("keeps Notes folder paths that are not filesystem paths", () => {
    const message = 'Failed to move "Work/Projects/Plan" to folder "Archive/2026/"';
    expect(sanitizeErrorMessage(new Error(message))).toBe(message);
  });

  it("redacts absolute filesystem paths, including ones with dots and digits", () => {
    expect(sanitizeErrorMessage(new Error("Cannot open /Users/jan.novak2/proj/x.lance"))).toBe("An internal error occurred");
    expect(sanitizeErrorMessage(new Error("bad url file:///private/tmp/a"))).toBe("An internal error occurred");
  });

  it("redacts stack traces and programming errors", () => {
    expect(sanitizeErrorMessage(new Error("failed\n    at fn (/x/y.js:1:2)"))).toBe("An internal error occurred");
    expect(sanitizeErrorMessage(new TypeError("Cannot read properties of undefined"))).toBe("An internal error occurred");
  });

  it("returns only the first line of other errors, truncated", () => {
    expect(sanitizeErrorMessage(new Error("Folder not found: X\nextra detail"))).toBe("Folder not found: X");
    expect(sanitizeErrorMessage("x".repeat(500))).toHaveLength(200);
  });
});
