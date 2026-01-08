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
 * Check if a note with the given title already exists.
 *
 * @param title - Note title to check
 * @param folder - Optional folder to check in
 * @returns true if note exists, false otherwise
 */
async function noteExists(title: string, folder?: string): Promise<boolean> {
  const escapedTitle = JSON.stringify(title);
  const escapedFolder = folder ? JSON.stringify(folder) : "null";

  const result = await runJxa(`
    const app = Application('Notes');
    const searchTitle = ${escapedTitle};
    const searchFolder = ${escapedFolder};

    const folders = app.folders();

    for (const folder of folders) {
      const folderName = folder.name();

      // Skip if folder filter is specified and doesn't match
      if (searchFolder !== null && folderName !== searchFolder) {
        continue;
      }

      const notes = folder.notes.whose({name: searchTitle})();
      if (notes.length > 0) {
        return "true";
      }
    }

    return "false";
  `);

  return result === "true";
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

  // Check for duplicates
  const exists = await noteExists(title, folder);
  if (exists) {
    const location = folder ? `${folder}/${title}` : title;
    throw new Error(`Note already exists: "${location}"`);
  }

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
