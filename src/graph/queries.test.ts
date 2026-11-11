// src/graph/queries.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { listTags, searchByTag, findRelatedNotes } from "./queries.js";

const mockStore = {
  getAllMetadata: vi.fn(),
  getById: vi.fn(),
  search: vi.fn(),
};

vi.mock("../db/lancedb.js", () => ({
  getVectorStore: () => mockStore,
}));

type Row = { id: string; title: string; folder?: string; tags?: string[]; outlinks?: string[]; vector?: number[] };

/** Serve the same rows through getAllMetadata (without vectors) and getById. */
function useRows(rows: Row[]): void {
  const full = rows.map((r) => ({ folder: "Work", tags: [], outlinks: [], content: "", modified: "2026-01-01", ...r }));
  mockStore.getAllMetadata.mockResolvedValue(full.map(({ vector: _vector, ...rest }) => rest));
  mockStore.getById.mockImplementation(async (id: string) => full.find((r) => r.id === id) ?? null);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listTags", () => {
  it("aggregates tags with counts, most frequent first", async () => {
    useRows([
      { id: "1", title: "Note 1", tags: ["project", "idea"] },
      { id: "2", title: "Note 2", tags: ["project", "todo"] },
      { id: "3", title: "Note 3", tags: ["idea"] },
    ]);

    expect(await listTags()).toEqual([
      { tag: "project", count: 2 },
      { tag: "idea", count: 2 },
      { tag: "todo", count: 1 },
    ]);
  });
});

describe("searchByTag", () => {
  beforeEach(() => {
    useRows([
      { id: "1", title: "Note 1", folder: "Work", tags: ["project"] },
      { id: "2", title: "Note 2", folder: "Personal", tags: ["project", "idea"] },
      { id: "3", title: "Note 3", folder: "Work", tags: ["todo"] },
    ]);
  });

  it("finds notes with specific tag", async () => {
    const result = await searchByTag("project");
    expect(result.map((r) => r.title)).toEqual(["Note 1", "Note 2"]);
  });

  it("filters by folder", async () => {
    const result = await searchByTag("project", { folder: "Work" });
    expect(result.map((r) => r.title)).toEqual(["Note 1"]);
  });

  it("matches case-insensitively and accepts a leading #", async () => {
    expect(await searchByTag("PROJECT")).toHaveLength(2);
    expect(await searchByTag("#project")).toHaveLength(2);
  });
});

describe("findRelatedNotes", () => {
  it("finds notes by shared tags", async () => {
    useRows([
      { id: "1", title: "Source", tags: ["project", "idea"] },
      { id: "2", title: "Related", tags: ["project"] },
      { id: "3", title: "Unrelated", tags: ["todo"] },
    ]);

    const result = await findRelatedNotes("1", { types: ["tag"] });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ title: "Related", relationship: "tag", sharedTags: ["project"] });
  });

  it("resolves outlinks by title case-insensitively", async () => {
    useRows([
      { id: "1", title: "Source", outlinks: ["target"] },
      { id: "2", title: "Target" },
    ]);

    const result = await findRelatedNotes("1", { types: ["link"] });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ title: "Target", relationship: "link", direction: "outgoing" });
  });

  it("finds backlinks", async () => {
    useRows([
      { id: "1", title: "Target" },
      { id: "2", title: "Source", outlinks: ["Target"] },
    ]);

    const result = await findRelatedNotes("1", { types: ["link"] });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ title: "Source", direction: "incoming" });
  });

  it("resolves # in titles before falling back to heading anchors", async () => {
    useRows([
      { id: "1", title: "Source", outlinks: ["C# cheatsheet", "Note#h"] },
      { id: "2", title: "C# cheatsheet" },
      { id: "3", title: "C" },
      { id: "4", title: "Note" },
    ]);

    const result = await findRelatedNotes("1", { types: ["link"] });

    expect(result.map((r) => [r.title, r.direction])).toEqual([
      ["C# cheatsheet", "outgoing"],
      ["Note", "outgoing"],
    ]);
  });

  it("counts [[Target#heading]] as a backlink", async () => {
    useRows([
      { id: "1", title: "Target" },
      { id: "2", title: "Source", outlinks: ["Target#section"] },
    ]);

    const result = await findRelatedNotes("1", { types: ["link"] });

    expect(result).toEqual([expect.objectContaining({ title: "Source", direction: "incoming" })]);
  });

  it("does not return the source note when it links to itself", async () => {
    useRows([{ id: "1", title: "Self", outlinks: ["Self"] }]);
    expect(await findRelatedNotes("1", { types: ["link"] })).toEqual([]);
  });

  it("throws NoteNotFoundError for non-existent source note", async () => {
    useRows([]);
    await expect(findRelatedNotes("nonexistent-id")).rejects.toThrow("Note not found");
  });

  it("finds notes by semantic similarity using the source vector", async () => {
    useRows([{ id: "1", title: "Source", vector: [1, 0, 0] }]);
    mockStore.search.mockResolvedValue([
      { id: "1", title: "Source", folder: "Work", content: "", modified: "2026-01-01", score: 1 },
      { id: "2", title: "Similar", folder: "Work", content: "", modified: "2026-01-01", score: 0.95 },
    ]);

    const result = await findRelatedNotes("1", { types: ["similar"] });

    expect(mockStore.search).toHaveBeenCalledWith([1, 0, 0], expect.any(Number));
    expect(mockStore.getAllMetadata).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "2", relationship: "similar" });
  });
});
