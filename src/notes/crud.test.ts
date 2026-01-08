import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock run-jxa before importing crud module
vi.mock("run-jxa", () => ({
  runJxa: vi.fn(),
}));

// Mock marked
vi.mock("marked", () => ({
  marked: {
    parse: vi.fn((text: string) => `<p>${text}</p>`),
  },
}));

// Mock read.js
vi.mock("./read.js", () => ({
  resolveNoteTitle: vi.fn(),
}));

// Mock debug utility
vi.mock("../utils/debug.js", () => ({
  createDebugLogger: vi.fn(() => vi.fn()),
}));

import { runJxa } from "run-jxa";
import { checkReadOnly, createNote, updateNote, deleteNote, moveNote } from "./crud.js";
import { resolveNoteTitle } from "./read.js";

describe("checkReadOnly", () => {
  const originalEnv = process.env.READONLY_MODE;

  beforeEach(() => {
    delete process.env.READONLY_MODE;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.READONLY_MODE = originalEnv;
    } else {
      delete process.env.READONLY_MODE;
    }
  });

  it("should not throw when READONLY_MODE is not set", () => {
    expect(() => checkReadOnly()).not.toThrow();
  });

  it("should throw when READONLY_MODE is true", () => {
    process.env.READONLY_MODE = "true";
    expect(() => checkReadOnly()).toThrow("read-only mode");
  });

  it("should not throw when READONLY_MODE is false", () => {
    process.env.READONLY_MODE = "false";
    expect(() => checkReadOnly()).not.toThrow();
  });
});

describe("createNote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.READONLY_MODE;
  });

  it("should throw if READONLY_MODE is enabled", async () => {
    process.env.READONLY_MODE = "true";
    await expect(createNote("Test", "Content")).rejects.toThrow("read-only mode");
  });

  it("should throw if note already exists", async () => {
    vi.mocked(runJxa).mockResolvedValueOnce("true"); // noteExists returns true
    await expect(createNote("Existing Note", "Content")).rejects.toThrow("already exists");
  });

  it("should create note successfully", async () => {
    vi.mocked(runJxa)
      .mockResolvedValueOnce("false") // noteExists returns false
      .mockResolvedValueOnce("ok");   // createNote succeeds

    await expect(createNote("New Note", "Content", "Work")).resolves.toBeUndefined();
  });
});

describe("updateNote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.READONLY_MODE;
  });

  it("should throw if READONLY_MODE is enabled", async () => {
    process.env.READONLY_MODE = "true";
    await expect(updateNote("Test", "Content")).rejects.toThrow("read-only mode");
  });

  it("should throw if note not found", async () => {
    vi.mocked(resolveNoteTitle).mockResolvedValueOnce({
      success: false,
      error: "Note not found",
    });
    await expect(updateNote("Missing Note", "Content")).rejects.toThrow("Note not found");
  });

  it("should update note successfully", async () => {
    vi.mocked(resolveNoteTitle).mockResolvedValueOnce({
      success: true,
      note: { id: "123", title: "Test", folder: "Work" },
    });
    vi.mocked(runJxa).mockResolvedValueOnce("ok");

    await expect(updateNote("Test", "New Content")).resolves.toBeUndefined();
  });

  it("should include suggestions in error when multiple notes found", async () => {
    vi.mocked(resolveNoteTitle).mockResolvedValueOnce({
      success: false,
      error: "Multiple notes found",
      suggestions: ["Work/Note", "Personal/Note"],
    });
    await expect(updateNote("Note", "Content")).rejects.toThrow("Suggestions: Work/Note, Personal/Note");
  });
});

describe("deleteNote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.READONLY_MODE;
  });

  it("should throw if READONLY_MODE is enabled", async () => {
    process.env.READONLY_MODE = "true";
    await expect(deleteNote("Test")).rejects.toThrow("read-only mode");
  });

  it("should throw if note not found", async () => {
    vi.mocked(resolveNoteTitle).mockResolvedValueOnce({
      success: false,
      error: "Note not found",
    });
    await expect(deleteNote("Missing Note")).rejects.toThrow("Note not found");
  });

  it("should delete note successfully", async () => {
    vi.mocked(resolveNoteTitle).mockResolvedValueOnce({
      success: true,
      note: { id: "123", title: "Test", folder: "Work" },
    });
    vi.mocked(runJxa).mockResolvedValueOnce("ok");

    await expect(deleteNote("Test")).resolves.toBeUndefined();
  });

  it("should include suggestions in error when multiple notes found", async () => {
    vi.mocked(resolveNoteTitle).mockResolvedValueOnce({
      success: false,
      error: "Multiple notes found",
      suggestions: ["Work/Note", "Personal/Note"],
    });
    await expect(deleteNote("Note")).rejects.toThrow("Suggestions: Work/Note, Personal/Note");
  });
});

describe("moveNote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.READONLY_MODE;
  });

  it("should throw if READONLY_MODE is enabled", async () => {
    process.env.READONLY_MODE = "true";
    await expect(moveNote("Test", "NewFolder")).rejects.toThrow("read-only mode");
  });

  it("should throw if note not found", async () => {
    vi.mocked(resolveNoteTitle).mockResolvedValueOnce({
      success: false,
      error: "Note not found",
    });
    await expect(moveNote("Missing Note", "NewFolder")).rejects.toThrow("Note not found");
  });

  it("should move note successfully", async () => {
    vi.mocked(resolveNoteTitle).mockResolvedValueOnce({
      success: true,
      note: { id: "123", title: "Test", folder: "Work" },
    });
    vi.mocked(runJxa).mockResolvedValueOnce("ok");

    await expect(moveNote("Test", "Personal")).resolves.toBeUndefined();
  });

  it("should include suggestions in error when multiple notes found", async () => {
    vi.mocked(resolveNoteTitle).mockResolvedValueOnce({
      success: false,
      error: "Multiple notes found",
      suggestions: ["Work/Note", "Personal/Note"],
    });
    await expect(moveNote("Note", "Archive")).rejects.toThrow("Suggestions: Work/Note, Personal/Note");
  });
});
