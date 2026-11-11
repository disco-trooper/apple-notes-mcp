/**
 * In-process index lock.
 *
 * Every writer of the LanceDB index (indexNotes, reindexNote, write-sync)
 * runs through withIndexLock so two writers never interleave on the same
 * tables. Callers queue in FIFO order (promise-chain mutex).
 */

let tail: Promise<void> = Promise.resolve();
let pending = 0;

/**
 * Run `fn` once every previously queued holder has settled.
 * The lock is released when `fn` settles, whether it resolves or rejects.
 */
export function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  pending += 1;
  const run = tail.then(fn);
  const release = (): void => {
    pending -= 1;
  };
  tail = run.then(release, release);
  return run;
}

/** True while any holder is running or queued. */
export function isIndexLocked(): boolean {
  return pending > 0;
}
