import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock run-jxa before importing read module
vi.mock("run-jxa", () => ({
  runJxa: vi.fn(),
}));

import { runJxa } from "run-jxa";
import { getAllNotes, getNoteByTitle, getAllFolders, resolveNoteTitle } from "./read.js";

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
      { id: "123", title: "Note", folder: "Work" },
      { id: "456", title: "Note", folder: "Personal" },
    ];
    vi.mocked(runJxa).mockResolvedValueOnce(JSON.stringify(mockNotes));

    const result = await resolveNoteTitle("Note");
    expect(result.success).toBe(false);
    expect(result.suggestions).toHaveLength(2);
    expect(result.suggestions).toContain("Work/Note");
  });
});
