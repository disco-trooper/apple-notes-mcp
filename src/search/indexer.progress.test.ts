import { beforeEach, describe, expect, it, vi } from "vitest";

const mockStore = {
  clear: vi.fn(),
  index: vi.fn(),
  addRecords: vi.fn(),
  rebuildFtsIndex: vi.fn(),
};

vi.mock("../db/lancedb.js", () => ({
  getVectorStore: vi.fn(() => mockStore),
}));

vi.mock("../notes/read.js", () => ({
  getAllNotesWithFallback: vi.fn().mockResolvedValue({
    notes: [
      {
        id: "n1",
        title: "Note 1",
        folder: "Work",
        content: "content",
        created: "2026-01-01T00:00:00.000Z",
        modified: "2026-01-01T00:00:00.000Z",
      },
    ],
    skipped: [],
  }),
  getNoteByTitle: vi.fn(),
}));

vi.mock("../embeddings/index.js", () => ({
  getEmbedding: vi.fn(),
  getEmbeddingBatch: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
}));

vi.mock("../config/constants.js", () => ({
  getEmbeddingBatchSize: vi.fn(() => 50),
}));

vi.mock("../graph/extract.js", () => ({
  extractMetadata: vi.fn(() => ({ tags: [], outlinks: [] })),
}));

vi.mock("../utils/text.js", () => ({
  truncateForEmbedding: vi.fn((content: string) => content),
}));

vi.mock("../utils/debug.js", () => ({
  createDebugLogger: vi.fn(() => vi.fn()),
}));

describe("indexer progress/cancel safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not call clear during full index", async () => {
    const { fullIndex } = await import("./indexer.js");

    await fullIndex();

    expect(mockStore.clear).not.toHaveBeenCalled();
    expect(mockStore.index).toHaveBeenCalledTimes(1);
  });

  it("throws cancellation before indexing when signal is already aborted", async () => {
    const { fullIndex } = await import("./indexer.js");
    const controller = new AbortController();
    controller.abort();

    await expect(fullIndex({ signal: controller.signal })).rejects.toThrow("Indexing cancelled");
    expect(mockStore.clear).not.toHaveBeenCalled();
    expect(mockStore.index).not.toHaveBeenCalled();
  });
});
