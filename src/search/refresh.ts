/**
 * Search-time auto-refresh.
 *
 * When INDEX_TTL is set and has expired, runs an incremental indexNotes()
 * (which syncs both tables). Skipped while another index writer holds the
 * index lock. A search waits at most SEARCH_REFRESH_TIMEOUT_MS; a slower
 * refresh keeps running in the background under the lock.
 */

import { getVectorStore } from "../db/lancedb.js";
import { indexNotes } from "./indexer.js";
import { isIndexLocked } from "../indexing/lock.js";
import { createDebugLogger } from "../utils/debug.js";
import { DEFAULT_SEARCH_REFRESH_TIMEOUT_MS } from "../config/constants.js";
import { parseIndexTtlSeconds, shouldAutoRefreshByTtl } from "./refresh-policy.js";

const debug = createDebugLogger("REFRESH");

let refreshInFlight: Promise<boolean> | null = null;
/** When this process last started a refresh; avoids rescanning on every search. */
let lastRefreshAtMs: number | null = null;

async function getLatestIndexedAtMs(): Promise<number | null> {
  const metadata = await getVectorStore()
    .getIndexMetadata()
    .catch(() => null); // No index yet
  if (!metadata) {
    return null;
  }

  let latestMs: number | null = null;
  for (const record of metadata) {
    const indexedAtMs = Date.parse(record.indexed_at);
    if (!Number.isNaN(indexedAtMs) && (latestMs === null || indexedAtMs > latestMs)) {
      latestMs = indexedAtMs;
    }
  }
  return latestMs;
}

function getSearchRefreshTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.SEARCH_REFRESH_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SEARCH_REFRESH_TIMEOUT_MS;
}

/**
 * Resolve with the promise's value, or null after `timeoutMs`.
 * `promise` must not reject (callers attach their own catch).
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(null), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function runRefresh(ttlSeconds: number): Promise<boolean> {
  if (isIndexLocked()) {
    debug("Index writer active; skipping auto-refresh");
    return false;
  }

  const nowMs = Date.now();
  if (lastRefreshAtMs !== null && !shouldAutoRefreshByTtl(ttlSeconds, nowMs, lastRefreshAtMs)) {
    return false;
  }

  const latestIndexedAtMs = await getLatestIndexedAtMs();
  const lastMs =
    latestIndexedAtMs === null || lastRefreshAtMs === null
      ? (latestIndexedAtMs ?? lastRefreshAtMs)
      : Math.max(latestIndexedAtMs, lastRefreshAtMs);
  if (!shouldAutoRefreshByTtl(ttlSeconds, nowMs, lastMs)) {
    debug("Auto-refresh skipped by TTL policy");
    return false;
  }

  if (isIndexLocked()) {
    debug("Index writer active; skipping auto-refresh");
    return false;
  }

  lastRefreshAtMs = nowMs;
  debug("TTL expired, running incremental index...");
  const result = await indexNotes("incremental");
  debug(`Auto-refresh: ${result.indexed} notes written in ${result.timeMs}ms`);
  return result.indexed > 0 || (result.breakdown?.deleted ?? 0) > 0;
}

/**
 * Refresh the index when INDEX_TTL has expired.
 *
 * @returns true if the index changed, false otherwise (also on timeout or error)
 */
export async function refreshIfNeeded(): Promise<boolean> {
  const ttlSeconds = parseIndexTtlSeconds(process.env.INDEX_TTL);
  if (ttlSeconds === null) {
    debug("Auto-refresh disabled (INDEX_TTL not set or invalid)");
    return false;
  }

  if (!refreshInFlight) {
    const task: Promise<boolean> = runRefresh(ttlSeconds)
      .catch((error: unknown) => {
        debug("Auto-refresh failed; returning stale index results", error);
        return false;
      })
      .finally(() => {
        if (refreshInFlight === task) {
          refreshInFlight = null;
        }
      });
    refreshInFlight = task;
  }

  const timeoutMs = getSearchRefreshTimeoutMs();
  const refreshed = await withTimeout(refreshInFlight, timeoutMs);
  if (refreshed === null) {
    debug(`Auto-refresh still running after ${timeoutMs}ms; returning stale index results`);
    return false;
  }
  return refreshed;
}
