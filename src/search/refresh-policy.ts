/**
 * Refresh policy helpers for search-time auto-refresh.
 */

/**
 * Decide whether auto-refresh should run based on TTL.
 *
 * Rules:
 * - No TTL configured => disabled
 * - Invalid/zero TTL => disabled
 * - Empty index (no indexed timestamp) => enabled
 * - Otherwise run only when TTL has expired
 */
export function shouldAutoRefreshByTtl(
  ttlSecondsRaw: string | undefined,
  nowMs: number,
  lastIndexedAtMs: number | null
): boolean {
  if (!ttlSecondsRaw) {
    return false;
  }

  const ttlSeconds = Number.parseInt(ttlSecondsRaw, 10);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return false;
  }

  if (lastIndexedAtMs === null) {
    return true;
  }

  return nowMs - lastIndexedAtMs >= ttlSeconds * 1000;
}
