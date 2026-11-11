/**
 * Keep both index tables in sync after MCP-initiated writes to Apple Notes.
 *
 * Every function re-reads notes by id (never by title) and runs its index
 * write under the index lock. Failures become warnings: the Apple Notes
 * write already succeeded, so the index is only stale until the next sync.
 *
 * While an index job holds the lock, the sync is queued behind it and the
 * call returns immediately with a warning instead of blocking the tool.
 */

import { syncNotesById, removeNotesFromIndex } from "./indexer.js";
import type {
  CreateResult,
  DeleteResult,
  MoveResult,
  UpdateResult,
} from "../notes/crud.js";
import { isIndexLocked } from "../indexing/lock.js";
import { createDebugLogger } from "../utils/debug.js";

const debug = createDebugLogger("WRITE-SYNC");

export interface WriteSyncResult {
  ok: boolean;
  warnings: string[];
}

export const QUEUED_SYNC_WARNING = "index update queued behind a running index job";

async function runSync(action: string, operation: () => Promise<string[]>): Promise<WriteSyncResult> {
  if (isIndexLocked()) {
    // runOperation never rejects (failures become warnings), so nothing goes unobserved.
    void runOperation(action, operation).then((result) => {
      if (result.warnings.length > 0) {
        debug(`Queued write sync finished with warnings (${action}):`, result.warnings);
      }
    });
    return { ok: true, warnings: [QUEUED_SYNC_WARNING] };
  }
  return runOperation(action, operation);
}

async function runOperation(
  action: string,
  operation: () => Promise<string[]>
): Promise<WriteSyncResult> {
  try {
    const warnings = await operation();
    return { ok: warnings.length === 0, warnings };
  } catch (error) {
    debug(`Write sync failed (${action}):`, error);
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, warnings: [`${action}: ${message}`] };
  }
}

function syncIds(ids: string[]): Promise<WriteSyncResult> {
  return runSync("index-sync", async () => {
    const missing = await syncNotesById(ids);
    return missing.map((id) => `index-sync: note ${id} not found; removed from index`);
  });
}

function removeIds(ids: string[]): Promise<WriteSyncResult> {
  return runSync("index-delete", async () => {
    await removeNotesFromIndex(ids);
    return [];
  });
}

export function syncAfterCreate(createResult: CreateResult): Promise<WriteSyncResult> {
  return syncIds([createResult.id]);
}

/** Rows are keyed by id, so a rename simply replaces the old row. */
export function syncAfterUpdate(updateResult: UpdateResult): Promise<WriteSyncResult> {
  return syncIds([updateResult.id]);
}

export function syncAfterDelete(deleteResult: DeleteResult): Promise<WriteSyncResult> {
  return removeIds([deleteResult.id]);
}

export function syncAfterMove(moveResult: MoveResult): Promise<WriteSyncResult> {
  return syncIds([moveResult.id]);
}

export function syncAfterBatchDelete(ids: string[]): Promise<WriteSyncResult> {
  return removeIds(ids);
}

export function syncAfterBatchMove(ids: string[]): Promise<WriteSyncResult> {
  return syncIds(ids);
}

/** Re-sync one note after an in-place change (e.g. edit-table). */
export function syncAfterNoteChange(id: string): Promise<WriteSyncResult> {
  return syncIds([id]);
}
