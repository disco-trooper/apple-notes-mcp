import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the killable JXA runner before importing the read module: every
// read.ts and resolve.ts call goes through executeJxa.
vi.mock("./jxa-runner.js", () => ({
  executeJxa: vi.fn(),
}));

import { executeJxa } from "./jxa-runner.js";
import { getAllNotes, getNoteByTitle, getAllFolders, listNotes, getNoteMetadataByFolder, fetchFolderBatched } from "./read.js";
import { resolveNoteTitle, buildLookupCandidates } from "./resolve.js";
import { DuplicateNoteError } from "../errors/index.js";

/** Slim note shape used across the list/metadata tests below. */
interface FolderedNote {
  id?: string;
  title: string;
  folder: string;
  created: string;
  modified: string;
  htmlContent?: string;
}

/** Read `const expectedName = "...";` from generated JXA. */
function parseExpectedName(src: string): string {
  const match = src.match(/const expectedName = ("(?:[^"\\]|\\.)*");/);
  if (!match) {
    throw new Error("mockFolderedNotes: cannot parse expectedName from JXA code");
  }
  return JSON.parse(match[1]) as string;
}

/** Read `const folderIndex = N;` from generated JXA. */
function parseFolderIndex(src: string): number {
  const match = src.match(/const folderIndex = (\d+);/);
  if (!match) {
    throw new Error("mockFolderedNotes: cannot parse folderIndex from JXA code");
  }
  return Number(match[1]);
}

/**
 * Resolve the fixture folder the way Apple Notes would for the generated
 * JXA: the folder at the requested enumeration index must guard-match the
 * expected name — case-insensitive when the code folds case (`toLowerCase`,
 * the metadata path), strict otherwise (content/single-note paths). A
 * guard mismatch throws, mirroring the real JXA guard. This keeps the mock
 * honest — a lowercase request only finds "Work" when the implementation
 * actually emits case-folding JXA, and a wrong index fails loudly.
 */
function resolveFixtureFolder(
  byFolder: Map<string, FolderedNote[]>,
  src: string,
  folderIndex: number,
  expected: string
): FolderedNote[] {
  const keys = [...byFolder.keys()];
  const indexed = keys[folderIndex];
  if (indexed === undefined) {
    throw new Error(`mockFolderedNotes: folderIndex ${folderIndex} out of range`);
  }
  const matches = src.includes("toLowerCase")
    ? indexed.toLowerCase() === expected.toLowerCase()
    : indexed === expected;
  if (!matches) {
    throw new Error(
      `mockFolderedNotes: folder guard mismatch at index ${folderIndex} (expected "${expected}", indexed "${indexed}")`
    );
  }
  return byFolder.get(indexed) ?? [];
}

/**
 * Route mocked JXA calls through the bulk-fetch protocol in read.ts:
 * - folder enumeration (`folders.name()`) resolves with `{ names, counts }`
 *   (parallel per-folder note counts) built from the folders present in the
 *   fixture data, so the driver plans batch ranges without count calls,
 * - count call (`.notes.length`, no `.slice(`, no `folders.name()`)
 *   resolves with that folder's note count (fallback path when enumerate
 *   counts are missing/corrupt),
 * - batch call (`.slice(`, bounds in `const startIdx/endIdx`) resolves with
 *   that folder's JSON slice.
 * Folder resolution mirrors Notes (see resolveFixtureFolder): the
 * enumeration index selects the fixture folder and the expected-name guard
 * is enforced, case-folding JXA matching case-insensitively.
 * Anything else throws so protocol drift fails loudly instead of serving
 * wrong-shaped data. Sorting/filtering/limits stay in the real
 * implementation; only the JXA transport is faked.
 */
function mockFolderedNotes(allNotes: FolderedNote[]) {
  const byFolder = new Map<string, FolderedNote[]>();
  for (const note of allNotes) {
    const list = byFolder.get(note.folder) ?? [];
    list.push(note);
    byFolder.set(note.folder, list);
  }
  vi.mocked(executeJxa).mockReset();
  vi.mocked(executeJxa).mockImplementation(async (...args: Parameters<typeof executeJxa>) => {
    const src = String(args[0]);
    if (src.includes("folders.name()")) {
      const keys = [...byFolder.keys()];
      return JSON.stringify({ names: keys, counts: keys.map((k) => byFolder.get(k)?.length ?? 0) });
    }
    if (src.includes(".slice(")) {
      const start = Number(src.match(/const startIdx = (\d+);/)?.[1]);
      const end = Number(src.match(/const endIdx = (\d+);/)?.[1]);
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        throw new Error("mockFolderedNotes: cannot parse batch bounds from JXA code");
      }
      return JSON.stringify(
        resolveFixtureFolder(byFolder, src, parseFolderIndex(src), parseExpectedName(src)).slice(start, end)
      );
    }
    if (src.includes(".notes.length")) {
      return JSON.stringify(
        resolveFixtureFolder(byFolder, src, parseFolderIndex(src), parseExpectedName(src)).length
      );
    }
    throw new Error(`mockFolderedNotes: unexpected JXA call: ${src.slice(0, 160)}`);
  });
}

describe("getAllNotes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return empty array when no notes exist", async () => {
    // New enumerate shape with usable counts: no re-enumerate retry, and the
    // persistent mock cannot leak a stale implementation from another test.
    vi.mocked(executeJxa).mockReset();
    vi.mocked(executeJxa).mockResolvedValue(JSON.stringify({ names: [], counts: [] }));

    const notes = await getAllNotes();
    expect(notes).toEqual([]);
  });

  it("should return notes with metadata", async () => {
    const mockNotes = [
      { title: "Note 1", folder: "Work", created: "2024-01-01T00:00:00Z", modified: "2024-01-02T00:00:00Z" },
      { title: "Note 2", folder: "Personal", created: "2024-01-03T00:00:00Z", modified: "2024-01-04T00:00:00Z" },
    ];
    mockFolderedNotes(mockNotes);

    const notes = await getAllNotes();
    expect(notes).toHaveLength(2);
    expect(notes[0].title).toBe("Note 1");
    expect(notes[1].folder).toBe("Personal");
  });

  it("should fall back to per-folder count calls when enumerate counts are missing", async () => {
    const mockNotes: FolderedNote[] = [
      { title: "Note 1", folder: "Work", created: "2024-01-01T00:00:00Z", modified: "2024-01-02T00:00:00Z" },
      { title: "Note 2", folder: "Personal", created: "2024-01-03T00:00:00Z", modified: "2024-01-04T00:00:00Z" },
    ];
    const byFolder = new Map<string, FolderedNote[]>();
    for (const note of mockNotes) {
      const list = byFolder.get(note.folder) ?? [];
      list.push(note);
      byFolder.set(note.folder, list);
    }
    vi.mocked(executeJxa).mockReset();
    vi.mocked(executeJxa).mockImplementation(async (...args: Parameters<typeof executeJxa>) => {
      const src = String(args[0]);
      if (src.includes("folders.name()")) {
        // Corrupt enumerate: legacy shape without per-folder counts.
        const keys = [...byFolder.keys()];
        return JSON.stringify({ names: keys, count: keys.length });
      }
      if (src.includes(".slice(")) {
        const start = Number(src.match(/const startIdx = (\d+);/)?.[1]);
        const end = Number(src.match(/const endIdx = (\d+);/)?.[1]);
        return JSON.stringify(
          resolveFixtureFolder(byFolder, src, parseFolderIndex(src), parseExpectedName(src)).slice(start, end)
        );
      }
      if (src.includes(".notes.length")) {
        return JSON.stringify(
          resolveFixtureFolder(byFolder, src, parseFolderIndex(src), parseExpectedName(src)).length
        );
      }
      throw new Error(`unexpected JXA call: ${src.slice(0, 160)}`);
    });

    const notes = await getAllNotes();
    expect(notes).toHaveLength(2);
    expect(notes[0].title).toBe("Note 1");
    expect(notes[1].folder).toBe("Personal");
    // The fallback path really ran: per-folder count calls (`.notes.length`
    // outside the enumeration call) are present.
    const countCalls = vi.mocked(executeJxa).mock.calls.filter(
      ([code]) => String(code).includes(".notes.length") && !String(code).includes("folders.name()")
    );
    expect(countCalls.length).toBeGreaterThan(0);
  });
});

/** Raw note payload as the by-id JXA returns it. */
function rawNote(overrides: Partial<FolderedNote> = {}): FolderedNote {
  return {
    id: "x-coredata://123",
    title: "My Note",
    folder: "Work",
    created: "2024-01-01T00:00:00Z",
    modified: "2024-01-02T00:00:00Z",
    htmlContent: "<p>Hello World</p>",
    ...overrides,
  };
}

describe("getNoteByTitle", () => {
  beforeEach(() => {
    vi.mocked(executeJxa).mockReset();
  });

  it("should return null when note not found", async () => {
    vi.mocked(executeJxa).mockResolvedValueOnce(JSON.stringify([[]]));

    const note = await getNoteByTitle("Missing Note");
    expect(note).toBeNull();
  });

  it("should resolve the title, then read the note by id", async () => {
    vi.mocked(executeJxa)
      .mockResolvedValueOnce(JSON.stringify([[{ id: "x-coredata://123", title: "My Note", folder: "Work", created: "" }]]))
      .mockResolvedValueOnce(JSON.stringify(rawNote()));

    const note = await getNoteByTitle("My Note");
    expect(note?.id).toBe("x-coredata://123");
    expect(note?.folder).toBe("Work");
    expect(note?.content).toContain("Hello World");
    expect(String(vi.mocked(executeJxa).mock.calls[1][0])).toContain('"x-coredata://123"');
  });

  it("should throw DuplicateNoteError instead of returning the first match", async () => {
    vi.mocked(executeJxa).mockResolvedValueOnce(
      JSON.stringify([[
        { id: "a", title: "Note", folder: "Work", created: "2026-01-09T10:00:00.000Z" },
        { id: "b", title: "Note", folder: "Personal", created: "2026-01-09T11:00:00.000Z" },
      ]])
    );

    const error = await getNoteByTitle("Note").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DuplicateNoteError);
    expect((error as DuplicateNoteError).suggestions.map((s) => s.id)).toEqual(["a", "b"]);
    expect(executeJxa).toHaveBeenCalledTimes(1);
  });
});

describe("buildLookupCandidates", () => {
  it("tries the whole input as a title first, then every split from the right", () => {
    expect(buildLookupCandidates("Work/2024/05/12 Standup")).toEqual([
      { title: "Work/2024/05/12 Standup", folder: null },
      { title: "12 Standup", folder: "Work/2024/05" },
      { title: "05/12 Standup", folder: "Work/2024" },
      { title: "2024/05/12 Standup", folder: "Work" },
    ]);
  });

  it("skips splits with an empty folder or title", () => {
    expect(buildLookupCandidates("/Note")).toEqual([{ title: "/Note", folder: null }]);
    expect(buildLookupCandidates("Folder/")).toEqual([{ title: "Folder/", folder: null }]);
  });

  it("returns only the title candidate when there is no slash", () => {
    expect(buildLookupCandidates("Plain")).toEqual([{ title: "Plain", folder: null }]);
  });
});

describe("getAllFolders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return folder names", async () => {
    const mockFolders = ["Work", "Personal", "Archive"];
    // New enumerate shape with usable counts: no re-enumerate retry, so one
    // persistent mock covers the call (a legacy `{ names, count }` Once-mock
    // would retry into a stale implementation from another test).
    vi.mocked(executeJxa).mockReset();
    vi.mocked(executeJxa).mockResolvedValue(
      JSON.stringify({ names: mockFolders, counts: mockFolders.map(() => 0) })
    );

    const folders = await getAllFolders();
    expect(folders).toEqual(["Work", "Personal", "Archive"]);
  });

  it("should hide every account's Recently Deleted folder", async () => {
    const mockFolders = ["Work", "Recently Deleted", "Notes", "recently deleted"];
    vi.mocked(executeJxa).mockReset();
    vi.mocked(executeJxa).mockResolvedValue(
      JSON.stringify({ names: mockFolders, counts: mockFolders.map(() => 0) })
    );

    await expect(getAllFolders()).resolves.toEqual(["Work", "Notes"]);
  });
});

describe("Recently Deleted exclusion", () => {
  const library: FolderedNote[] = [
    { id: "w", title: "Live", folder: "Work", created: "2024-01-01T00:00:00Z", modified: "2024-01-02T00:00:00Z" },
    { id: "t", title: "Trashed", folder: "Recently Deleted", created: "2024-01-01T00:00:00Z", modified: "2024-01-03T00:00:00Z" },
    { id: "p", title: "Personal", folder: "Personal", created: "2024-01-01T00:00:00Z", modified: "2024-01-04T00:00:00Z" },
  ];

  it("getAllNotes never fetches the trash folder and keeps later indices intact", async () => {
    mockFolderedNotes(library);

    const notes = await getAllNotes();
    expect(notes.map((n) => n.id)).toEqual(["w", "p"]);
    const fetched = vi.mocked(executeJxa).mock.calls.map(([code]) => String(code));
    expect(fetched.some((code) => code.includes('"Recently Deleted"'))).toBe(false);
    // "Personal" sits after the trash folder: still addressed by its real index.
    expect(fetched.some((code) => code.includes("const folderIndex = 2;"))).toBe(true);
  });

  it("list-notes cannot list the trash folder by name", async () => {
    mockFolderedNotes(library);

    await expect(listNotes({ folder: "recently deleted" })).resolves.toEqual([]);
  });
});

describe("resolveNoteTitle", () => {
  beforeEach(() => {
    vi.mocked(executeJxa).mockReset();
  });

  it("should return error when no notes found", async () => {
    vi.mocked(executeJxa).mockResolvedValueOnce(JSON.stringify([[]]));

    const result = await resolveNoteTitle("Missing");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("should return note when exactly one match", async () => {
    vi.mocked(executeJxa).mockResolvedValueOnce(
      JSON.stringify([[{ id: "123", title: "My Note", folder: "Work", created: "" }]])
    );

    const result = await resolveNoteTitle("My Note");
    expect(result.success).toBe(true);
    expect(result.note).toEqual({ id: "123", title: "My Note", folder: "Work" });
  });

  it("should return suggestions when multiple matches", async () => {
    vi.mocked(executeJxa).mockResolvedValueOnce(
      JSON.stringify([[
        { id: "123", title: "Note", folder: "Work", created: "2026-01-09T10:00:00.000Z" },
        { id: "456", title: "Note", folder: "Personal", created: "2026-01-09T11:00:00.000Z" },
      ]])
    );

    const result = await resolveNoteTitle("Note");
    expect(result.success).toBe(false);
    expect(result.suggestions).toHaveLength(2);
    expect(result.suggestions?.[0].id).toBe("123");
    expect(result.suggestions?.[0].folder).toBe("Work");
    expect(result.suggestions?.[1].id).toBe("456");
  });

  it("should resolve a title containing '/' as a whole title first", async () => {
    vi.mocked(executeJxa).mockResolvedValueOnce(
      JSON.stringify([[{ id: "q", title: "Q1/Q2 plan", folder: "Work", created: "" }]])
    );

    const result = await resolveNoteTitle("Q1/Q2 plan");
    expect(result.note?.id).toBe("q");
    // All interpretations travel in one script, whole title first.
    const code = String(vi.mocked(executeJxa).mock.calls[0][0]);
    expect(code).toContain(JSON.stringify(buildLookupCandidates("Q1/Q2 plan")));
    expect(executeJxa).toHaveBeenCalledTimes(1);
  });

  it("should fall back to a folder/title split when the whole title matches nothing", async () => {
    // The script stops at the first candidate with hits: whole title empty,
    // then folder "Work" + title "Note" matched.
    vi.mocked(executeJxa).mockResolvedValueOnce(
      JSON.stringify([[], [{ id: "w", title: "Note", folder: "Work", created: "" }]])
    );

    const result = await resolveNoteTitle("Work/Note");
    expect(result.note).toEqual({ id: "w", title: "Note", folder: "Work" });
  });

  it("should name the split title in the ambiguity error", async () => {
    vi.mocked(executeJxa).mockResolvedValueOnce(
      JSON.stringify([[], [
        { id: "1", title: "Note", folder: "Work", created: "" },
        { id: "2", title: "Note", folder: "Work", created: "" },
      ]])
    );

    const result = await resolveNoteTitle("Work/Note");
    expect(result.success).toBe(false);
    expect(result.error).toContain('"Note"');
    expect(result.suggestions).toHaveLength(2);
  });

  it("should resolve note by ID prefix without reading the body", async () => {
    vi.mocked(executeJxa).mockResolvedValueOnce(
      JSON.stringify({ id: "x-coredata://123", title: "ID Note", folder: "Work" })
    );

    const result = await resolveNoteTitle("id:x-coredata://123");
    expect(result.note).toEqual({ id: "x-coredata://123", title: "ID Note", folder: "Work" });
    const code = String(vi.mocked(executeJxa).mock.calls[0][0]);
    expect(code).toContain("byId");
    expect(code).not.toContain("body()");
  });

  it("should return error for invalid ID", async () => {
    vi.mocked(executeJxa).mockResolvedValueOnce("null");

    const result = await resolveNoteTitle("id:invalid-id");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });
});

describe("getNoteById", () => {
  beforeEach(() => {
    vi.mocked(executeJxa).mockReset();
  });

  it("should route id: prefix to a direct byId lookup without scanning folders", async () => {
    vi.mocked(executeJxa).mockResolvedValueOnce(JSON.stringify(rawNote({ id: "x-coredata://abc", folder: "Nested" })));

    const note = await getNoteByTitle("id:x-coredata://abc");
    expect(note?.id).toBe("x-coredata://abc");
    expect(note?.folder).toBe("Nested");
    const code = String(vi.mocked(executeJxa).mock.calls[0][0]);
    expect(code).toContain("app.notes.byId");
    expect(code).toContain("container()");
    expect(code).not.toContain("app.folders()");
    expect(code).not.toContain("properties()");
  });

  it("should return null for non-existent ID", async () => {
    vi.mocked(executeJxa).mockResolvedValueOnce("null");

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
    mockFolderedNotes(mockNotes);

    const notes = await listNotes();
    expect(notes).toHaveLength(3);
    // Most recently modified first
    expect(notes[0].title).toBe("Gamma");
    expect(notes[1].title).toBe("Alpha");
    expect(notes[2].title).toBe("Beta");
  });

  it("should sort by created date ascending", async () => {
    mockFolderedNotes(mockNotes);

    const notes = await listNotes({ sort_by: "created", order: "asc" });
    expect(notes[0].title).toBe("Alpha");
    expect(notes[1].title).toBe("Gamma");
    expect(notes[2].title).toBe("Beta");
  });

  it("should sort by created date descending", async () => {
    mockFolderedNotes(mockNotes);

    const notes = await listNotes({ sort_by: "created", order: "desc" });
    expect(notes[0].title).toBe("Beta");
    expect(notes[1].title).toBe("Gamma");
    expect(notes[2].title).toBe("Alpha");
  });

  it("should sort by title alphabetically", async () => {
    mockFolderedNotes(mockNotes);

    const notes = await listNotes({ sort_by: "title", order: "asc" });
    expect(notes[0].title).toBe("Alpha");
    expect(notes[1].title).toBe("Beta");
    expect(notes[2].title).toBe("Gamma");
  });

  it("should sort by title descending", async () => {
    mockFolderedNotes(mockNotes);

    const notes = await listNotes({ sort_by: "title", order: "desc" });
    expect(notes[0].title).toBe("Gamma");
    expect(notes[1].title).toBe("Beta");
    expect(notes[2].title).toBe("Alpha");
  });

  it("should filter by folder (uses getNoteMetadataByFolder)", async () => {
    const workNotes = [
      { title: "Alpha", folder: "Work", created: "2024-01-01T00:00:00Z", modified: "2024-01-10T00:00:00Z" },
      { title: "Gamma", folder: "Work", created: "2024-01-02T00:00:00Z", modified: "2024-01-15T00:00:00Z" },
    ];
    mockFolderedNotes(workNotes);

    const notes = await listNotes({ folder: "Work" });
    expect(notes).toHaveLength(2);
    expect(notes.every(n => n.folder === "Work")).toBe(true);
  });

  it("should apply limit", async () => {
    mockFolderedNotes(mockNotes);

    const notes = await listNotes({ limit: 2 });
    expect(notes).toHaveLength(2);
  });

  it("should combine folder filter and limit", async () => {
    const workNotes = [
      { title: "Alpha", folder: "Work", created: "2024-01-01T00:00:00Z", modified: "2024-01-10T00:00:00Z" },
      { title: "Gamma", folder: "Work", created: "2024-01-02T00:00:00Z", modified: "2024-01-15T00:00:00Z" },
    ];
    mockFolderedNotes(workNotes);

    const notes = await listNotes({ folder: "Work", limit: 1 });
    expect(notes).toHaveLength(1);
    expect(notes[0].folder).toBe("Work");
  });

  it("should return empty array when folder has no notes", async () => {
    // New enumerate shape with usable counts: no re-enumerate retry, and the
    // persistent mock cannot leak a stale implementation from another test.
    vi.mocked(executeJxa).mockReset();
    vi.mocked(executeJxa).mockResolvedValue(JSON.stringify({ names: [], counts: [] }));

    const notes = await listNotes({ folder: "NonExistent" });
    expect(notes).toHaveLength(0);
  });

  it("should handle empty notes array", async () => {
    // New enumerate shape with usable counts: no re-enumerate retry, and the
    // persistent mock cannot leak a stale implementation from another test.
    vi.mocked(executeJxa).mockReset();
    vi.mocked(executeJxa).mockResolvedValue(JSON.stringify({ names: [], counts: [] }));

    const notes = await listNotes();
    expect(notes).toHaveLength(0);
  });

  it("should handle notes with empty date strings without crashing", async () => {
    const notesWithEmptyDates = [
      { title: "Valid", folder: "Work", created: "2024-01-01T00:00:00Z", modified: "2024-01-10T00:00:00Z" },
      { title: "Empty", folder: "Work", created: "", modified: "" },
    ];
    mockFolderedNotes(notesWithEmptyDates);

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
    mockFolderedNotes(notesWithEmptyDates);

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
    mockFolderedNotes(mixedDates);

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
    mockFolderedNotes(mixedDates);

    const notes = await listNotes({ sort_by: "modified", order: "asc" });
    expect(notes).toHaveLength(3);
    // Empty date should be first (oldest when ascending)
    expect(notes[0].title).toBe("Empty");
    expect(notes[1].title).toBe("Old");
    expect(notes[2].title).toBe("Recent");
  });
});

describe("getNoteMetadataByFolder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return notes from the specified folder", async () => {
    const folderNotes = [
      { title: "Note A", folder: "Projects", created: "2024-01-01T00:00:00Z", modified: "2024-01-02T00:00:00Z" },
      { title: "Note B", folder: "Projects", created: "2024-01-03T00:00:00Z", modified: "2024-01-04T00:00:00Z" },
    ];
    mockFolderedNotes(folderNotes);

    const notes = await getNoteMetadataByFolder("Projects");
    expect(notes).toHaveLength(2);
    expect(notes[0].title).toBe("Note A");
    expect(notes[1].folder).toBe("Projects");
  });

  it("should match folder names case-insensitively", async () => {
    const folderNotes = [
      { title: "Note A", folder: "Work", created: "2024-01-01T00:00:00Z", modified: "2024-01-02T00:00:00Z" },
    ];
    mockFolderedNotes(folderNotes);

    const notes = await getNoteMetadataByFolder("work");
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe("Note A");
    expect(notes[0].folder).toBe("Work");
  });

  it("should return empty array when folder has no notes", async () => {
    // New enumerate shape with usable counts: no re-enumerate retry, and the
    // persistent mock cannot leak a stale implementation from another test.
    vi.mocked(executeJxa).mockReset();
    vi.mocked(executeJxa).mockResolvedValue(JSON.stringify({ names: [], counts: [] }));

    const notes = await getNoteMetadataByFolder("Empty");
    expect(notes).toHaveLength(0);
  });

  it("should return metadata with id but without content fields", async () => {
    const folderNotes = [
      { id: "n-1", title: "Note", folder: "Work", created: "2024-01-01T00:00:00Z", modified: "2024-01-02T00:00:00Z" },
    ];
    mockFolderedNotes(folderNotes);

    const notes = await getNoteMetadataByFolder("Work");
    expect(notes[0]).toEqual({
      id: "n-1",
      title: "Note",
      folder: "Work",
      created: "2024-01-01T00:00:00Z",
      modified: "2024-01-02T00:00:00Z",
    });
  });

  it("should aggregate notes from duplicate folder names", async () => {
    const duplicateFolderNotes = [
      { title: "A1", folder: "Work", created: "2024-01-01T00:00:00Z", modified: "2024-01-02T00:00:00Z" },
      { title: "A2", folder: "Work", created: "2024-01-03T00:00:00Z", modified: "2024-01-04T00:00:00Z" },
    ];
    mockFolderedNotes(duplicateFolderNotes);

    const notes = await getNoteMetadataByFolder("Work");
    expect(notes).toHaveLength(2);
    expect(notes.map((n) => n.title)).toEqual(["A1", "A2"]);

    const jxaCode = vi.mocked(executeJxa).mock.calls[0][0] as string;
    expect(jxaCode).not.toContain("break;");
  });
});

describe("listNotes folder optimization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should use only folder-scoped JXA calls when folder is specified", async () => {
    const folderNotes = [
      { title: "Note 1", folder: "xx", created: "2024-01-01T00:00:00Z", modified: "2024-01-02T00:00:00Z" },
    ];
    mockFolderedNotes(folderNotes);

    const notes = await listNotes({ folder: "xx" });
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe("Note 1");
    const calls = vi.mocked(executeJxa).mock.calls;
    // Batching needs an enumerate call (carrying per-folder counts, so no
    // separate count call) plus one batch call.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // The first call enumerates folders (no `expectedName`); every later
    // call stays scoped to the requested folder via folderIndex +
    // `expectedName`, and batch calls carry the `.slice(` strategy marker.
    expect(String(calls[0][0])).not.toContain("expectedName");
    for (const [code] of calls.slice(1)) {
      expect(String(code)).toContain("expectedName");
      expect(String(code)).toContain('"xx"');
    }
    expect(calls.some(([code]) => String(code).includes(".slice("))).toBe(true);
  });

  it("should not fetch all notes when folder is specified", async () => {
    const folderNotes = [
      { title: "Only One", folder: "Tiny", created: "2024-01-01T00:00:00Z", modified: "2024-01-02T00:00:00Z" },
    ];
    mockFolderedNotes(folderNotes);

    const notes = await listNotes({ folder: "Tiny" });
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe("Only One");
  });

  it("should use getAllNotes when no folder is specified", async () => {
    const allNotes = [
      { title: "A", folder: "Work", created: "2024-01-01T00:00:00Z", modified: "2024-01-02T00:00:00Z" },
      { title: "B", folder: "Personal", created: "2024-01-03T00:00:00Z", modified: "2024-01-04T00:00:00Z" },
    ];
    mockFolderedNotes(allNotes);

    const notes = await listNotes();
    expect(notes).toHaveLength(2);
    // Unfiltered path first enumerates folders (no `expectedName`), then
    // fetches each folder with scoped batch calls (counts ride along from
    // the enumeration, so no separate count calls).
    const calls = vi.mocked(executeJxa).mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    expect(String(calls[0][0])).not.toContain("expectedName");
    expect(calls.slice(1).every(([code]) => String(code).includes("expectedName"))).toBe(true);
  });

  it("should still sort folder-filtered results", async () => {
    const folderNotes = [
      { title: "Old", folder: "Work", created: "2024-01-01T00:00:00Z", modified: "2024-01-05T00:00:00Z" },
      { title: "New", folder: "Work", created: "2024-01-02T00:00:00Z", modified: "2024-01-15T00:00:00Z" },
    ];
    mockFolderedNotes(folderNotes);

    const notes = await listNotes({ folder: "Work", sort_by: "modified", order: "desc" });
    expect(notes[0].title).toBe("New");
    expect(notes[1].title).toBe("Old");
  });

  it("should match folder names case-insensitively", async () => {
    const workNotes = [
      { title: "Case Note", folder: "Work", created: "2024-01-01T00:00:00Z", modified: "2024-01-02T00:00:00Z" },
    ];
    mockFolderedNotes(workNotes);

    // The metadata path restores the pre-bulk-fetch behavior: a lowercase
    // request still resolves the "Work" folder and keeps its original name.
    const notes = await listNotes({ folder: "work" });
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe("Case Note");
    expect(notes[0].folder).toBe("Work");
    // The match must come from case-folding JXA, not from a loose mock:
    // the mock only resolves case-insensitively when the generated code
    // folds case.
    expect(vi.mocked(executeJxa).mock.calls.some(([code]) => String(code).includes("toLowerCase"))).toBe(true);
  });

  it("should keep content fetches exact-match", async () => {
    const workNotes = [
      { title: "Case Note", folder: "Work", created: "2024-01-01T00:00:00Z", modified: "2024-01-02T00:00:00Z" },
    ];
    mockFolderedNotes(workNotes);

    // The content path was always strict: only the metadata path folds case.
    const { notes } = await fetchFolderBatched("work");
    expect(notes).toHaveLength(0);
    expect(vi.mocked(executeJxa).mock.calls.every(([code]) => !String(code).includes("toLowerCase"))).toBe(true);
  });
});
