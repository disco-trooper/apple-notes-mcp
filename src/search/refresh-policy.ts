/**
 * Refresh policy helpers for search-time auto-refresh.
 */

/**
 * Parse INDEX_TTL (seconds). Returns null when unset or not a positive integer,
 * which disables auto-refresh.
 */
export function parseIndexTtlSeconds(raw: string | undefined): number | null {
  if (!raw) {
    return null;
  }
  const ttlSeconds = Number.parseInt(raw, 10);
  return Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : null;
}

/**
 * Decide whether auto-refresh should run.
 *
 * - No index baseline (lastRefreshMs null) => skip: auto-refresh only keeps an
 *   existing index fresh; building one from scratch is left to index-notes
 * - Otherwise run only when the TTL has expired
 */
export function shouldAutoRefreshByTtl(
  ttlSeconds: number,
  nowMs: number,
  lastRefreshMs: number | null
): boolean {
  if (lastRefreshMs === null) {
    return false;
  }
  return nowMs - lastRefreshMs >= ttlSeconds * 1000;
}
