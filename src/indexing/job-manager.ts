import {
  DEFAULT_INDEX_JOB_RETENTION_SECONDS,
  MAX_INDEX_JOB_HISTORY,
} from "../config/constants.js";
import { indexNotes, type IndexResult } from "../search/indexer.js";
import { fullChunkIndex, type ChunkIndexResult } from "../search/chunk-indexer.js";
import {
  type IndexProgressEvent,
  type IndexRunOptions,
  isIndexCancelledError,
} from "./contracts.js";
import { sanitizeErrorMessage } from "../utils/errors.js";
import { createDebugLogger } from "../utils/debug.js";

const debug = createDebugLogger("INDEX-JOBS");

export type IndexJobStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

export interface IndexJobProgress {
  phase: string;
  percent: number;
  message: string;
}

export interface IndexJob {
  id: string;
  mode: "full" | "incremental";
  status: IndexJobStatus;
  progress: IndexJobProgress;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: IndexResult;
  chunkResult?: ChunkIndexResult;
  error?: string;
}

export interface StartIndexJobOptions {
  mode: "full" | "incremental";
}

interface IndexJobManagerDeps {
  indexNotes: (mode: "full" | "incremental", options?: IndexRunOptions) => Promise<IndexResult>;
  fullChunkIndex: (options?: IndexRunOptions) => Promise<ChunkIndexResult>;
  now: () => number;
  newId: () => string;
}

export interface IndexJobManager {
  start: (options: StartIndexJobOptions) => IndexJob;
  get: (jobId: string) => IndexJob | null;
  list: (limit?: number) => IndexJob[];
  cancel: (jobId: string) => IndexJob | null;
}

function cloneJob(job: IndexJob): IndexJob {
  return {
    ...job,
    progress: { ...job.progress },
  };
}

function getRetentionSeconds(): number {
  const raw = process.env.INDEX_JOB_RETENTION_SECONDS;
  if (!raw) return DEFAULT_INDEX_JOB_RETENTION_SECONDS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_INDEX_JOB_RETENTION_SECONDS;
  }
  return parsed;
}

function clampPercent(percent: number): number {
  return Math.max(0, Math.min(100, Math.round(percent)));
}

function ratio(current: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(1, current / total));
}

function mapProgressForIncremental(event: IndexProgressEvent): number {
  switch (event.stage) {
    case "fetch":
      return 5 + ratio(event.current, event.total) * 15;
    case "prepare":
      return 20 + ratio(event.current, event.total) * 10;
    case "embed":
      return 30 + ratio(event.current, event.total) * 35;
    case "persist":
      return 65 + ratio(event.current, event.total) * 25;
    case "delete":
      return 75 + ratio(event.current, event.total) * 10;
    case "rebuild-fts":
      return 90 + ratio(event.current, event.total) * 9;
    case "done":
      return 99;
    default:
      return 10;
  }
}

function mapProgressForFullNotes(event: IndexProgressEvent): number {
  switch (event.stage) {
    case "fetch":
      return 5 + ratio(event.current, event.total) * 15;
    case "prepare":
      return 20 + ratio(event.current, event.total) * 10;
    case "embed":
      return 30 + ratio(event.current, event.total) * 20;
    case "persist":
      return 50 + ratio(event.current, event.total) * 15;
    case "rebuild-fts":
      return 65 + ratio(event.current, event.total) * 5;
    case "done":
      return 70;
    default:
      return 10;
  }
}

function mapProgressForFullChunks(event: IndexProgressEvent): number {
  switch (event.stage) {
    case "fetch":
      return 70 + ratio(event.current, event.total) * 5;
    case "prepare":
      return 75 + ratio(event.current, event.total) * 5;
    case "embed":
      return 80 + ratio(event.current, event.total) * 10;
    case "persist":
      return 90 + ratio(event.current, event.total) * 5;
    case "done":
      return 95;
    default:
      return 75;
  }
}

export function createIndexJobManager(
  deps: Partial<IndexJobManagerDeps> = {}
): IndexJobManager {
  const resolvedDeps: IndexJobManagerDeps = {
    indexNotes,
    fullChunkIndex,
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
    ...deps,
  };

  const jobs = new Map<string, IndexJob>();
  const order: string[] = [];
  const controllers = new Map<string, AbortController>();

  function prune(): void {
    const retentionMs = getRetentionSeconds() * 1000;
    const now = resolvedDeps.now();

    for (const jobId of [...order]) {
      const job = jobs.get(jobId);
      if (!job) continue;

      if (
        (job.status === "completed" || job.status === "failed" || job.status === "cancelled") &&
        job.finishedAt
      ) {
        const ageMs = now - Date.parse(job.finishedAt);
        if (ageMs > retentionMs) {
          jobs.delete(jobId);
          controllers.delete(jobId);
        }
      }
    }

    const alive = order.filter((id) => jobs.has(id));
    order.length = 0;
    order.push(...alive);

    while (order.length > MAX_INDEX_JOB_HISTORY) {
      const oldest = order.shift();
      if (oldest) {
        jobs.delete(oldest);
        controllers.delete(oldest);
      }
    }
  }

  function getActiveJob(): IndexJob | null {
    for (let i = order.length - 1; i >= 0; i -= 1) {
      const job = jobs.get(order[i]);
      if (!job) continue;
      if (
        (job.status === "queued" || job.status === "running" || job.status === "cancelling")
      ) {
        return job;
      }
    }
    return null;
  }

  function setProgress(job: IndexJob, phase: string, percent: number, message: string): void {
    job.progress = {
      phase,
      percent: clampPercent(percent),
      message,
    };
  }

  function noteProgressHandler(job: IndexJob) {
    return (event: IndexProgressEvent): void => {
      if (job.status === "cancelling") {
        return;
      }
      const percent =
        job.mode === "incremental"
          ? mapProgressForIncremental(event)
          : mapProgressForFullNotes(event);
      setProgress(job, `indexing-notes/${event.stage}`, percent, event.message);
    };
  }

  function chunkProgressHandler(job: IndexJob) {
    return (event: IndexProgressEvent): void => {
      if (job.status === "cancelling") {
        return;
      }
      const percent = mapProgressForFullChunks(event);
      setProgress(job, `indexing-chunks/${event.stage}`, percent, event.message);
    };
  }

  async function run(jobId: string): Promise<void> {
    const job = jobs.get(jobId);
    if (!job) return;

    if (job.status === "cancelled") {
      return;
    }

    const controller = new AbortController();
    controllers.set(jobId, controller);

    try {
      job.status = "running";
      job.startedAt = new Date(resolvedDeps.now()).toISOString();
      setProgress(job, "indexing-notes", 5, `Running ${job.mode} index`);

      const result = await resolvedDeps.indexNotes(job.mode, {
        signal: controller.signal,
        onProgress: noteProgressHandler(job),
      });
      job.result = result;

      if (job.mode === "full") {
        setProgress(job, "indexing-chunks", 70, "Building chunk index");
        const chunkResult = await resolvedDeps.fullChunkIndex({
          signal: controller.signal,
          onProgress: chunkProgressHandler(job),
        });
        job.chunkResult = chunkResult;
      }

      job.status = "completed";
      job.finishedAt = new Date(resolvedDeps.now()).toISOString();
      setProgress(job, "completed", 100, "Index job completed");
    } catch (error) {
      const cancelled = controller.signal.aborted || isIndexCancelledError(error);
      if (cancelled) {
        job.status = "cancelled";
        job.finishedAt = new Date(resolvedDeps.now()).toISOString();
        setProgress(job, "cancelled", 100, "Index job cancelled");
      } else {
        job.status = "failed";
        job.finishedAt = new Date(resolvedDeps.now()).toISOString();
        job.error = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
        setProgress(job, "failed", 100, "Index job failed");
        debug("Background index job failed:", error);
      }
    } finally {
      controllers.delete(jobId);
      prune();
    }
  }

  function start(options: StartIndexJobOptions): IndexJob {
    prune();

    const existing = getActiveJob();
    if (existing) {
      return cloneJob(existing);
    }

    const id = resolvedDeps.newId();
    const job: IndexJob = {
      id,
      mode: options.mode,
      status: "queued",
      progress: {
        phase: "queued",
        percent: 0,
        message: "Job queued",
      },
      createdAt: new Date(resolvedDeps.now()).toISOString(),
    };

    jobs.set(id, job);
    order.push(id);

    queueMicrotask(() => {
      void run(id);
    });

    return cloneJob(job);
  }

  function get(jobId: string): IndexJob | null {
    prune();
    const job = jobs.get(jobId);
    return job ? cloneJob(job) : null;
  }

  function list(limit = 10): IndexJob[] {
    prune();
    const boundedLimit = Math.max(1, Math.min(limit, 50));
    const ids = [...order].reverse().slice(0, boundedLimit);
    return ids
      .map((id) => jobs.get(id))
      .filter((job): job is IndexJob => job !== undefined)
      .map(cloneJob);
  }

  function cancel(jobId: string): IndexJob | null {
    prune();
    const job = jobs.get(jobId);
    if (!job) {
      return null;
    }

    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      return cloneJob(job);
    }

    if (job.status === "queued") {
      job.status = "cancelled";
      job.finishedAt = new Date(resolvedDeps.now()).toISOString();
      setProgress(job, "cancelled", 100, "Index job cancelled before start");
      return cloneJob(job);
    }

    job.status = "cancelling";
    setProgress(job, "cancelling", job.progress.percent, "Cancellation requested");
    controllers.get(jobId)?.abort();

    return cloneJob(job);
  }

  return {
    start,
    get,
    list,
    cancel,
  };
}

let defaultManager: IndexJobManager | null = null;

export function getIndexJobManager(): IndexJobManager {
  if (!defaultManager) {
    defaultManager = createIndexJobManager();
  }
  return defaultManager;
}
