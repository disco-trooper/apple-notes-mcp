import { getVectorStore, getChunkStore } from "../db/lancedb.js";
import { getNoteById } from "../notes/read.js";
import {
  hasChunkIndex,
  updateChunksForNotes,
} from "./chunk-indexer.js";
import { reindexNote } from "./indexer.js";
import type {
  CreateResult,
  DeleteResult,
  MoveResult,
  UpdateResult,
} from "../notes/crud.js";
import { createDebugLogger } from "../utils/debug.js";

const debug = createDebugLogger("WRITE-SYNC");

export interface WriteSyncResult {
  ok: boolean;
  warnings: string[];
}

async function trySync(action: string, operation: () => Promise<void>): Promise<string | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug(`Write sync step failed (${action}):`, error);
    return `${action}: ${message}`;
  }
}

async function syncChunksForNoteId(noteId: string): Promise<string | null> {
  try {
    const hasChunks = await hasChunkIndex();
    if (!hasChunks) {
      return null;
    }

    const note = await getNoteById(noteId);
    if (!note) {
      return `chunk-sync: note not found for id ${noteId}`;
    }

    await updateChunksForNotes([note]);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `chunk-sync: ${message}`;
  }
}

function toResult(warnings: Array<string | null>): WriteSyncResult {
  const filtered = warnings.filter((w): w is string => w !== null);
  return {
    ok: filtered.length === 0,
    warnings: filtered,
  };
}

export async function syncAfterCreate(createResult: CreateResult): Promise<WriteSyncResult> {
  const warnings: Array<string | null> = [];

  warnings.push(
    await trySync("vector-reindex", async () => {
      await reindexNote(`id:${createResult.id}`);
    })
  );

  warnings.push(await syncChunksForNoteId(createResult.id));

  return toResult(warnings);
}

export async function syncAfterUpdate(updateResult: UpdateResult): Promise<WriteSyncResult> {
  const warnings: Array<string | null> = [];

  const reindexWarning = await trySync("vector-reindex", async () => {
    await reindexNote(`id:${updateResult.id}`);
  });
  warnings.push(reindexWarning);

  // If title changed, remove stale vector entries only after successful reindex.
  if (updateResult.titleChanged && reindexWarning === null) {
    warnings.push(
      await trySync("vector-delete-old-title", async () => {
        const store = getVectorStore();
        await store.deleteByIdAndFolderAndTitle(
          updateResult.id,
          updateResult.folder,
          updateResult.originalTitle
        );
      })
    );
  }

  warnings.push(await syncChunksForNoteId(updateResult.id));

  return toResult(warnings);
}

export async function syncAfterDelete(deleteResult: DeleteResult): Promise<WriteSyncResult> {
  const warnings: Array<string | null> = [];

  warnings.push(
    await trySync("vector-delete", async () => {
      const store = getVectorStore();
      await store.deleteByIdAndFolderAndTitle(
        deleteResult.id,
        deleteResult.folder,
        deleteResult.title
      );
    })
  );

  warnings.push(
    await trySync("chunk-delete", async () => {
      const hasChunks = await hasChunkIndex();
      if (!hasChunks) {
        return;
      }
      const chunkStore = getChunkStore();
      await chunkStore.deleteChunksByNoteIds([deleteResult.id]);
    })
  );

  return toResult(warnings);
}

export async function syncAfterMove(moveResult: MoveResult): Promise<WriteSyncResult> {
  const warnings: Array<string | null> = [];

  const reindexWarning = await trySync("vector-reindex", async () => {
    await reindexNote(`id:${moveResult.id}`);
  });
  warnings.push(reindexWarning);

  if (reindexWarning === null) {
    warnings.push(
      await trySync("vector-delete-old-folder", async () => {
        const store = getVectorStore();
        await store.deleteByIdAndFolderAndTitle(
          moveResult.id,
          moveResult.fromFolder,
          moveResult.title
        );
      })
    );
  }

  warnings.push(await syncChunksForNoteId(moveResult.id));

  return toResult(warnings);
}
