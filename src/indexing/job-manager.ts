import {
  DEFAULT_INDEX_JOB_RETENTION_SECONDS,
  MAX_INDEX_JOB_HISTORY,
} from "../config/constants.js";
import { indexNotes, type IndexResult } from "../search/indexer.js";
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
  error?: string;
}

export interface StartIndexJobOptions {
  mode: "full" | "incremental";
}

export interface StartIndexJobResult {
  job: IndexJob;
  /** True when an already active job was returned instead of starting a new one. */
  reused: boolean;
}

interface IndexJobManagerDeps {
  indexNotes: (mode: "full" | "incremental", options?: IndexRunOptions) => Promise<IndexResult>;
  now: () => number;
  newId: () => string;
}

export interface IndexJobManager {
  start: (options: StartIndexJobOptions) => StartIndexJobResult;
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

function ratio(current: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(1, current / total));
}

/** Map an indexer stage to an overall percentage (stages run in this order). */
function mapProgress(event: IndexProgressEvent): number {
  const r = ratio(event.current, event.total);
  switch (event.stage) {
    case "fetch":
      return 5 + r * 15;
    case "prepare":
      return 20 + r * 5;
    case "embed":
      return 25 + r * 55;
    case "persist":
      return 80 + r * 12;
    case "rebuild-fts":
      return 92 + r * 7;
    case "done":
      return 99;
  }
}

export function createIndexJobManager(
  deps: Partial<IndexJobManagerDeps> = {}
): IndexJobManager {
  const resolvedDeps: IndexJobManagerDeps = {
    indexNotes,
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
      if (job.status === "queued" || job.status === "running" || job.status === "cancelling") {
        return job;
      }
    }
    return null;
  }

  /** Running progress never moves backwards; terminal phases set their own value. */
  function setProgress(job: IndexJob, phase: string, percent: number, message: string): void {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    job.progress = {
      phase,
      percent: Math.max(job.progress.percent, clamped),
      message,
    };
  }

  function finish(
    job: IndexJob,
    status: "completed" | "failed" | "cancelled",
    message: string
  ): void {
    job.status = status;
    job.finishedAt = new Date(resolvedDeps.now()).toISOString();
    setProgress(job, status, 100, message);
  }

  async function run(jobId: string): Promise<void> {
    const job = jobs.get(jobId);
    if (!job || job.status === "cancelled") {
      return;
    }

    const controller = new AbortController();
    controllers.set(jobId, controller);

    try {
      job.status = "running";
      job.startedAt = new Date(resolvedDeps.now()).toISOString();
      setProgress(job, "indexing", 5, `Running ${job.mode} index`);

      job.result = await resolvedDeps.indexNotes(job.mode, {
        signal: controller.signal,
        onProgress: (event) => {
          if (job.status === "cancelling") return;
          setProgress(job, `indexing/${event.stage}`, mapProgress(event), event.message);
        },
      });

      if (controller.signal.aborted) {
        // The indexer passed its last cancellation point and wrote its changes.
        finish(job, "cancelled", "Index job cancelled after its changes were written");
      } else {
        finish(job, "completed", "Index job completed");
      }
    } catch (error) {
      if (controller.signal.aborted || isIndexCancelledError(error)) {
        finish(job, "cancelled", "Index job cancelled");
      } else {
        job.error = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
        finish(job, "failed", "Index job failed");
        debug("Background index job failed:", error);
      }
    } finally {
      controllers.delete(jobId);
      prune();
    }
  }

  function start(options: StartIndexJobOptions): StartIndexJobResult {
    prune();

    const existing = getActiveJob();
    if (existing) {
      return { job: cloneJob(existing), reused: true };
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

    return { job: cloneJob(job), reused: false };
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
      finish(job, "cancelled", "Index job cancelled before start");
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
