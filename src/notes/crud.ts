/**
 * Apple Notes CRUD operations using JXA (JavaScript for Automation).
 *
 * All write operations respect READONLY_MODE environment variable.
 * Content is converted from Markdown to HTML before writing to Apple Notes.
 */

import { runJxa } from "run-jxa";
import { marked } from "marked";
import { resolveNoteTitle } from "./read.js";
import { createDebugLogger } from "../utils/debug.js";
import { findTables, updateTableCell } from "./tables.js";
import { ReadOnlyModeError, NoteNotFoundError, DuplicateNoteError } from "../errors/index.js";

// Debug logging
const debug = createDebugLogger("CRUD");

/**
 * Check if READONLY_MODE is enabled and throw if so.
 * Call this at the start of every write operation.
 *
 * @throws Error if READONLY_MODE=true
 */
export function checkReadOnly(): void {
  if (process.env.READONLY_MODE === "true") {
    throw new ReadOnlyModeError();
  }
}

/**
 * Resolve note title and throw if not found.
 * Consolidates the repeated error handling pattern.
 *
 * @param title - Note title (supports folder prefix)
 * @returns The resolved note with id, title, and folder
 * @throws Error if note not found or duplicates exist without folder prefix
 */
async function resolveNoteOrThrow(title: string): Promise<{ id: string; title: string; folder: string }> {
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
 * Create a new note in Apple Notes.
 *
 * @param title - Note title
 * @param content - Note content (Markdown)
 * @param folder - Optional target folder (defaults to Notes)
 * @throws Error if READONLY_MODE is enabled
 * @throws Error if note with same title already exists
 */
export async function createNote(
  title: string,
  content: string,
  folder?: string
): Promise<void> {
  checkReadOnly();

  debug(`Creating note: "${title}" in folder: "${folder || "Notes"}"`);

  // Convert Markdown to HTML
  const htmlContent = markdownToHtml(content);
  const escapedTitle = JSON.stringify(title);
  const escapedContent = JSON.stringify(htmlContent);
  const escapedFolder = folder ? JSON.stringify(folder) : "null";

  debug(`HTML content length: ${htmlContent.length}`);

  await runJxa(`
    const app = Application('Notes');
    const title = ${escapedTitle};
    const content = ${escapedContent};
    const folderName = ${escapedFolder};

    let targetFolder = null;

    if (folderName) {
      // Find the specified folder
      const folders = app.folders.whose({name: folderName})();
      if (folders.length === 0) {
        throw new Error("Folder not found: " + folderName);
      }
      targetFolder = folders[0];
    } else {
      // Use default folder (first account's default folder)
      targetFolder = app.defaultAccount().defaultFolder();
    }

    // Create the note in the target folder
    const note = app.Note({name: title, body: content});
    targetFolder.notes.push(note);

    return "ok";
  `);

  debug(`Note created: "${title}"`);
}

/**
 * Result of an update operation.
 * Apple Notes may rename the note based on content (first h1 heading).
 */
export interface UpdateResult {
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
 * Note: Apple Notes may automatically rename the note based on the first
 * heading in the content. The returned UpdateResult contains the actual
 * title after the update.
 *
 * @param title - Note title (supports folder prefix: "Work/My Note")
 * @param content - New content (Markdown)
 * @returns UpdateResult with original and new title
 * @throws Error if READONLY_MODE is enabled
 * @throws Error if note not found or duplicate titles without folder prefix
 */
export async function updateNote(title: string, content: string): Promise<UpdateResult> {
  checkReadOnly();

  debug(`Updating note: "${title}"`);

  const note = await resolveNoteOrThrow(title);
  const originalTitle = note.title;
  const folder = note.folder;

  // Convert Markdown to HTML
  const htmlContent = markdownToHtml(content);
  const escapedNoteId = JSON.stringify(note.id);
  const escapedContent = JSON.stringify(htmlContent);

  debug(`HTML content length: ${htmlContent.length}`);

  // Update the note and get its new title (Apple Notes may rename it)
  const result = await runJxa(`
    const app = Application('Notes');
    const noteId = ${escapedNoteId};
    const content = ${escapedContent};

    // Find the note by ID
    const note = app.notes.byId(noteId);

    if (!note.exists()) {
      throw new Error("Note no longer exists");
    }

    // Update the body
    note.body = content;

    // Return the current title (may have changed)
    return JSON.stringify({ newTitle: note.name() });
  `) as string;

  const { newTitle } = JSON.parse(result);
  const titleChanged = newTitle !== originalTitle;

  if (titleChanged) {
    debug(`Note renamed by Apple Notes: "${originalTitle}" -> "${newTitle}"`);
  } else {
    debug(`Note updated: "${title}"`);
  }

  return {
    originalTitle,
    newTitle,
    folder,
    titleChanged,
  };
}

/**
 * Delete a note from Apple Notes.
 *
 * IMPORTANT: The caller must verify that confirm=true before calling this function.
 * This function does NOT check the confirm parameter.
 *
 * @param title - Note title (supports folder prefix: "Work/My Note")
 * @throws Error if READONLY_MODE is enabled
 * @throws Error if note not found or duplicate titles without folder prefix
 */
export async function deleteNote(title: string): Promise<void> {
  checkReadOnly();

  debug(`Deleting note: "${title}"`);

  const note = await resolveNoteOrThrow(title);
  const escapedNoteId = JSON.stringify(note.id);

  await runJxa(`
    const app = Application('Notes');
    const noteId = ${escapedNoteId};

    // Find the note by ID
    const note = app.notes.byId(noteId);

    if (!note.exists()) {
      throw new Error("Note no longer exists");
    }

    // Delete the note
    note.delete();

    return "ok";
  `);

  debug(`Note deleted: "${title}"`);
}

/**
 * Move a note to a different folder.
 *
 * @param title - Note title (supports folder prefix: "Work/My Note")
 * @param folder - Target folder name
 * @throws Error if READONLY_MODE is enabled
 * @throws Error if note not found or target folder not found
 */
export async function moveNote(title: string, folder: string): Promise<void> {
  checkReadOnly();

  debug(`Moving note: "${title}" to folder: "${folder}"`);

  const note = await resolveNoteOrThrow(title);
  const escapedNoteId = JSON.stringify(note.id);
  const escapedFolder = JSON.stringify(folder);

  await runJxa(`
    const app = Application('Notes');
    const noteId = ${escapedNoteId};
    const folderName = ${escapedFolder};

    // Find the target folder
    const folders = app.folders.whose({name: folderName})();
    if (folders.length === 0) {
      throw new Error("Folder not found: " + folderName);
    }
    const targetFolder = folders[0];

    // Find the note by ID
    const note = app.notes.byId(noteId);

    if (!note.exists()) {
      throw new Error("Note no longer exists");
    }

    // Move the note to the target folder
    note.move({to: targetFolder});

    return "ok";
  `);

  debug(`Note moved: "${title}" -> "${folder}"`);
}

export interface TableEdit {
  row: number;
  column: number;
  value: string;
}

/**
 * Edit cells in a table within a note.
 *
 * @param title - Note title (supports folder prefix)
 * @param tableIndex - Which table to edit (0-based)
 * @param edits - Array of cell edits to apply
 */
export async function editTable(
  title: string,
  tableIndex: number,
  edits: TableEdit[]
): Promise<void> {
  checkReadOnly();

  debug(`Editing table ${tableIndex} in note: "${title}"`);

  const note = await resolveNoteOrThrow(title);
  const escapedNoteId = JSON.stringify(note.id);
  const htmlResult = await runJxa(`
    const app = Application('Notes');
    const note = app.notes.byId(${escapedNoteId});
    if (!note.exists()) {
      throw new Error("Note no longer exists");
    }
    return JSON.stringify({ html: note.body() });
  `);

  const { html } = JSON.parse(htmlResult as string);

  // Find all tables
  const tables = findTables(html);
  if (tableIndex >= tables.length) {
    throw new Error(
      `Table index ${tableIndex} out of bounds (note has ${tables.length} tables)`
    );
  }

  // Apply edits to the target table
  let updatedTable = tables[tableIndex];
  for (const edit of edits) {
    updatedTable = updateTableCell(updatedTable, edit.row, edit.column, edit.value);
  }

  // Replace the table in the full HTML
  const updatedHtml = html.replace(tables[tableIndex], updatedTable);

  // Save back to Apple Notes
  const escapedHtml = JSON.stringify(updatedHtml);
  await runJxa(`
    const app = Application('Notes');
    const note = app.notes.byId(${escapedNoteId});
    note.body = ${escapedHtml};
    return "ok";
  `);

  debug(`Table ${tableIndex} updated in note: "${title}"`);
}

/**
 * Result of a batch operation.
 */
export interface BatchResult {
  /** Number of notes successfully processed */
  deleted: number;
  /** Notes that failed to process */
  failed: string[];
}

/**
 * Options for batch delete.
 */
export interface BatchDeleteOptions {
  /** List of note titles (supports folder/title and id:xxx formats) */
  titles?: string[];
  /** Delete all notes in this folder */
  folder?: string;
}

/**
 * Delete multiple notes at once.
 *
 * @param options - Either titles array OR folder name (not both)
 * @returns BatchResult with deleted count and failed notes
 * @throws Error if READONLY_MODE is enabled
 * @throws Error if both titles and folder provided
 * @throws Error if neither titles nor folder provided
 */
export async function batchDelete(options: BatchDeleteOptions): Promise<BatchResult> {
  checkReadOnly();

  const { titles, folder } = options;

  if (titles && folder) {
    throw new Error("Specify either titles or folder, not both");
  }

  if (!titles && !folder) {
    throw new Error("Specify either titles or folder");
  }

  const result: BatchResult = { deleted: 0, failed: [] };

  if (folder) {
    // Delete all notes in folder via single JXA call
    debug(`Batch deleting all notes in folder: "${folder}"`);

    const escapedFolder = JSON.stringify(folder);
    const jxaResult = await runJxa(`
      const app = Application('Notes');
      const folderName = ${escapedFolder};

      const folders = app.folders.whose({name: folderName})();
      if (folders.length === 0) {
        throw new Error("Folder not found: " + folderName);
      }

      const folder = folders[0];
      const notes = folder.notes();
      let deletedCount = 0;

      // Delete in reverse order to avoid index shifting
      for (let i = notes.length - 1; i >= 0; i--) {
        try {
          notes[i].delete();
          deletedCount++;
        } catch (e) {
          // Continue on individual failures
        }
      }

      return JSON.stringify({ deletedCount });
    `);

    const { deletedCount } = JSON.parse(jxaResult as string);
    result.deleted = deletedCount;
  } else if (titles) {
    // Delete individual notes
    debug(`Batch deleting ${titles.length} notes by title`);

    for (const title of titles) {
      try {
        await deleteNote(title);
        result.deleted++;
      } catch (error) {
        result.failed.push(title);
        debug(`Failed to delete "${title}":`, error);
      }
    }
  }

  debug(`Batch delete complete: ${result.deleted} deleted, ${result.failed.length} failed`);
  return result;
}

/**
 * Result of a batch move operation.
 */
export interface BatchMoveResult {
  /** Number of notes successfully moved */
  moved: number;
  /** Notes that failed to move */
  failed: string[];
}

/**
 * Options for batch move.
 */
export interface BatchMoveOptions {
  /** List of note titles (supports folder/title and id:xxx formats) */
  titles?: string[];
  /** Move all notes from this folder */
  sourceFolder?: string;
  /** Target folder (required) */
  targetFolder: string;
}

/**
 * Move multiple notes to a target folder.
 *
 * @param options - Either titles array OR sourceFolder (not both) + targetFolder
 * @returns BatchMoveResult with moved count and failed notes
 * @throws Error if READONLY_MODE is enabled
 * @throws Error if both titles and sourceFolder provided
 * @throws Error if neither titles nor sourceFolder provided
 * @throws Error if targetFolder is empty
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

  const result: BatchMoveResult = { moved: 0, failed: [] };

  if (sourceFolder) {
    // Move all notes from source folder via single JXA call
    debug(`Batch moving all notes from "${sourceFolder}" to "${targetFolder}"`);

    const escapedSource = JSON.stringify(sourceFolder);
    const escapedTarget = JSON.stringify(targetFolder);
    const jxaResult = await runJxa(`
      const app = Application('Notes');
      const sourceName = ${escapedSource};
      const targetName = ${escapedTarget};

      const sourceFolders = app.folders.whose({name: sourceName})();
      if (sourceFolders.length === 0) {
        throw new Error("Source folder not found: " + sourceName);
      }

      const targetFolders = app.folders.whose({name: targetName})();
      if (targetFolders.length === 0) {
        throw new Error("Target folder not found: " + targetName);
      }

      const source = sourceFolders[0];
      const target = targetFolders[0];
      const notes = source.notes();
      let movedCount = 0;

      // Move in reverse order to avoid index shifting
      for (let i = notes.length - 1; i >= 0; i--) {
        try {
          notes[i].move({to: target});
          movedCount++;
        } catch (e) {
          // Continue on individual failures
        }
      }

      return JSON.stringify({ movedCount });
    `);

    const { movedCount } = JSON.parse(jxaResult as string);
    result.moved = movedCount;
  } else if (titles) {
    // Move individual notes
    debug(`Batch moving ${titles.length} notes to "${targetFolder}"`);

    for (const title of titles) {
      try {
        await moveNote(title, targetFolder);
        result.moved++;
      } catch (error) {
        result.failed.push(title);
        debug(`Failed to move "${title}":`, error);
      }
    }
  }

  debug(`Batch move complete: ${result.moved} moved, ${result.failed.length} failed`);
  return result;
}
