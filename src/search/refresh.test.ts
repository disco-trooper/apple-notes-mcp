import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IndexResult } from "./indexer.js";

vi.mock("../db/lancedb.js", () => ({
  getVectorStore: vi.fn(),
}));

vi.mock("./indexer.js", () => ({
  indexNotes: vi.fn(),
}));

const STALE = [{ id: "1", title: "Note 1", folder: "Work", modified: "2020-01-01T00:00:00Z", indexed_at: "2020-01-01T00:00:00Z" }];

function changed(indexed: number, deleted = 0): IndexResult {
  return {
    total: 1,
    indexed,
    timeMs: 1,
    breakdown: { added: 0, updated: indexed, deleted, skipped: 0 },
  };
}

/** refresh.ts and lock.ts keep module state; import fresh copies after vi.resetModules(). */
async function setup(metadata: unknown[] = STALE) {
  const { getVectorStore } = await import("../db/lancedb.js");
  const getIndexMetadata = vi.fn().mockResolvedValue(metadata);
  vi.mocked(getVectorStore).mockReturnValue({ getIndexMetadata } as never);
  const { indexNotes } = await import("./indexer.js");
  const lock = await import("../indexing/lock.js");
  const { refreshIfNeeded } = await import("./refresh.js");
  return { getIndexMetadata, indexNotes: vi.mocked(indexNotes), lock, refreshIfNeeded };
}

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

  it("does nothing when INDEX_TTL is not configured", async () => {
    const { getIndexMetadata, indexNotes, refreshIfNeeded } = await setup();

    expect(await refreshIfNeeded()).toBe(false);
    expect(indexNotes).not.toHaveBeenCalled();
    expect(getIndexMetadata).not.toHaveBeenCalled();
  });

  it("runs an incremental index when the TTL has expired", async () => {
    process.env.INDEX_TTL = "1";
    const { indexNotes, refreshIfNeeded } = await setup();
    indexNotes.mockResolvedValue(changed(0, 1));

    expect(await refreshIfNeeded()).toBe(true);
    expect(indexNotes).toHaveBeenCalledExactlyOnceWith("incremental");
  });

  it("reports false when the incremental run changed nothing", async () => {
    process.env.INDEX_TTL = "1";
    const { indexNotes, refreshIfNeeded } = await setup();
    indexNotes.mockResolvedValue(changed(0));

    expect(await refreshIfNeeded()).toBe(false);
  });

  it("skips when the TTL has not expired", async () => {
    process.env.INDEX_TTL = "86400";
    const fresh = [{ ...STALE[0], indexed_at: new Date().toISOString() }];
    const { indexNotes, refreshIfNeeded } = await setup(fresh);

    expect(await refreshIfNeeded()).toBe(false);
    expect(indexNotes).not.toHaveBeenCalled();
  });

  it("does not rescan the library again within the TTL after a refresh", async () => {
    process.env.INDEX_TTL = "86400";
    const { getIndexMetadata, indexNotes, refreshIfNeeded } = await setup();
    indexNotes.mockResolvedValue(changed(0));

    await refreshIfNeeded();
    await refreshIfNeeded();

    expect(indexNotes).toHaveBeenCalledTimes(1);
    expect(getIndexMetadata).toHaveBeenCalledTimes(1);
  });

  it("skips while another index writer holds the lock", async () => {
    process.env.INDEX_TTL = "1";
    const { indexNotes, lock, refreshIfNeeded } = await setup();
    let release!: () => void;
    const held = lock.withIndexLock(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );

    expect(await refreshIfNeeded()).toBe(false);
    expect(indexNotes).not.toHaveBeenCalled();

    release();
    await held;
  });

  it("returns false when the refresh fails", async () => {
    process.env.INDEX_TTL = "1";
    const { indexNotes, refreshIfNeeded } = await setup();
    indexNotes.mockRejectedValue(new Error("JXA failed"));

    expect(await refreshIfNeeded()).toBe(false);
  });

  it("returns false on timeout and swallows a later failure", async () => {
    vi.useFakeTimers();
    process.env.INDEX_TTL = "1";
    process.env.SEARCH_REFRESH_TIMEOUT_MS = "5";
    const { indexNotes, refreshIfNeeded } = await setup();
    let fail!: (error: Error) => void;
    indexNotes.mockReturnValue(
      new Promise<IndexResult>((_resolve, reject) => {
        fail = reject;
      })
    );

    const pending = refreshIfNeeded();
    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toBe(false);

    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    fail(new Error("late failure"));
    await vi.runAllTimersAsync();
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("coalesces concurrent calls into one run", async () => {
    process.env.INDEX_TTL = "1";
    const { indexNotes, refreshIfNeeded } = await setup();
    indexNotes.mockResolvedValue(changed(1));

    const [first, second] = await Promise.all([refreshIfNeeded(), refreshIfNeeded()]);

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(indexNotes).toHaveBeenCalledTimes(1);
  });
});
