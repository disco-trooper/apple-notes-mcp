import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock run-jxa before importing read module
vi.mock("run-jxa", () => ({
  runJxa: vi.fn(),
}));

import { runJxa } from "run-jxa";
import { getAllNotes, getNoteByTitle, getAllFolders, resolveNoteTitle, listNotes } from "./read.js";

describe("getAllNotes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return empty array when no notes exist", async () => {
    vi.mocked(runJxa).mockResolvedValueOnce("[]");

    const notes = await getAllNotes();
    expect(notes).toEqual([]);
  });

  it("should return notes with metadata", async () => {
    const mockNotes = [
      { title: "Note 1", folder: "Work", created: "2024-01-01T00:00:00Z", modified: "2024-01-02T00:00:00Z" },
      { title: "Note 2", folder: "Personal", created: "2024-01-03T00:00:00Z", modified: "2024-01-04T00:00:00Z" },
    ];
    vi.mocked(runJxa).mockResolvedValueOnce(JSON.stringify(mockNotes));

    const notes = await getAllNotes();
    expect(notes).toHaveLength(2);
    expect(notes[0].title).toBe("Note 1");
    expect(notes[1].folder).toBe("Personal");
  });
});

describe("getNoteByTitle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return null when note not found", async () => {
    vi.mocked(runJxa).mockResolvedValueOnce("[]");

    const note = await getNoteByTitle("Missing Note");
    expect(note).toBeNull();
  });

  it("should return note with content", async () => {
    const mockNotes = [{
      id: "123",
      title: "My Note",
      folder: "Work",
      created: "2024-01-01T00:00:00Z",
      modified: "2024-01-02T00:00:00Z",
      htmlContent: "<p>Hello World</p>",
    }];
    vi.mocked(runJxa).mockResolvedValueOnce(JSON.stringify(mockNotes));

    const note = await getNoteByTitle("My Note");
    expect(note).not.toBeNull();
    expect(note?.title).toBe("My Note");
    expect(note?.content).toContain("Hello World");
  });

  it("should handle folder/title format", async () => {
    const mockNotes = [{
      id: "123",
      title: "Note",
      folder: "Work",
      created: "2024-01-01T00:00:00Z",
      modified: "2024-01-02T00:00:00Z",
      htmlContent: "<p>Content</p>",
    }];
    vi.mocked(runJxa).mockResolvedValueOnce(JSON.stringify(mockNotes));

    const note = await getNoteByTitle("Work/Note");
    expect(note).not.toBeNull();
    expect(note?.folder).toBe("Work");
  });
});

describe("getAllFolders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return folder names", async () => {
    const mockFolders = ["Work", "Personal", "Archive"];
    vi.mocked(runJxa).mockResolvedValueOnce(JSON.stringify(mockFolders));

    const folders = await getAllFolders();
    expect(folders).toEqual(["Work", "Personal", "Archive"]);
  });
});

describe("resolveNoteTitle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return error when no notes found", async () => {
    vi.mocked(runJxa).mockResolvedValueOnce("[]");

    const result = await resolveNoteTitle("Missing");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("should return note when exactly one match", async () => {
    const mockNotes = [{ id: "123", title: "My Note", folder: "Work" }];
    vi.mocked(runJxa).mockResolvedValueOnce(JSON.stringify(mockNotes));

    const result = await resolveNoteTitle("My Note");
    expect(result.success).toBe(true);
    expect(result.note?.id).toBe("123");
  });

  it("should return suggestions when multiple matches", async () => {
    const mockNotes = [
      { id: "123", title: "Note", folder: "Work", created: "2026-01-09T10:00:00.000Z" },
      { id: "456", title: "Note", folder: "Personal", created: "2026-01-09T11:00:00.000Z" },
    ];
    vi.mocked(runJxa).mockResolvedValueOnce(JSON.stringify(mockNotes));

    const result = await resolveNoteTitle("Note");
    expect(result.success).toBe(false);
    expect(result.suggestions).toHaveLength(2);
    expect(result.suggestions?.[0].id).toBe("123");
    expect(result.suggestions?.[0].folder).toBe("Work");
    expect(result.suggestions?.[1].id).toBe("456");
  });

  it("should resolve note by ID prefix", async () => {
    const mockNote = {
      id: "x-coredata://123",
      title: "ID Note",
      folder: "Work",
      created: "2026-01-09T10:00:00.000Z",
      modified: "2026-01-09T11:00:00.000Z",
      htmlContent: "<p>Content</p>",
    };
    vi.mocked(runJxa).mockResolvedValueOnce(JSON.stringify(mockNote));

    const result = await resolveNoteTitle("id:x-coredata://123");
    expect(result.success).toBe(true);
    expect(result.note?.id).toBe("x-coredata://123");
  });

  it("should return error for invalid ID", async () => {
    vi.mocked(runJxa).mockResolvedValueOnce("null");

    const result = await resolveNoteTitle("id:invalid-id");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });
});

describe("getNoteByTitle with ID prefix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should route id: prefix to ID lookup", async () => {
    const mockNote = {
      id: "x-coredata://abc",
      title: "My Note",
      folder: "Work",
      created: "2026-01-09T10:00:00.000Z",
      modified: "2026-01-09T11:00:00.000Z",
      htmlContent: "<p>Hello</p>",
    };
    vi.mocked(runJxa).mockResolvedValueOnce(JSON.stringify(mockNote));

    const note = await getNoteByTitle("id:x-coredata://abc");
    expect(note).not.toBeNull();
    expect(note?.id).toBe("x-coredata://abc");
  });

  it("should return null for non-existent ID", async () => {
    vi.mocked(runJxa).mockResolvedValueOnce("null");

    const note = await getNoteByTitle("id:nonexistent");
    expect(note).toBeNull();
  });
});

describe("listNotes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockNotes = [
    { title: "Alpha", folder: "Work", created: "2024-01-01T00:00:00Z", modified: "2024-01-10T00:00:00Z" },
    { title: "Beta", folder: "Personal", created: "2024-01-03T00:00:00Z", modified: "2024-01-05T00:00:00Z" },
    { title: "Gamma", folder: "Work", created: "2024-01-02T00:00:00Z", modified: "2024-01-15T00:00:00Z" },
  ];

  it("should return all notes with default sorting (modified desc)", async () => {
    vi.mocked(runJxa).mockResolvedValueOnce(JSON.stringify(mockNotes));

    const notes = await listNotes();
    expect(notes).toHaveLength(3);
    // Most recently modified first
    expect(notes[0].title).toBe("Gamma");
    expect(notes[1].title).toBe("Alpha");
    expect(notes[2].title).toBe("Beta");
  });

  it("should sort by created date ascending", async () => {
    vi.mocked(runJxa).mockResolvedValueOnce(JSON.stringify(mockNotes));

    const notes = await listNotes({ sort_by: "created", order: "asc" });
    expect(notes[0].title).toBe("Alpha");
    expect(notes[1].title).toBe("Gamma");
    expect(notes[2].title).toBe("Beta");
  });

  it("should sort by created date descending", async () => {
    vi.mocked(runJxa).mockResolvedValueOnce(JSON.stringify(mockNotes));

    const notes = await listNotes({ sort_by: "created", order: "desc" });
    expect(notes[0].title).toBe("Beta");
    expect(notes[1].title).toBe("Gamma");
    expect(notes[2].title).toBe("Alpha");
  });

  it("should sort by title alphabetically", async () => {
    vi.mocked(runJxa).mockResolvedValueOnce(JSON.stringify(mockNotes));

    const notes = await listNotes({ sort_by: "title", order: "asc" });
    expect(notes[0].title).toBe("Alpha");
    expect(notes[1].title).toBe("Beta");
    expect(notes[2].title).toBe("Gamma");
  });

  it("should sort by title descending", async () => {
    vi.mocked(runJxa).mockResolvedValueOnce(JSON.stringify(mockNotes));

    const notes = await listNotes({ sort_by: "title", order: "desc" });
    expect(notes[0].title).toBe("Gamma");
    expect(notes[1].title).toBe("Beta");
    expect(notes[2].title).toBe("Alpha");
  });

  it("should filter by folder", async () => {
    vi.mocked(runJxa).mockResolvedValueOnce(JSON.stringify(mockNotes));

    const notes = await listNotes({ folder: "Work" });
    expect(notes).toHaveLength(2);
    expect(notes.every(n => n.folder === "Work")).toBe(true);
  });

  it("should apply limit", async () => {
    vi.mocked(runJxa).mockResolvedValueOnce(JSON.stringify(mockNotes));

    const notes = await listNotes({ limit: 2 });
    expect(notes).toHaveLength(2);
  });

  it("should combine folder filter and limit", async () => {
    vi.mocked(runJxa).mockResolvedValueOnce(JSON.stringify(mockNotes));

    const notes = await listNotes({ folder: "Work", limit: 1 });
    expect(notes).toHaveLength(1);
    expect(notes[0].folder).toBe("Work");
  });

  it("should return empty array when folder has no notes", async () => {
    vi.mocked(runJxa).mockResolvedValueOnce(JSON.stringify(mockNotes));

    const notes = await listNotes({ folder: "NonExistent" });
    expect(notes).toHaveLength(0);
  });

  it("should handle empty notes array", async () => {
    vi.mocked(runJxa).mockResolvedValueOnce("[]");

    const notes = await listNotes();
    expect(notes).toHaveLength(0);
  });

  it("should handle notes with empty date strings without crashing", async () => {
    const notesWithEmptyDates = [
      { title: "Valid", folder: "Work", created: "2024-01-01T00:00:00Z", modified: "2024-01-10T00:00:00Z" },
      { title: "Empty", folder: "Work", created: "", modified: "" },
    ];
    vi.mocked(runJxa).mockResolvedValueOnce(JSON.stringify(notesWithEmptyDates));

    const notes = await listNotes();
    expect(notes).toHaveLength(2);
    expect(notes[0].title).toBe("Valid");
    expect(notes[1].title).toBe("Empty");
  });

  it("should sort notes with empty dates to the end (oldest)", async () => {
    const notesWithEmptyDates = [
      { title: "Empty", folder: "Work", created: "", modified: "" },
      { title: "Valid", folder: "Work", created: "2024-01-01T00:00:00Z", modified: "2024-01-10T00:00:00Z" },
    ];
    vi.mocked(runJxa).mockResolvedValueOnce(JSON.stringify(notesWithEmptyDates));

    const notes = await listNotes({ sort_by: "modified", order: "desc" });
    expect(notes).toHaveLength(2);
    // Valid note should come first (most recent)
    expect(notes[0].title).toBe("Valid");
    // Empty date should be last (treated as oldest)
    expect(notes[1].title).toBe("Empty");
  });

  it("should handle mixing valid and empty dates correctly", async () => {
    const mixedDates = [
      { title: "Recent", folder: "Work", created: "2024-03-01T00:00:00Z", modified: "2024-03-15T00:00:00Z" },
      { title: "Empty1", folder: "Work", created: "", modified: "" },
      { title: "Old", folder: "Work", created: "2024-01-01T00:00:00Z", modified: "2024-01-10T00:00:00Z" },
      { title: "Empty2", folder: "Work", created: "", modified: "" },
      { title: "Middle", folder: "Work", created: "2024-02-01T00:00:00Z", modified: "2024-02-15T00:00:00Z" },
    ];
    vi.mocked(runJxa).mockResolvedValueOnce(JSON.stringify(mixedDates));

    const notes = await listNotes({ sort_by: "modified", order: "desc" });
    expect(notes).toHaveLength(5);
    // Order should be: Recent, Middle, Old, Empty1, Empty2
    expect(notes[0].title).toBe("Recent");
    expect(notes[1].title).toBe("Middle");
    expect(notes[2].title).toBe("Old");
    // Empty dates at the end (treated as epoch)
    expect(notes[3].title).toBe("Empty1");
    expect(notes[4].title).toBe("Empty2");
  });

  it("should sort empty dates to the beginning when sorting ascending", async () => {
    const mixedDates = [
      { title: "Recent", folder: "Work", created: "2024-03-01T00:00:00Z", modified: "2024-03-15T00:00:00Z" },
      { title: "Empty", folder: "Work", created: "", modified: "" },
      { title: "Old", folder: "Work", created: "2024-01-01T00:00:00Z", modified: "2024-01-10T00:00:00Z" },
    ];
    vi.mocked(runJxa).mockResolvedValueOnce(JSON.stringify(mixedDates));

    const notes = await listNotes({ sort_by: "modified", order: "asc" });
    expect(notes).toHaveLength(3);
    // Empty date should be first (oldest when ascending)
    expect(notes[0].title).toBe("Empty");
    expect(notes[1].title).toBe("Old");
    expect(notes[2].title).toBe("Recent");
  });
});
