import { beforeEach, describe, expect, it, vi } from "vitest";

const mockVectorStore = {
  deleteByFolderAndTitle: vi.fn(),
  deleteByIdAndFolderAndTitle: vi.fn(),
};

const mockChunkStore = {
  deleteChunksByNoteIds: vi.fn(),
};

vi.mock("../db/lancedb.js", () => ({
  getVectorStore: vi.fn(() => mockVectorStore),
  getChunkStore: vi.fn(() => mockChunkStore),
}));

vi.mock("./indexer.js", () => ({
  reindexNote: vi.fn(),
}));

vi.mock("./chunk-indexer.js", () => ({
  hasChunkIndex: vi.fn().mockResolvedValue(true),
  updateChunksForNotes: vi.fn(),
}));

vi.mock("../notes/read.js", () => ({
  getNoteById: vi.fn().mockResolvedValue({
    id: "note-1",
    title: "A",
    folder: "Work",
    content: "Content",
    htmlContent: "<p>Content</p>",
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
  }),
}));

vi.mock("../utils/debug.js", () => ({
  createDebugLogger: vi.fn(() => vi.fn()),
}));

describe("write-sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("syncAfterCreate reindexes vector and chunks by note id", async () => {
    const { syncAfterCreate } = await import("./write-sync.js");
    const { reindexNote } = await import("./indexer.js");
    const { updateChunksForNotes } = await import("./chunk-indexer.js");

    const result = await syncAfterCreate({
      id: "note-1",
      title: "A",
      folder: "Work",
      requestedTitle: "A",
      titleChanged: false,
    });

    expect(reindexNote).toHaveBeenCalledWith("id:note-1");
    expect(updateChunksForNotes).toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("syncAfterDelete removes vector and chunk records", async () => {
    const { syncAfterDelete } = await import("./write-sync.js");

    const result = await syncAfterDelete({
      id: "note-1",
      title: "A",
      folder: "Work",
    });

    expect(mockVectorStore.deleteByIdAndFolderAndTitle).toHaveBeenCalledWith("note-1", "Work", "A");
    expect(mockChunkStore.deleteChunksByNoteIds).toHaveBeenCalledWith(["note-1"]);
    expect(result.ok).toBe(true);
  });

  it("syncAfterMove deletes old folder/title and reindexes by id", async () => {
    const { syncAfterMove } = await import("./write-sync.js");
    const { reindexNote } = await import("./indexer.js");

    const result = await syncAfterMove({
      id: "note-1",
      title: "A",
      fromFolder: "Work",
      toFolder: "Archive",
    });

    expect(mockVectorStore.deleteByIdAndFolderAndTitle).toHaveBeenCalledWith("note-1", "Work", "A");
    expect(reindexNote).toHaveBeenCalledWith("id:note-1");
    expect(result.ok).toBe(true);
  });

  it("syncAfterUpdate deletes stale title entry when renamed", async () => {
    const { syncAfterUpdate } = await import("./write-sync.js");
    const { reindexNote } = await import("./indexer.js");

    const result = await syncAfterUpdate({
      id: "note-1",
      originalTitle: "Old A",
      newTitle: "New A",
      folder: "Work",
      titleChanged: true,
    });

    expect(mockVectorStore.deleteByIdAndFolderAndTitle).toHaveBeenCalledWith("note-1", "Work", "Old A");
    expect(reindexNote).toHaveBeenCalledWith("id:note-1");
    expect(result.ok).toBe(true);
  });

  it("reindexes before stale cleanup on move", async () => {
    const { syncAfterMove } = await import("./write-sync.js");
    const { reindexNote } = await import("./indexer.js");

    const order: string[] = [];
    vi.mocked(reindexNote).mockImplementation(async () => {
      order.push("reindex");
    });
    mockVectorStore.deleteByIdAndFolderAndTitle.mockImplementation(async () => {
      order.push("cleanup");
    });

    await syncAfterMove({
      id: "note-1",
      title: "A",
      fromFolder: "Work",
      toFolder: "Archive",
    });

    expect(order).toEqual(["reindex", "cleanup"]);
  });
});
