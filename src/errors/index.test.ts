// src/errors/index.test.ts
import { describe, it, expect } from "vitest";
import {
  NoteNotFoundError,
  ReadOnlyModeError,
  DuplicateNoteError,
  FolderNotFoundError,
} from "./index.js";

describe("Error Classes", () => {
  describe("NoteNotFoundError", () => {
    it("should have correct name and message", () => {
      const error = new NoteNotFoundError("My Note");
      expect(error.name).toBe("NoteNotFoundError");
      expect(error.message).toBe('Note not found: "My Note"');
      expect(error.title).toBe("My Note");
      expect(error instanceof Error).toBe(true);
    });
  });

  describe("ReadOnlyModeError", () => {
    it("should have correct name and message", () => {
      const error = new ReadOnlyModeError();
      expect(error.name).toBe("ReadOnlyModeError");
      expect(error.message).toBe("Operation disabled in read-only mode");
      expect(error instanceof Error).toBe(true);
    });
  });

  describe("DuplicateNoteError", () => {
    it("should have correct name and suggestions", () => {
      const suggestions = ["Work/Note", "Personal/Note"];
      const error = new DuplicateNoteError("Note", suggestions);
      expect(error.name).toBe("DuplicateNoteError");
      expect(error.title).toBe("Note");
      expect(error.suggestions).toEqual(suggestions);
      expect(error.message).toContain("Multiple notes found");
    });
  });

  describe("FolderNotFoundError", () => {
    it("should have correct name and message", () => {
      const error = new FolderNotFoundError("Work");
      expect(error.name).toBe("FolderNotFoundError");
      expect(error.folder).toBe("Work");
      expect(error.message).toBe('Folder not found: "Work"');
    });
  });
});
