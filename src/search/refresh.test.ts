import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../notes/read.js", () => ({
  getAllNotes: vi.fn(),
}));

vi.mock("../db/lancedb.js", () => ({
  getVectorStore: vi.fn(),
}));

vi.mock("./indexer.js", () => ({
  incrementalIndex: vi.fn(),
}));

describe("checkForChanges", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("should return true if notes were modified after indexing", async () => {
    const { getAllNotes } = await import("../notes/read.js");
    const { getVectorStore } = await import("../db/lancedb.js");

    vi.mocked(getAllNotes).mockResolvedValue([
      { title: "Note 1", folder: "Work", created: "2026-01-01", modified: "2026-01-10T12:00:00Z" },
    ]);

    vi.mocked(getVectorStore).mockReturnValue({
      getAll: vi.fn().mockResolvedValue([
        { title: "Note 1", folder: "Work", indexed_at: "2026-01-09T12:00:00Z" },
      ]),
    } as any);

    const { checkForChanges } = await import("./refresh.js");
    const hasChanges = await checkForChanges();

    expect(hasChanges).toBe(true);
  });

  it("should return false if no changes", async () => {
    const { getAllNotes } = await import("../notes/read.js");
    const { getVectorStore } = await import("../db/lancedb.js");

    vi.mocked(getAllNotes).mockResolvedValue([
      { title: "Note 1", folder: "Work", created: "2026-01-01", modified: "2026-01-08T12:00:00Z" },
    ]);

    vi.mocked(getVectorStore).mockReturnValue({
      getAll: vi.fn().mockResolvedValue([
        { title: "Note 1", folder: "Work", indexed_at: "2026-01-09T12:00:00Z" },
      ]),
    } as any);

    const { checkForChanges } = await import("./refresh.js");
    const hasChanges = await checkForChanges();

    expect(hasChanges).toBe(false);
  });

  it("should return true if new note added", async () => {
    const { getAllNotes } = await import("../notes/read.js");
    const { getVectorStore } = await import("../db/lancedb.js");

    vi.mocked(getAllNotes).mockResolvedValue([
      { title: "Note 1", folder: "Work", created: "2026-01-01", modified: "2026-01-08T12:00:00Z" },
      { title: "New Note", folder: "Work", created: "2026-01-10", modified: "2026-01-10T12:00:00Z" },
    ]);

    vi.mocked(getVectorStore).mockReturnValue({
      getAll: vi.fn().mockResolvedValue([
        { title: "Note 1", folder: "Work", indexed_at: "2026-01-09T12:00:00Z" },
      ]),
    } as any);

    const { checkForChanges } = await import("./refresh.js");
    const hasChanges = await checkForChanges();

    expect(hasChanges).toBe(true);
  });

  it("should return true if note deleted", async () => {
    const { getAllNotes } = await import("../notes/read.js");
    const { getVectorStore } = await import("../db/lancedb.js");

    vi.mocked(getAllNotes).mockResolvedValue([]);

    vi.mocked(getVectorStore).mockReturnValue({
      getAll: vi.fn().mockResolvedValue([
        { title: "Note 1", folder: "Work", indexed_at: "2026-01-09T12:00:00Z" },
      ]),
    } as any);

    const { checkForChanges } = await import("./refresh.js");
    const hasChanges = await checkForChanges();

    expect(hasChanges).toBe(true);
  });

  it("should return true if no index exists and notes exist", async () => {
    const { getAllNotes } = await import("../notes/read.js");
    const { getVectorStore } = await import("../db/lancedb.js");

    vi.mocked(getAllNotes).mockResolvedValue([
      { title: "Note 1", folder: "Work", created: "2026-01-01", modified: "2026-01-08T12:00:00Z" },
    ]);

    vi.mocked(getVectorStore).mockReturnValue({
      getAll: vi.fn().mockRejectedValue(new Error("Table not found")),
    } as any);

    const { checkForChanges } = await import("./refresh.js");
    const hasChanges = await checkForChanges();

    expect(hasChanges).toBe(true);
  });
});

describe("refreshIfNeeded", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("should trigger incremental index if changes detected", async () => {
    const { incrementalIndex } = await import("./indexer.js");
    const { getAllNotes } = await import("../notes/read.js");
    const { getVectorStore } = await import("../db/lancedb.js");

    vi.mocked(getAllNotes).mockResolvedValue([
      { title: "New Note", folder: "Work", created: "2026-01-10", modified: "2026-01-10T12:00:00Z" },
    ]);

    vi.mocked(getVectorStore).mockReturnValue({
      getAll: vi.fn().mockResolvedValue([]),
    } as any);

    vi.mocked(incrementalIndex).mockResolvedValue({
      total: 1,
      indexed: 1,
      errors: 0,
      timeMs: 100,
    });

    const { refreshIfNeeded } = await import("./refresh.js");
    const refreshed = await refreshIfNeeded();

    expect(refreshed).toBe(true);
    expect(incrementalIndex).toHaveBeenCalled();
  });

  it("should not trigger index if no changes", async () => {
    const { incrementalIndex } = await import("./indexer.js");
    const { getAllNotes } = await import("../notes/read.js");
    const { getVectorStore } = await import("../db/lancedb.js");

    vi.mocked(getAllNotes).mockResolvedValue([
      { title: "Note 1", folder: "Work", created: "2026-01-01", modified: "2026-01-08T12:00:00Z" },
    ]);

    vi.mocked(getVectorStore).mockReturnValue({
      getAll: vi.fn().mockResolvedValue([
        { title: "Note 1", folder: "Work", indexed_at: "2026-01-09T12:00:00Z" },
      ]),
    } as any);

    const { refreshIfNeeded } = await import("./refresh.js");
    const refreshed = await refreshIfNeeded();

    expect(refreshed).toBe(false);
    expect(incrementalIndex).not.toHaveBeenCalled();
  });
});
