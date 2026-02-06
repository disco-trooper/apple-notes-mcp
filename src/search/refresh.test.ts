import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../notes/read.js", () => ({
  getAllNotes: vi.fn(),
  getNoteByFolderAndTitle: vi.fn(),
}));

vi.mock("../db/lancedb.js", () => ({
  getVectorStore: vi.fn(),
  getChunkStore: vi.fn(),
}));

vi.mock("./indexer.js", () => ({
  incrementalIndex: vi.fn(),
}));

vi.mock("./chunk-indexer.js", () => ({
  hasChunkIndex: vi.fn().mockResolvedValue(false),
  updateChunksForNotes: vi.fn(),
}));

describe("checkForChanges", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.INDEX_TTL;
    delete process.env.SEARCH_REFRESH_TIMEOUT_MS;
  });

  it("returns true if notes were modified after indexing", async () => {
    const { getAllNotes } = await import("../notes/read.js");
    const { getVectorStore } = await import("../db/lancedb.js");

    vi.mocked(getAllNotes).mockResolvedValue([
      { title: "Note 1", folder: "Work", created: "2026-01-01", modified: "2026-01-10T12:00:00Z" },
    ]);

    vi.mocked(getVectorStore).mockReturnValue({
      getIndexMetadata: vi.fn().mockResolvedValue([
        { id: "1", title: "Note 1", folder: "Work", indexed_at: "2026-01-09T12:00:00Z" },
      ]),
    } as any);

    const { checkForChanges } = await import("./refresh.js");
    const hasChanges = await checkForChanges();

    expect(hasChanges).toBe(true);
  });

  it("returns false if no changes", async () => {
    const { getAllNotes } = await import("../notes/read.js");
    const { getVectorStore } = await import("../db/lancedb.js");

    vi.mocked(getAllNotes).mockResolvedValue([
      { title: "Note 1", folder: "Work", created: "2026-01-01", modified: "2026-01-08T12:00:00Z" },
    ]);

    vi.mocked(getVectorStore).mockReturnValue({
      getIndexMetadata: vi.fn().mockResolvedValue([
        { id: "1", title: "Note 1", folder: "Work", indexed_at: "2026-01-09T12:00:00Z" },
      ]),
    } as any);

    const { checkForChanges } = await import("./refresh.js");
    const hasChanges = await checkForChanges();

    expect(hasChanges).toBe(false);
  });

  it("returns true if a new note was added", async () => {
    const { getAllNotes } = await import("../notes/read.js");
    const { getVectorStore } = await import("../db/lancedb.js");

    vi.mocked(getAllNotes).mockResolvedValue([
      { title: "Note 1", folder: "Work", created: "2026-01-01", modified: "2026-01-08T12:00:00Z" },
      { title: "New Note", folder: "Work", created: "2026-01-10", modified: "2026-01-10T12:00:00Z" },
    ]);

    vi.mocked(getVectorStore).mockReturnValue({
      getIndexMetadata: vi.fn().mockResolvedValue([
        { id: "1", title: "Note 1", folder: "Work", indexed_at: "2026-01-09T12:00:00Z" },
      ]),
    } as any);

    const { checkForChanges } = await import("./refresh.js");
    const hasChanges = await checkForChanges();

    expect(hasChanges).toBe(true);
  });

  it("returns true if a note was deleted", async () => {
    const { getAllNotes } = await import("../notes/read.js");
    const { getVectorStore } = await import("../db/lancedb.js");

    vi.mocked(getAllNotes).mockResolvedValue([]);

    vi.mocked(getVectorStore).mockReturnValue({
      getIndexMetadata: vi.fn().mockResolvedValue([
        { id: "1", title: "Note 1", folder: "Work", indexed_at: "2026-01-09T12:00:00Z" },
      ]),
    } as any);

    const { checkForChanges } = await import("./refresh.js");
    const hasChanges = await checkForChanges();

    expect(hasChanges).toBe(true);
  });

  it("returns true if no index exists and notes exist", async () => {
    const { getAllNotes } = await import("../notes/read.js");
    const { getVectorStore } = await import("../db/lancedb.js");

    vi.mocked(getAllNotes).mockResolvedValue([
      { title: "Note 1", folder: "Work", created: "2026-01-01", modified: "2026-01-08T12:00:00Z" },
    ]);

    vi.mocked(getVectorStore).mockReturnValue({
      getIndexMetadata: vi.fn().mockRejectedValue(new Error("Table not found")),
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
    delete process.env.INDEX_TTL;
    delete process.env.SEARCH_REFRESH_TIMEOUT_MS;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips refresh when INDEX_TTL is not configured", async () => {
    const { incrementalIndex } = await import("./indexer.js");
    const { getVectorStore } = await import("../db/lancedb.js");

    const { refreshIfNeeded } = await import("./refresh.js");
    const refreshed = await refreshIfNeeded();

    expect(refreshed).toBe(false);
    expect(incrementalIndex).not.toHaveBeenCalled();
    expect(getVectorStore).not.toHaveBeenCalled();
  });

  it("triggers incremental index when TTL expired and changes detected", async () => {
    process.env.INDEX_TTL = "1";

    const { incrementalIndex } = await import("./indexer.js");
    const { getAllNotes } = await import("../notes/read.js");
    const { getVectorStore } = await import("../db/lancedb.js");

    vi.mocked(getAllNotes).mockResolvedValue([
      { title: "Note 1", folder: "Work", created: "2026-01-01", modified: "2026-01-10T12:00:00Z" },
    ]);

    vi.mocked(getVectorStore).mockReturnValue({
      getIndexMetadata: vi.fn().mockResolvedValue([
        { id: "1", title: "Note 1", folder: "Work", indexed_at: "2020-01-01T00:00:00Z" },
      ]),
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
    expect(incrementalIndex).toHaveBeenCalledOnce();
  });

  it("skips refresh when TTL is not expired", async () => {
    process.env.INDEX_TTL = "86400";

    const { incrementalIndex } = await import("./indexer.js");
    const { getVectorStore } = await import("../db/lancedb.js");

    vi.mocked(getVectorStore).mockReturnValue({
      getIndexMetadata: vi.fn().mockResolvedValue([
        {
          id: "1",
          title: "Note 1",
          folder: "Work",
          indexed_at: new Date().toISOString(),
        },
      ]),
    } as any);

    const { refreshIfNeeded } = await import("./refresh.js");
    const refreshed = await refreshIfNeeded();

    expect(refreshed).toBe(false);
    expect(incrementalIndex).not.toHaveBeenCalled();
  });

  it("returns false when refresh throws", async () => {
    process.env.INDEX_TTL = "1";

    const { incrementalIndex } = await import("./indexer.js");
    const { getAllNotes } = await import("../notes/read.js");
    const { getVectorStore } = await import("../db/lancedb.js");

    vi.mocked(getAllNotes).mockRejectedValue(new Error("JXA failed"));

    vi.mocked(getVectorStore).mockReturnValue({
      getIndexMetadata: vi.fn().mockResolvedValue([
        { id: "1", title: "Note 1", folder: "Work", indexed_at: "2020-01-01T00:00:00Z" },
      ]),
    } as any);

    const { refreshIfNeeded } = await import("./refresh.js");
    const refreshed = await refreshIfNeeded();

    expect(refreshed).toBe(false);
    expect(incrementalIndex).not.toHaveBeenCalled();
  });

  it("returns false when refresh exceeds timeout budget", async () => {
    vi.useFakeTimers();

    process.env.INDEX_TTL = "1";
    process.env.SEARCH_REFRESH_TIMEOUT_MS = "5";

    const { incrementalIndex } = await import("./indexer.js");
    const { getAllNotes } = await import("../notes/read.js");
    const { getVectorStore } = await import("../db/lancedb.js");

    vi.mocked(getAllNotes).mockResolvedValue([
      { title: "Note 1", folder: "Work", created: "2026-01-01", modified: "2026-01-10T12:00:00Z" },
    ]);

    vi.mocked(getVectorStore).mockReturnValue({
      getIndexMetadata: vi.fn().mockResolvedValue([
        { id: "1", title: "Note 1", folder: "Work", indexed_at: "2020-01-01T00:00:00Z" },
      ]),
    } as any);

    vi.mocked(incrementalIndex).mockImplementation(
      () => new Promise(() => {
        // Intentionally never resolves
      })
    );

    const { refreshIfNeeded } = await import("./refresh.js");
    const pending = refreshIfNeeded();

    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toBe(false);
  });

  it("coalesces concurrent refresh calls into a single run", async () => {
    process.env.INDEX_TTL = "1";

    const { incrementalIndex } = await import("./indexer.js");
    const { getAllNotes } = await import("../notes/read.js");
    const { getVectorStore } = await import("../db/lancedb.js");

    vi.mocked(getAllNotes).mockResolvedValue([
      { title: "Note 1", folder: "Work", created: "2026-01-01", modified: "2026-01-10T12:00:00Z" },
    ]);

    vi.mocked(getVectorStore).mockReturnValue({
      getIndexMetadata: vi.fn().mockResolvedValue([
        { id: "1", title: "Note 1", folder: "Work", indexed_at: "2020-01-01T00:00:00Z" },
      ]),
    } as any);

    vi.mocked(incrementalIndex).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { total: 1, indexed: 1, errors: 0, timeMs: 100 };
    });

    const { refreshIfNeeded } = await import("./refresh.js");
    const [first, second] = await Promise.all([refreshIfNeeded(), refreshIfNeeded()]);

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(incrementalIndex).toHaveBeenCalledTimes(1);
  });
});
