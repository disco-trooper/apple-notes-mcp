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

vi.mock("./tables.js", () => ({
  findTables: vi.fn(),
  updateTableCell: vi.fn(),
}));

import { runJxa } from "run-jxa";
import { checkReadOnly, createNote, updateNote, deleteNote, moveNote, editTable, batchDelete, batchMove } from "./crud.js";
import { resolveNoteTitle } from "./read.js";
import { findTables, updateTableCell } from "./tables.js";

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

  it("should create note successfully", async () => {
    vi.mocked(runJxa).mockResolvedValueOnce(
      JSON.stringify({ id: "note-1", title: "New Note", folder: "Work" })
    );

    await expect(createNote("New Note", "Content", "Work")).resolves.toEqual({
      id: "note-1",
      title: "New Note",
      folder: "Work",
      requestedTitle: "New Note",
      titleChanged: false,
    });
  });

  it("should allow duplicate titles (Apple Notes uses IDs)", async () => {
    vi.mocked(runJxa).mockResolvedValueOnce(
      JSON.stringify({ id: "note-2", title: "Existing Note", folder: "Notes" })
    );

    // Should not throw even if a note with same title exists
    await expect(createNote("Existing Note", "Content")).resolves.toEqual({
      id: "note-2",
      title: "Existing Note",
      folder: "Notes",
      requestedTitle: "Existing Note",
      titleChanged: false,
    });
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
    // Mock JXA returning the new title (same as original in this case)
    vi.mocked(runJxa).mockResolvedValueOnce(JSON.stringify({ newTitle: "Test" }));

    const result = await updateNote("Test", "New Content");
    expect(result).toEqual({
      id: "123",
      originalTitle: "Test",
      newTitle: "Test",
      folder: "Work",
      titleChanged: false,
    });
  });

  it("should detect when Apple Notes renames the note", async () => {
    vi.mocked(resolveNoteTitle).mockResolvedValueOnce({
      success: true,
      note: { id: "123", title: "Original Title", folder: "Work" },
    });
    // Mock JXA returning a different title (Apple Notes renamed it)
    vi.mocked(runJxa).mockResolvedValueOnce(JSON.stringify({ newTitle: "New Heading" }));

    const result = await updateNote("Original Title", "# New Heading\n\nContent");
    expect(result).toEqual({
      id: "123",
      originalTitle: "Original Title",
      newTitle: "New Heading",
      folder: "Work",
      titleChanged: true,
    });
  });

  it("should include suggestions in error when multiple notes found", async () => {
    vi.mocked(resolveNoteTitle).mockResolvedValueOnce({
      success: false,
      error: "Multiple notes found",
      suggestions: [
        { id: "id-1", folder: "Work", title: "Note", created: "2026-01-09T10:00:00.000Z" },
        { id: "id-2", folder: "Personal", title: "Note", created: "2026-01-09T11:00:00.000Z" },
      ],
    });
    await expect(updateNote("Note", "Content")).rejects.toThrow("Use ID prefix");
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

    await expect(deleteNote("Test")).resolves.toEqual({
      id: "123",
      title: "Test",
      folder: "Work",
    });
  });

  it("should include suggestions in error when multiple notes found", async () => {
    vi.mocked(resolveNoteTitle).mockResolvedValueOnce({
      success: false,
      error: "Multiple notes found",
      suggestions: [
        { id: "id-1", folder: "Work", title: "Note", created: "2026-01-09T10:00:00.000Z" },
        { id: "id-2", folder: "Personal", title: "Note", created: "2026-01-09T11:00:00.000Z" },
      ],
    });
    await expect(deleteNote("Note")).rejects.toThrow("Use ID prefix");
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

    await expect(moveNote("Test", "Personal")).resolves.toEqual({
      id: "123",
      title: "Test",
      fromFolder: "Work",
      toFolder: "Personal",
    });
  });

  it("should include suggestions in error when multiple notes found", async () => {
    vi.mocked(resolveNoteTitle).mockResolvedValueOnce({
      success: false,
      error: "Multiple notes found",
      suggestions: [
        { id: "id-1", folder: "Work", title: "Note", created: "2026-01-09T10:00:00.000Z" },
        { id: "id-2", folder: "Personal", title: "Note", created: "2026-01-09T11:00:00.000Z" },
      ],
    });
    await expect(moveNote("Note", "Archive")).rejects.toThrow("Use ID prefix");
  });
});

describe("editTable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.READONLY_MODE;
  });

  it("should throw if READONLY_MODE is enabled", async () => {
    process.env.READONLY_MODE = "true";
    await expect(editTable("Test", 0, [])).rejects.toThrow("read-only mode");
  });

  it("should throw if note not found", async () => {
    vi.mocked(resolveNoteTitle).mockResolvedValueOnce({
      success: false,
      error: "Note not found",
    });
    await expect(editTable("Missing", 0, [{ row: 0, column: 0, value: "x" }])).rejects.toThrow("Note not found");
  });

  it("should throw if table index out of bounds", async () => {
    vi.mocked(resolveNoteTitle).mockResolvedValueOnce({
      success: true,
      note: { id: "123", title: "Test", folder: "Work" },
    });
    vi.mocked(runJxa).mockResolvedValueOnce(JSON.stringify({ html: "<div>No tables</div>" }));
    vi.mocked(findTables).mockReturnValueOnce([]);

    await expect(editTable("Test", 0, [{ row: 0, column: 0, value: "x" }]))
      .rejects.toThrow("Table index 0 out of bounds");
  });

  it("should update table cells and save", async () => {
    vi.mocked(resolveNoteTitle).mockResolvedValueOnce({
      success: true,
      note: { id: "123", title: "Test", folder: "Work" },
    });
    vi.mocked(runJxa)
      .mockResolvedValueOnce(JSON.stringify({ html: "<div><object><table></table></object></div>" }))
      .mockResolvedValueOnce("ok");
    vi.mocked(findTables).mockReturnValueOnce(["<object><table></table></object>"]);
    vi.mocked(updateTableCell).mockReturnValueOnce("<object><table>updated</table></object>");

    await expect(editTable("Test", 0, [{ row: 1, column: 0, value: "✅ Done" }]))
      .resolves.toBeUndefined();

    expect(updateTableCell).toHaveBeenCalledWith(
      "<object><table></table></object>",
      1,
      0,
      "✅ Done"
    );
  });
});

describe("batchDelete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.READONLY_MODE;
  });

  it("should throw if both titles and folder provided", async () => {
    await expect(
      batchDelete({ titles: ["Note"], folder: "Folder" })
    ).rejects.toThrow("Specify either titles or folder, not both");
  });

  it("should throw if neither titles nor folder provided", async () => {
    await expect(batchDelete({})).rejects.toThrow("Specify either titles or folder");
  });

  it("should throw in readonly mode", async () => {
    process.env.READONLY_MODE = "true";
    await expect(batchDelete({ titles: ["Note"] })).rejects.toThrow("read-only mode");
  });

  it("should delete all notes in a folder", async () => {
    vi.mocked(runJxa).mockResolvedValue(JSON.stringify({ deletedCount: 5 }));

    const result = await batchDelete({ folder: "Old Project" });

    expect(result.deleted).toBe(5);
    expect(result.failed).toEqual([]);
  });

  it("should delete individual notes by title", async () => {
    vi.mocked(resolveNoteTitle)
      .mockResolvedValueOnce({ success: true, note: { id: "1", title: "Note 1", folder: "Work" } })
      .mockResolvedValueOnce({ success: true, note: { id: "2", title: "Note 2", folder: "Work" } });
    vi.mocked(runJxa).mockResolvedValue("ok");

    const result = await batchDelete({ titles: ["Note 1", "Note 2"] });

    expect(result.deleted).toBe(2);
    expect(result.failed).toEqual([]);
  });

  it("should track failed deletions", async () => {
    vi.mocked(resolveNoteTitle)
      .mockResolvedValueOnce({ success: true, note: { id: "1", title: "Note 1", folder: "Work" } })
      .mockResolvedValueOnce({ success: false, error: "Note not found" });
    vi.mocked(runJxa).mockResolvedValue("ok");

    const result = await batchDelete({ titles: ["Note 1", "Missing Note"] });

    expect(result.deleted).toBe(1);
    expect(result.failed).toEqual(["Missing Note"]);
  });
});

describe("batchMove", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.READONLY_MODE;
  });

  it("should throw if targetFolder missing", async () => {
    await expect(
      batchMove({ titles: ["Note"], targetFolder: "" })
    ).rejects.toThrow("targetFolder is required");
  });

  it("should throw if both titles and sourceFolder provided", async () => {
    await expect(
      batchMove({ titles: ["Note"], sourceFolder: "Folder", targetFolder: "Archive" })
    ).rejects.toThrow("Specify either titles or sourceFolder, not both");
  });

  it("should throw if neither titles nor sourceFolder provided", async () => {
    await expect(
      batchMove({ targetFolder: "Archive" })
    ).rejects.toThrow("Specify either titles or sourceFolder");
  });

  it("should throw in readonly mode", async () => {
    process.env.READONLY_MODE = "true";
    await expect(batchMove({ sourceFolder: "Temp", targetFolder: "Archive" })).rejects.toThrow("read-only mode");
  });

  it("should move all notes from source folder", async () => {
    vi.mocked(runJxa).mockResolvedValue(JSON.stringify({ movedCount: 3 }));

    const result = await batchMove({
      sourceFolder: "Temp",
      targetFolder: "Archive",
    });

    expect(result.moved).toBe(3);
    expect(result.failed).toEqual([]);
  });

  it("should move individual notes by title", async () => {
    vi.mocked(resolveNoteTitle)
      .mockResolvedValueOnce({ success: true, note: { id: "1", title: "Note 1", folder: "Work" } })
      .mockResolvedValueOnce({ success: true, note: { id: "2", title: "Note 2", folder: "Work" } });
    vi.mocked(runJxa).mockResolvedValue("ok");

    const result = await batchMove({ titles: ["Note 1", "Note 2"], targetFolder: "Archive" });

    expect(result.moved).toBe(2);
    expect(result.failed).toEqual([]);
  });

  it("should track failed moves", async () => {
    vi.mocked(resolveNoteTitle)
      .mockResolvedValueOnce({ success: true, note: { id: "1", title: "Note 1", folder: "Work" } })
      .mockResolvedValueOnce({ success: false, error: "Note not found" });
    vi.mocked(runJxa).mockResolvedValue("ok");

    const result = await batchMove({ titles: ["Note 1", "Missing Note"], targetFolder: "Archive" });

    expect(result.moved).toBe(1);
    expect(result.failed).toEqual(["Missing Note"]);
  });
});
