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
    throw new Error("Operation disabled in read-only mode");
  }
}

/**
 * Convert Markdown content to HTML for Apple Notes.
 *
 * @param markdown - Markdown content
 * @returns HTML string
 */
function markdownToHtml(markdown: string): string {
  // Configure marked for clean HTML output
  const html = marked.parse(markdown, {
    async: false,
    gfm: true,
    breaks: true,
  }) as string;

  return html;
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
 * Update an existing note's content.
 *
 * @param title - Note title (supports folder prefix: "Work/My Note")
 * @param content - New content (Markdown)
 * @throws Error if READONLY_MODE is enabled
 * @throws Error if note not found or duplicate titles without folder prefix
 */
export async function updateNote(title: string, content: string): Promise<void> {
  checkReadOnly();

  debug(`Updating note: "${title}"`);

  // Resolve the note to get its ID
  const resolved = await resolveNoteTitle(title);

  if (!resolved.success || !resolved.note) {
    if (resolved.suggestions && resolved.suggestions.length > 0) {
      throw new Error(
        `${resolved.error} Suggestions: ${resolved.suggestions.join(", ")}`
      );
    }
    throw new Error(resolved.error || `Note not found: "${title}"`);
  }

  // Convert Markdown to HTML
  const htmlContent = markdownToHtml(content);
  const escapedNoteId = JSON.stringify(resolved.note.id);
  const escapedContent = JSON.stringify(htmlContent);

  debug(`HTML content length: ${htmlContent.length}`);

  await runJxa(`
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

    return "ok";
  `);

  debug(`Note updated: "${title}"`);
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

  // Resolve the note to get its ID
  const resolved = await resolveNoteTitle(title);

  if (!resolved.success || !resolved.note) {
    if (resolved.suggestions && resolved.suggestions.length > 0) {
      throw new Error(
        `${resolved.error} Suggestions: ${resolved.suggestions.join(", ")}`
      );
    }
    throw new Error(resolved.error || `Note not found: "${title}"`);
  }

  const escapedNoteId = JSON.stringify(resolved.note.id);

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

  // Resolve the note to get its ID
  const resolved = await resolveNoteTitle(title);

  if (!resolved.success || !resolved.note) {
    if (resolved.suggestions && resolved.suggestions.length > 0) {
      throw new Error(
        `${resolved.error} Suggestions: ${resolved.suggestions.join(", ")}`
      );
    }
    throw new Error(resolved.error || `Note not found: "${title}"`);
  }

  const escapedNoteId = JSON.stringify(resolved.note.id);
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

  // Resolve the note
  const resolved = await resolveNoteTitle(title);
  if (!resolved.success || !resolved.note) {
    if (resolved.suggestions && resolved.suggestions.length > 0) {
      throw new Error(
        `${resolved.error} Suggestions: ${resolved.suggestions.join(", ")}`
      );
    }
    throw new Error(resolved.error || `Note not found: "${title}"`);
  }

  // Get current HTML content
  const escapedNoteId = JSON.stringify(resolved.note.id);
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
