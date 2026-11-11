import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./indexer.js", () => ({
  syncNotesById: vi.fn(),
  removeNotesFromIndex: vi.fn(),
}));

import { syncAfterBatchDelete, syncAfterCreate, syncAfterUpdate } from "./write-sync.js";
import { removeNotesFromIndex, syncNotesById } from "./indexer.js";

describe("write-sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("re-syncs a renamed note by id, not by title", async () => {
    vi.mocked(syncNotesById).mockResolvedValue([]);

    const result = await syncAfterUpdate({
      id: "note-1",
      originalTitle: "Old A",
      newTitle: "New A",
      folder: "Work",
      titleChanged: true,
    });

    expect(syncNotesById).toHaveBeenCalledWith(["note-1"]);
    expect(result).toEqual({ ok: true, warnings: [] });
  });

  it("reports notes that vanished before they could be indexed", async () => {
    vi.mocked(syncNotesById).mockResolvedValue(["note-1"]);

    const result = await syncAfterCreate({
      id: "note-1",
      title: "A",
      folder: "Work",
      requestedTitle: "A",
      titleChanged: false,
    });

    expect(result.ok).toBe(false);
    expect(result.warnings[0]).toContain("note-1");
  });

  it("turns index failures into warnings instead of throwing", async () => {
    vi.mocked(removeNotesFromIndex).mockRejectedValue(new Error("table locked"));

    const result = await syncAfterBatchDelete(["a", "b"]);

    expect(removeNotesFromIndex).toHaveBeenCalledWith(["a", "b"]);
    expect(result).toEqual({ ok: false, warnings: ["index-delete: table locked"] });
  });
});
