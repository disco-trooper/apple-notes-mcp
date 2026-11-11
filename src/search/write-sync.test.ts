import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./indexer.js", () => ({
  syncNotesById: vi.fn(),
  removeNotesFromIndex: vi.fn(),
}));

import {
  QUEUED_SYNC_WARNING,
  syncAfterBatchDelete,
  syncAfterCreate,
  syncAfterNoteChange,
  syncAfterUpdate,
} from "./write-sync.js";
import { removeNotesFromIndex, syncNotesById } from "./indexer.js";
import { withIndexLock } from "../indexing/lock.js";

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

  it("queues the sync behind a running index job instead of waiting for it", async () => {
    const synced: string[][] = [];
    vi.mocked(syncNotesById).mockImplementation((ids) =>
      withIndexLock(async () => {
        synced.push(ids);
        return [];
      })
    );
    let release!: () => void;
    const job = withIndexLock(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );

    const result = await syncAfterNoteChange("note-1");

    expect(result).toEqual({ ok: true, warnings: [QUEUED_SYNC_WARNING] });
    expect(synced).toEqual([]);

    release();
    await job;
    await withIndexLock(async () => undefined);
    expect(synced).toEqual([["note-1"]]);
  });

  it("never leaves a queued sync failure unobserved", async () => {
    vi.mocked(removeNotesFromIndex).mockImplementation(() =>
      withIndexLock(async () => {
        throw new Error("table locked");
      })
    );
    let release!: () => void;
    const job = withIndexLock(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    const result = await syncAfterBatchDelete(["a"]);
    release();
    await job;
    await withIndexLock(async () => undefined).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off("unhandledRejection", unhandled);

    expect(result.warnings).toEqual([QUEUED_SYNC_WARNING]);
    expect(removeNotesFromIndex).toHaveBeenCalledWith(["a"]);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
