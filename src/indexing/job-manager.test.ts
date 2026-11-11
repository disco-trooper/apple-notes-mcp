import { describe, it, expect, vi } from "vitest";
import { createIndexJobManager } from "./job-manager.js";
import { IndexCancelledError } from "./contracts.js";
import type { IndexResult } from "../search/indexer.js";

const RESULT: IndexResult = { total: 1, indexed: 1, timeMs: 50 };

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => {
    // keep the job running
  });
}

describe("job-manager", () => {
  it("runs a queued job to completion", async () => {
    const manager = createIndexJobManager({
      indexNotes: vi.fn().mockResolvedValue(RESULT),
      newId: () => "job-1",
    });

    const { job, reused } = manager.start({ mode: "incremental" });
    expect(reused).toBe(false);
    expect(manager.get(job.id)?.status).toBe("queued");

    await flushPromises();

    const final = manager.get(job.id);
    expect(final?.status).toBe("completed");
    expect(final?.progress.percent).toBe(100);
    expect(final?.result).toEqual(RESULT);
  });

  it("returns the active job, flagged as reused, for any mode", () => {
    const manager = createIndexJobManager({
      indexNotes: vi.fn().mockReturnValue(never()),
    });

    const full = manager.start({ mode: "full" });
    const incremental = manager.start({ mode: "incremental" });

    expect(incremental.reused).toBe(true);
    expect(incremental.job.id).toBe(full.job.id);
    expect(incremental.job.mode).toBe("full");
  });

  it("tracks failed job state and error message", async () => {
    const manager = createIndexJobManager({
      indexNotes: vi.fn().mockRejectedValue(new Error("boom")),
      newId: () => "job-fail",
    });

    const { job } = manager.start({ mode: "incremental" });
    await flushPromises();

    const final = manager.get(job.id);
    expect(final?.status).toBe("failed");
    expect(final?.error).toBeTruthy();
  });

  it("never reports progress going backwards", async () => {
    let emit!: (stage: "persist" | "fetch", current: number, total: number) => void;
    const manager = createIndexJobManager({
      indexNotes: vi.fn().mockImplementation((_mode, options) => {
        emit = (stage, current, total) => options?.onProgress?.({ stage, current, total, message: stage });
        return never();
      }),
    });

    const { job } = manager.start({ mode: "incremental" });
    await flushPromises();

    emit("persist", 1, 2);
    const atPersist = manager.get(job.id)?.progress.percent ?? 0;
    expect(atPersist).toBeGreaterThan(80);

    emit("fetch", 1, 10);
    expect(manager.get(job.id)?.progress.percent).toBe(atPersist);
  });

  it("marks a job cancelled when the indexer stops on abort", async () => {
    const manager = createIndexJobManager({
      indexNotes: vi.fn().mockImplementation((_mode, options) => {
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(new IndexCancelledError("cancelled"));
          });
        });
      }),
    });

    const { job } = manager.start({ mode: "incremental" });
    await flushPromises();

    expect(manager.cancel(job.id)?.status).toBe("cancelling");

    await flushPromises();
    expect(manager.get(job.id)?.status).toBe("cancelled");
  });

  it("stays cancelled when the indexer finishes despite the abort", async () => {
    let finish!: () => void;
    const manager = createIndexJobManager({
      indexNotes: vi.fn().mockImplementation(
        () =>
          new Promise<IndexResult>((resolve) => {
            finish = () => resolve(RESULT);
          })
      ),
    });

    const { job } = manager.start({ mode: "full" });
    await flushPromises();
    manager.cancel(job.id);
    finish();
    await flushPromises();

    const final = manager.get(job.id);
    expect(final?.status).toBe("cancelled");
    expect(final?.progress.message).toContain("written");
    expect(final?.result).toEqual(RESULT);
  });

  it("returns null when cancelling unknown job", () => {
    const manager = createIndexJobManager();
    expect(manager.cancel("missing")).toBeNull();
  });

  it("does not start a queued job after cancel", async () => {
    const indexNotes = vi.fn().mockResolvedValue(RESULT);
    const manager = createIndexJobManager({ indexNotes });

    const { job } = manager.start({ mode: "incremental" });
    expect(manager.cancel(job.id)?.status).toBe("cancelled");

    await flushPromises();

    expect(indexNotes).not.toHaveBeenCalled();
    expect(manager.get(job.id)?.status).toBe("cancelled");
  });
});
