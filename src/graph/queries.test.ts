// src/graph/queries.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { listTags, searchByTag, findRelatedNotes } from "./queries.js";

// Create a shared mock store object
const mockStore = {
  getAll: vi.fn(),
  search: vi.fn(),
};

// Mock the vector store module
vi.mock("../db/lancedb.js", () => ({
  getVectorStore: () => mockStore,
}));

describe("listTags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("aggregates tags with counts", async () => {
    mockStore.getAll.mockResolvedValue([
      { id: "1", title: "Note 1", tags: ["project", "idea"], outlinks: [] },
      { id: "2", title: "Note 2", tags: ["project", "todo"], outlinks: [] },
      { id: "3", title: "Note 3", tags: ["idea"], outlinks: [] },
    ]);

    const result = await listTags();

    expect(result).toEqual([
      { tag: "project", count: 2 },
      { tag: "idea", count: 2 },
      { tag: "todo", count: 1 },
    ]);
  });

  it("returns empty array when no tags", async () => {
    mockStore.getAll.mockResolvedValue([
      { id: "1", title: "Note 1", tags: [], outlinks: [] },
    ]);

    const result = await listTags();
    expect(result).toEqual([]);
  });
});

describe("searchByTag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("finds notes with specific tag", async () => {
    mockStore.getAll.mockResolvedValue([
      { id: "1", title: "Note 1", folder: "Work", tags: ["project"], content: "Content 1", modified: "2026-01-01" },
      { id: "2", title: "Note 2", folder: "Personal", tags: ["project", "idea"], content: "Content 2", modified: "2026-01-02" },
      { id: "3", title: "Note 3", folder: "Work", tags: ["todo"], content: "Content 3", modified: "2026-01-03" },
    ]);

    const result = await searchByTag("project");

    expect(result).toHaveLength(2);
    expect(result[0].title).toBe("Note 1");
    expect(result[1].title).toBe("Note 2");
  });

  it("filters by folder", async () => {
    mockStore.getAll.mockResolvedValue([
      { id: "1", title: "Note 1", folder: "Work", tags: ["project"], content: "...", modified: "2026-01-01" },
      { id: "2", title: "Note 2", folder: "Personal", tags: ["project"], content: "...", modified: "2026-01-02" },
    ]);

    const result = await searchByTag("project", { folder: "Work" });

    expect(result).toHaveLength(1);
    expect(result[0].folder).toBe("Work");
  });
});

describe("findRelatedNotes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("finds notes by shared tags", async () => {
    mockStore.getAll.mockResolvedValue([
      { id: "1", title: "Source", folder: "Work", tags: ["project", "idea"], outlinks: [], vector: [1,0,0] },
      { id: "2", title: "Related", folder: "Work", tags: ["project"], outlinks: [], vector: [0,1,0] },
      { id: "3", title: "Unrelated", folder: "Work", tags: ["todo"], outlinks: [], vector: [0,0,1] },
    ]);

    const result = await findRelatedNotes("1", { types: ["tag"] });

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Related");
    expect(result[0].relationship).toBe("tag");
  });

  it("finds notes by outlinks", async () => {
    mockStore.getAll.mockResolvedValue([
      { id: "1", title: "Source", folder: "Work", tags: [], outlinks: ["Target"], vector: [1,0,0] },
      { id: "2", title: "Target", folder: "Work", tags: [], outlinks: [], vector: [0,1,0] },
    ]);

    const result = await findRelatedNotes("1", { types: ["link"] });

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Target");
    expect(result[0].relationship).toBe("link");
    expect(result[0].direction).toBe("outgoing");
  });

  it("finds backlinks", async () => {
    mockStore.getAll.mockResolvedValue([
      { id: "1", title: "Target", folder: "Work", tags: [], outlinks: [], vector: [1,0,0] },
      { id: "2", title: "Source", folder: "Work", tags: [], outlinks: ["Target"], vector: [0,1,0] },
    ]);

    const result = await findRelatedNotes("1", { types: ["link"] });

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Source");
    expect(result[0].direction).toBe("incoming");
  });

  it("throws NoteNotFoundError for non-existent source note", async () => {
    mockStore.getAll.mockResolvedValue([]);
    await expect(findRelatedNotes("nonexistent-id")).rejects.toThrow("Note not found");
  });

  it("finds notes by semantic similarity", async () => {
    mockStore.getAll.mockResolvedValue([
      { id: "1", title: "Source", folder: "Work", tags: [], outlinks: [], vector: [1,0,0] },
    ]);
    mockStore.search.mockResolvedValue([
      { id: "2", title: "Similar", folder: "Work", content: "...", modified: "2026-01-01", score: 0.95 }
    ]);

    const result = await findRelatedNotes("1", { types: ["similar"] });
    expect(result).toHaveLength(1);
    expect(result[0].relationship).toBe("similar");
  });
});

describe("searchByTag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("searches tags case-insensitively", async () => {
    mockStore.getAll.mockResolvedValue([
      { id: "1", title: "Note", folder: "Work", tags: ["project"], content: "...", modified: "2026-01-01" },
    ]);
    const result = await searchByTag("PROJECT");
    expect(result).toHaveLength(1);
  });
});
