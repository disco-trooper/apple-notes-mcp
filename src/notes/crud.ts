/**
 * Apple Notes CRUD operations using JXA (JavaScript for Automation).
 *
 * All write operations respect READONLY_MODE. Content is converted from
 * Markdown to HTML before writing to Apple Notes. Every script runs through
 * the killable runner (timeout + stdin delivery) in ./jxa-runner.js.
 */

import { marked } from "marked";
import { executeJxa } from "./jxa-runner.js";
import { resolveNoteTitle, FOLDER_JXA_HELPERS } from "./resolve.js";
import { applyTableEdits } from "./tables.js";
import { createDebugLogger } from "../utils/debug.js";
import { getNotesFetchBatchSize } from "../config/constants.js";
import { envFlag } from "../config/env.js";
import { ReadOnlyModeError, NoteNotFoundError, DuplicateNoteError } from "../errors/index.js";

// Debug logging
const debug = createDebugLogger("CRUD");

/** Identity of a note touched by a write: enough to sync the search index. */
export interface NoteRef {
  id: string;
  title: string;
  folder: string;
}

/**
 * Check if READONLY_MODE is enabled and throw if so.
 * Call this at the start of every write operation.
 *
 * @throws ReadOnlyModeError if READONLY_MODE is enabled
 */
export function checkReadOnly(): void {
  if (envFlag("READONLY_MODE")) {
    throw new ReadOnlyModeError();
  }
}

/**
 * Resolve user input to exactly one note.
 *
 * @param title - Note title, "folder/title" or "id:xxx"
 * @throws DuplicateNoteError when several notes match
 * @throws NoteNotFoundError when nothing matches
 */
async function resolveNoteOrThrow(title: string): Promise<NoteRef> {
  const resolved = await resolveNoteTitle(title);

  if (!resolved.success || !resolved.note) {
    if (resolved.suggestions && resolved.suggestions.length > 0) {
      throw new DuplicateNoteError(title, resolved.suggestions);
    }
    throw new NoteNotFoundError(title);
  }

  return resolved.note;
}

/**
 * Convert Markdown content to HTML for Apple Notes.
 */
function markdownToHtml(markdown: string): string {
  return marked.parse(markdown, {
    async: false,
    gfm: true,
    breaks: true,
  }) as string;
}

/**
 * Body HTML for a new note. `app.Note({name})` already writes the title as
 * the note's first line, so a first content line repeating the title
 * (plain, as a Markdown ATX heading, or as a setext heading with its
 * `===`/`---` underline) is dropped to avoid a duplicate.
 */
function buildNewNoteHtml(title: string, content: string): string {
  const lines = content.split("\n");
  const first = lines.findIndex((line) => line.trim().length > 0);
  if (first === -1) {
    return markdownToHtml(content);
  }
  const firstLine = lines[first].trim();
  const isAtx = /^#{1,6}\s+/.test(firstLine);
  if (firstLine.replace(/^#{1,6}\s+/, "").trim() !== title.trim()) {
    return markdownToHtml(content);
  }
  let rest = first + 1;
  if (!isAtx && rest < lines.length && /^\s{0,3}(=+|-+)\s*$/.test(lines[rest])) {
    rest++;
  }
  return markdownToHtml(lines.slice(rest).join("\n").replace(/^\s*\n/, ""));
}

export interface CreateResult {
  id: string;
  title: string;
  folder: string;
  requestedTitle: string;
  titleChanged: boolean;
}

/**
 * Create a new note in Apple Notes. Duplicate titles are allowed (notes are
 * identified by id).
 *
 * @param title - Note title (Apple Notes writes it as the first line)
 * @param content - Note content (Markdown)
 * @param folder - Optional target folder: name, nested path or "Account/Folder"
 * (defaults to the default account's default folder)
 * @throws ReadOnlyModeError if READONLY_MODE is enabled
 * @throws Error if the folder is missing or its name matches several folders
 */
export async function createNote(
  title: string,
  content: string,
  folder?: string
): Promise<CreateResult> {
  checkReadOnly();

  debug(`Creating note: "${title}" in folder: "${folder || "<default>"}"`);

  const htmlContent = buildNewNoteHtml(title, content);
  debug(`HTML content length: ${htmlContent.length}`);

  const result = await executeJxa<string>(`
    const app = Application('Notes');
    const title = ${JSON.stringify(title)};
    const content = ${JSON.stringify(htmlContent)};
    const folderName = ${folder ? JSON.stringify(folder) : "null"};
    ${FOLDER_JXA_HELPERS}

    const targetFolder = folderName
      ? findFolder(folderName, 'Folder')
      : app.defaultAccount().defaultFolder();

    const note = app.Note({name: title, body: content});
    targetFolder.notes.push(note);

    return JSON.stringify({
      id: note.id(),
      title: note.name(),
      folder: targetFolder.name(),
    });
  `);

  const created = JSON.parse(result) as NoteRef;

  debug(`Note created: "${created.folder}/${created.title}"`);

  return {
    id: created.id,
    title: created.title,
    folder: created.folder,
    requestedTitle: title,
    titleChanged: created.title !== title,
  };
}

/**
 * Result of an update operation.
 * Apple Notes may rename the note based on content (first line).
 */
export interface UpdateResult {
  /** Note ID */
  id: string;
  /** Original title before update */
  originalTitle: string;
  /** Current title after update (may differ if Apple Notes renamed it) */
  newTitle: string;
  /** Folder containing the note */
  folder: string;
  /** Whether the title changed */
  titleChanged: boolean;
}

/**
 * Update an existing note's content.
 *
 * Apple Notes renames the note after the first line of the new content;
 * the returned UpdateResult carries the actual title after the update.
 *
 * @param title - Note title, "folder/title" or "id:xxx"
 * @param content - New content (Markdown)
 * @throws ReadOnlyModeError if READONLY_MODE is enabled
 * @throws NoteNotFoundError / DuplicateNoteError if the title doesn't resolve to one note
 */
export async function updateNote(title: string, content: string): Promise<UpdateResult> {
  checkReadOnly();

  debug(`Updating note: "${title}"`);

  const note = await resolveNoteOrThrow(title);
  const htmlContent = markdownToHtml(content);

  debug(`HTML content length: ${htmlContent.length}`);

  const result = await executeJxa<string>(`
    const app = Application('Notes');
    const note = app.notes.byId(${JSON.stringify(note.id)});
    if (!note.exists()) {
      throw new Error("Note no longer exists");
    }

    note.body = ${JSON.stringify(htmlContent)};

    return JSON.stringify({ newTitle: note.name() });
  `);

  const { newTitle } = JSON.parse(result) as { newTitle: string };
  const titleChanged = newTitle !== note.title;

  if (titleChanged) {
    debug(`Note renamed by Apple Notes: "${note.title}" -> "${newTitle}"`);
  } else {
    debug(`Note updated: "${title}"`);
  }

  return {
    id: note.id,
    originalTitle: note.title,
    newTitle,
    folder: note.folder,
    titleChanged,
  };
}

export type DeleteResult = NoteRef;

/**
 * Delete a note from Apple Notes.
 *
 * The caller must verify confirm=true before calling; this function does
 * not check it.
 *
 * @param title - Note title, "folder/title" or "id:xxx"
 * @throws ReadOnlyModeError if READONLY_MODE is enabled
 * @throws NoteNotFoundError / DuplicateNoteError if the title doesn't resolve to one note
 */
export async function deleteNote(title: string): Promise<DeleteResult> {
  checkReadOnly();

  debug(`Deleting note: "${title}"`);

  const note = await resolveNoteOrThrow(title);

  await executeJxa(`
    const app = Application('Notes');
    const note = app.notes.byId(${JSON.stringify(note.id)});
    if (!note.exists()) {
      throw new Error("Note no longer exists");
    }
    note.delete();
    return "ok";
  `);

  debug(`Note deleted: "${title}"`);

  return note;
}

export interface MoveResult {
  id: string;
  title: string;
  fromFolder: string;
  toFolder: string;
}

/**
 * Move one resolved note to the folder a JXA expression evaluates to.
 * `targetSetup` declares `targetFolder` (it may throw for a missing folder).
 */
async function moveResolvedNote(note: NoteRef, targetSetup: string): Promise<MoveResult> {
  const result = await executeJxa<string>(`
    const app = Application('Notes');
    ${FOLDER_JXA_HELPERS}

    ${targetSetup}
    const note = app.notes.byId(${JSON.stringify(note.id)});
    if (!note.exists()) {
      throw new Error("Note no longer exists");
    }

    note.move({to: targetFolder});

    return JSON.stringify({ toFolder: targetFolder.name() });
  `);

  const { toFolder } = JSON.parse(result) as { toFolder: string };

  return {
    id: note.id,
    title: note.title,
    fromFolder: note.folder,
    toFolder,
  };
}

/**
 * Move a note to a different folder.
 *
 * @param title - Note title, "folder/title" or "id:xxx"
 * @param folder - Target folder: name, nested path or "Account/Folder"
 * @throws ReadOnlyModeError if READONLY_MODE is enabled
 * @throws NoteNotFoundError / DuplicateNoteError if the title doesn't resolve to one note
 * @throws Error if the target folder is missing or its name matches several folders
 */
export async function moveNote(title: string, folder: string): Promise<MoveResult> {
  checkReadOnly();

  debug(`Moving note: "${title}" to folder: "${folder}"`);

  const note = await resolveNoteOrThrow(title);
  const moved = await moveResolvedNote(
    note,
    `const targetFolder = findFolder(${JSON.stringify(folder)}, 'Folder');`
  );

  debug(`Note moved: "${title}" -> "${moved.toFolder}"`);
  return moved;
}

export interface TableEdit {
  row: number;
  column: number;
  value: string;
}

/**
 * Edit cells in a table within a note.
 *
 * Read-modify-write over two JXA calls: the write re-checks the note's
 * modification date and body and aborts when either changed in between
 * (sync, user typing; the date alone has only second precision), so
 * concurrent edits are never overwritten.
 * @param title - Note title, "folder/title" or "id:xxx"
 * @param tableIndex - Which table to edit (0-based)
 * @param edits - Cell edits to apply
 * @returns The edited note (title as Apple Notes reports it after the write)
 * @throws ReadOnlyModeError if READONLY_MODE is enabled
 * @throws Error on out-of-range table/row/column or a concurrent modification
 */
export async function editTable(
  title: string,
  tableIndex: number,
  edits: TableEdit[]
): Promise<NoteRef> {
  checkReadOnly();

  debug(`Editing table ${tableIndex} in note: "${title}"`);

  const note = await resolveNoteOrThrow(title);
  const escapedNoteId = JSON.stringify(note.id);

  const snapshot = JSON.parse(
    await executeJxa<string>(`
      const app = Application('Notes');
      const note = app.notes.byId(${escapedNoteId});
      if (!note.exists()) {
        throw new Error("Note no longer exists");
      }
      const modified = note.modificationDate();
      return JSON.stringify({ html: note.body(), modified: modified ? modified.toISOString() : '' });
    `)
  ) as { html: string; modified: string };

  const updatedHtml = applyTableEdits(snapshot.html, tableIndex, edits);

  const written = JSON.parse(
    await executeJxa<string>(`
      const app = Application('Notes');
      const note = app.notes.byId(${escapedNoteId});
      if (!note.exists()) {
        throw new Error("Note no longer exists");
      }
      const current = note.modificationDate();
      if ((current ? current.toISOString() : '') !== ${JSON.stringify(snapshot.modified)} ||
          note.body() !== ${JSON.stringify(snapshot.html)}) {
        throw new Error("Note was modified while the table edit was prepared; nothing was written. Retry the edit.");
      }
      note.body = ${JSON.stringify(updatedHtml)};
      return JSON.stringify({ title: note.name(), folder: note.container().name() });
    `)
  ) as { title: string; folder: string };

  debug(`Table ${tableIndex} updated in note: "${title}"`);

  return { id: note.id, title: written.title, folder: written.folder };
}

/** Folder contents captured before a grouped batch operation. */
interface FolderListing {
  ids: string[];
  names: string[];
}

/** Split parallel id/name arrays into groups of the fetch batch size. */
function groupListing(listing: FolderListing): FolderListing[] {
  const size = getNotesFetchBatchSize();
  const groups: FolderListing[] = [];
  for (let start = 0; start < listing.ids.length; start += size) {
    groups.push({
      ids: listing.ids.slice(start, start + size),
      names: listing.names.slice(start, start + size),
    });
  }
  return groups;
}

/**
 * Result of a batch delete.
 */
export interface BatchDeleteResult {
  /** Notes that were deleted */
  deleted: NoteRef[];
  /** Inputs (titles, or note names in folder mode) that could not be deleted */
  failed: string[];
}

/**
 * Options for batch delete.
 */
export interface BatchDeleteOptions {
  /** List of note titles (supports folder/title and id:xxx formats) */
  titles?: string[];
  /** Delete all notes in this folder (name, nested path or "Account/Folder") */
  folder?: string;
}

/**
 * Delete multiple notes at once.
 *
 * @param options - Either titles array OR folder name (not both)
 * @returns Deleted notes plus per-note failures
 * @throws ReadOnlyModeError if READONLY_MODE is enabled
 * @throws Error if both or neither of titles/folder are provided
 * @throws Error if the folder is missing or its name matches several folders
 */
export async function batchDelete(options: BatchDeleteOptions): Promise<BatchDeleteResult> {
  checkReadOnly();

  const { titles, folder } = options;

  if (titles && folder) {
    throw new Error("Specify either titles or folder, not both");
  }

  if (!titles && !folder) {
    throw new Error("Specify either titles or folder");
  }

  const result: BatchDeleteResult = { deleted: [], failed: [] };

  if (folder) {
    debug(`Batch deleting all notes in folder: "${folder}"`);

    // Ids are captured first, then notes are deleted by id in groups (one
    // JXA call per group): no index positions shift under the loop, a slow
    // group can't time out the whole run, and finished groups are kept.
    const listing = JSON.parse(
      await executeJxa<string>(`
        const app = Application('Notes');
        ${FOLDER_JXA_HELPERS}

        const folder = findFolder(${JSON.stringify(folder)}, 'Folder');
        return JSON.stringify({
          folderName: folder.name(),
          ids: folder.notes.id(),
          names: folder.notes.name(),
        });
      `)
    ) as FolderListing & { folderName: string };

    for (const group of groupListing(listing)) {
      try {
        const parsed = JSON.parse(
          await executeJxa<string>(`
            const app = Application('Notes');
            const folderName = ${JSON.stringify(listing.folderName)};
            const ids = ${JSON.stringify(group.ids)};
            const names = ${JSON.stringify(group.names)};
            const deleted = [];
            const failed = [];

            for (let i = 0; i < ids.length; i++) {
              try {
                app.notes.byId(ids[i]).delete();
                deleted.push({ id: ids[i], title: names[i] || '', folder: folderName });
              } catch (e) {
                failed.push(names[i] || ids[i]);
              }
            }

            return JSON.stringify({ deleted: deleted, failed: failed });
          `)
        ) as BatchDeleteResult;
        result.deleted.push(...parsed.deleted);
        result.failed.push(...parsed.failed);
      } catch (error) {
        result.failed.push(...group.ids.map((id, i) => group.names[i] || id));
        debug(`Delete group of ${group.ids.length} notes failed:`, error);
      }
    }
  } else if (titles) {
    debug(`Batch deleting ${titles.length} notes by title`);

    for (const title of titles) {
      try {
        result.deleted.push(await deleteNote(title));
      } catch (error) {
        result.failed.push(title);
        debug(`Failed to delete "${title}":`, error);
      }
    }
  }

  debug(`Batch delete complete: ${result.deleted.length} deleted, ${result.failed.length} failed`);
  return result;
}

/**
 * Result of a batch move operation.
 */
export interface BatchMoveResult {
  /** Notes that were moved; `folder` is the target folder */
  moved: Array<NoteRef & { fromFolder: string }>;
  /** Inputs (titles, or note names in folder mode) that could not be moved */
  failed: string[];
}

/**
 * Options for batch move.
 */
export interface BatchMoveOptions {
  /** List of note titles (supports folder/title and id:xxx formats) */
  titles?: string[];
  /** Move all notes from this folder (name, nested path or "Account/Folder") */
  sourceFolder?: string;
  /** Target folder (required; name, nested path or "Account/Folder") */
  targetFolder: string;
}

/**
 * Move multiple notes to a target folder.
 *
 * @param options - Either titles array OR sourceFolder (not both) + targetFolder
 * @returns Moved notes plus per-note failures
 * @throws ReadOnlyModeError if READONLY_MODE is enabled
 * @throws Error if both or neither of titles/sourceFolder are provided
 * @throws Error if targetFolder is empty
 * @throws Error if a folder is missing or its name matches several folders
 */
export async function batchMove(options: BatchMoveOptions): Promise<BatchMoveResult> {
  checkReadOnly();

  const { titles, sourceFolder, targetFolder } = options;

  if (!targetFolder) {
    throw new Error("targetFolder is required");
  }

  if (titles && sourceFolder) {
    throw new Error("Specify either titles or sourceFolder, not both");
  }

  if (!titles && !sourceFolder) {
    throw new Error("Specify either titles or sourceFolder");
  }

  const result: BatchMoveResult = { moved: [], failed: [] };

  if (sourceFolder) {
    debug(`Batch moving all notes from "${sourceFolder}" to "${targetFolder}"`);

    // Both folders are resolved and the ids captured once; notes then move
    // by id in groups (one JXA call per group), keeping finished groups
    // even when a later one fails or times out.
    const listing = JSON.parse(
      await executeJxa<string>(`
        const app = Application('Notes');
        ${FOLDER_JXA_HELPERS}

        const source = findFolder(${JSON.stringify(sourceFolder)}, 'Source folder');
        const target = findFolder(${JSON.stringify(targetFolder)}, 'Target folder');
        return JSON.stringify({
          sourceName: source.name(),
          targetId: target.id(),
          targetName: target.name(),
          ids: source.notes.id(),
          names: source.notes.name(),
        });
      `)
    ) as FolderListing & { sourceName: string; targetId: string; targetName: string };

    for (const group of groupListing(listing)) {
      try {
        const parsed = JSON.parse(
          await executeJxa<string>(`
            const app = Application('Notes');
            const target = app.folders.byId(${JSON.stringify(listing.targetId)});
            const sourceName = ${JSON.stringify(listing.sourceName)};
            const targetName = ${JSON.stringify(listing.targetName)};
            const ids = ${JSON.stringify(group.ids)};
            const names = ${JSON.stringify(group.names)};
            const moved = [];
            const failed = [];

            for (let i = 0; i < ids.length; i++) {
              try {
                app.notes.byId(ids[i]).move({to: target});
                moved.push({ id: ids[i], title: names[i] || '', folder: targetName, fromFolder: sourceName });
              } catch (e) {
                failed.push(names[i] || ids[i]);
              }
            }

            return JSON.stringify({ moved: moved, failed: failed });
          `)
        ) as BatchMoveResult;
        result.moved.push(...parsed.moved);
        result.failed.push(...parsed.failed);
      } catch (error) {
        result.failed.push(...group.ids.map((id, i) => group.names[i] || id));
        debug(`Move group of ${group.ids.length} notes failed:`, error);
      }
    }
  } else if (titles) {
    debug(`Batch moving ${titles.length} notes to "${targetFolder}"`);

    // Resolve the target once: a missing or ambiguous folder is a caller
    // error for the whole batch, not a per-note failure.
    const { targetId } = JSON.parse(
      await executeJxa<string>(`
        const app = Application('Notes');
        ${FOLDER_JXA_HELPERS}

        const target = findFolder(${JSON.stringify(targetFolder)}, 'Target folder');
        return JSON.stringify({ targetId: target.id() });
      `)
    ) as { targetId: string };
    const targetSetup = `const targetFolder = app.folders.byId(${JSON.stringify(targetId)});`;

    for (const title of titles) {
      try {
        const moved = await moveResolvedNote(await resolveNoteOrThrow(title), targetSetup);
        result.moved.push({
          id: moved.id,
          title: moved.title,
          folder: moved.toFolder,
          fromFolder: moved.fromFolder,
        });
      } catch (error) {
        result.failed.push(title);
        debug(`Failed to move "${title}":`, error);
      }
    }
  }

  debug(`Batch move complete: ${result.moved.length} moved, ${result.failed.length} failed`);
  return result;
}
