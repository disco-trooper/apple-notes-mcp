import { describe, it, expect, vi } from "vitest";
import { createIndexJobManager } from "./job-manager.js";
import { IndexCancelledError } from "./contracts.js";

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("job-manager", () => {
  it("starts a job and returns completed status", async () => {
    const manager = createIndexJobManager({
      indexNotes: vi.fn().mockImplementation(async (_mode, options) => {
        options?.onProgress?.({
          stage: "fetch",
          current: 1,
          total: 1,
          message: "Fetched",
        });
        return {
          total: 1,
          indexed: 1,
          errors: 0,
          timeMs: 50,
        };
      }),
      fullChunkIndex: vi.fn().mockResolvedValue({
        totalNotes: 1,
        totalChunks: 2,
        indexed: 2,
        timeMs: 30,
      }),
      now: () => Date.now(),
      newId: () => "job-1",
    });

    const job = manager.start({ mode: "incremental" });
    const initial = manager.get(job.id);
    expect(initial?.status).toBe("queued");

    await flushPromises();

    const final = manager.get(job.id);
    expect(final?.status).toBe("completed");
    expect(final?.progress.percent).toBe(100);
  });

  it("deduplicates concurrent full jobs", async () => {
    const unresolved = new Promise(() => {
      // intentionally unresolved for dedupe check
    });

    const manager = createIndexJobManager({
      indexNotes: vi.fn().mockReturnValue(unresolved),
      fullChunkIndex: vi.fn().mockResolvedValue({
        totalNotes: 1,
        totalChunks: 1,
        indexed: 1,
        timeMs: 1,
      }),
      now: () => Date.now(),
      newId: () => crypto.randomUUID(),
    });

    const first = manager.start({ mode: "full" });
    const second = manager.start({ mode: "full" });
    expect(first.id).toBe(second.id);
  });

  it("deduplicates active jobs across modes", async () => {
    const unresolved = new Promise(() => {
      // keep running
    });

    const manager = createIndexJobManager({
      indexNotes: vi.fn().mockReturnValue(unresolved),
      fullChunkIndex: vi.fn(),
      now: () => Date.now(),
      newId: () => crypto.randomUUID(),
    });

    const full = manager.start({ mode: "full" });
    const incremental = manager.start({ mode: "incremental" });

    expect(incremental.id).toBe(full.id);
  });

  it("tracks failed job state and error message", async () => {
    const manager = createIndexJobManager({
      indexNotes: vi.fn().mockRejectedValue(new Error("boom")),
      fullChunkIndex: vi.fn(),
      now: () => Date.now(),
      newId: () => "job-fail",
    });

    const job = manager.start({ mode: "incremental" });
    await flushPromises();

    const final = manager.get(job.id);
    expect(final?.status).toBe("failed");
    expect(final?.error).toBeTruthy();
  });

  it("updates running progress beyond initial 10 percent", async () => {
    const manager = createIndexJobManager({
      indexNotes: vi.fn().mockImplementation((_mode, options) => {
        options?.onProgress?.({
          stage: "embed",
          current: 1,
          total: 2,
          message: "Embedded batch 1/2",
        });

        return new Promise(() => {
          // keep running so we can inspect intermediate progress
        });
      }),
      fullChunkIndex: vi.fn(),
      now: () => Date.now(),
      newId: () => "job-progress",
    });

    const job = manager.start({ mode: "incremental" });
    await flushPromises();

    const running = manager.get(job.id);
    expect(running?.status).toBe("running");
    expect((running?.progress.percent ?? 0)).toBeGreaterThan(10);
  });

  it("marks job as cancelled when cancel is requested", async () => {
    const manager = createIndexJobManager({
      indexNotes: vi.fn().mockImplementation((_mode, options) => {
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(new IndexCancelledError("cancelled"));
          });
        });
      }),
      fullChunkIndex: vi.fn(),
      now: () => Date.now(),
      newId: () => "job-cancel",
    });

    const started = manager.start({ mode: "incremental" });
    await flushPromises();

    const cancelling = manager.cancel(started.id);
    expect(cancelling?.status).toBe("cancelling");

    await flushPromises();
    const cancelled = manager.get(started.id);
    expect(cancelled?.status).toBe("cancelled");
  });

  it("returns null when cancelling unknown job", async () => {
    const manager = createIndexJobManager();
    expect(manager.cancel("missing")).toBeNull();
  });

  it("does not start a queued job after cancel", async () => {
    const indexNotes = vi.fn().mockResolvedValue({
      total: 0,
      indexed: 0,
      errors: 0,
      timeMs: 1,
    });

    const manager = createIndexJobManager({
      indexNotes,
      fullChunkIndex: vi.fn(),
      now: () => Date.now(),
      newId: () => "q1",
    });

    const started = manager.start({ mode: "incremental" });
    const cancelled = manager.cancel(started.id);
    expect(cancelled?.status).toBe("cancelled");

    await flushPromises();

    expect(indexNotes).not.toHaveBeenCalled();
    expect(manager.get(started.id)?.status).toBe("cancelled");
  });
});
