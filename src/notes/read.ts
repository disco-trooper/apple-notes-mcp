/**
 * Apple Notes read operations using JXA (JavaScript for Automation)
 *
 * This module provides functions to read notes, folders, and note metadata
 * from Apple Notes using macOS automation.
 */

import { runJxa } from "run-jxa";
import { createDebugLogger } from "../utils/debug.js";
import { htmlToMarkdown } from "./conversion.js";

// Re-export for backwards compatibility
export { resolveNoteTitle, type ResolvedNote } from "./resolve.js";

// Debug logging
const debug = createDebugLogger("NOTES");

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface NoteInfo {
  /** Note title */
  title: string;
  /** Folder name containing the note */
  folder: string;
  /** Creation date as ISO string */
  created: string;
  /** Last modification date as ISO string */
  modified: string;
}

export interface NoteDetails extends NoteInfo {
  /** Note content as Markdown */
  content: string;
  /** Original HTML content from Apple Notes */
  htmlContent: string;
  /** Note ID for internal reference */
  id: string;
}

// -----------------------------------------------------------------------------
// Internal JXA helpers
// -----------------------------------------------------------------------------

/**
 * Execute JXA code safely with error handling
 */
async function executeJxa<T>(code: string): Promise<T> {
  try {
    const result = await runJxa(code);
    return result as T;
  } catch (error) {
    debug("JXA execution error:", error);
    throw new Error(
      `JXA execution failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Get all notes from Apple Notes with metadata
 *
 * @returns Array of note metadata objects
 */
export async function getAllNotes(): Promise<NoteInfo[]> {
  debug("Getting all notes...");

  const jxaCode = `
    const app = Application('Notes');
    app.includeStandardAdditions = true;

    const allNotes = [];
    const folders = app.folders();

    for (const folder of folders) {
      const folderName = folder.name();
      const notes = folder.notes();

      for (const note of notes) {
        try {
          const props = note.properties();
          allNotes.push({
            title: props.name || '',
            folder: folderName,
            created: props.creationDate ? props.creationDate.toISOString() : '',
            modified: props.modificationDate ? props.modificationDate.toISOString() : ''
          });
        } catch (e) {
          // Skip notes that can't be accessed
        }
      }
    }

    return JSON.stringify(allNotes);
  `;

  const result = await executeJxa<string>(jxaCode);
  const notes = JSON.parse(result) as NoteInfo[];

  debug(`Found ${notes.length} notes`);
  return notes;
}

/**
 * Get a note by its title, with full content
 *
 * @param title - The note title (can be "folder/title" or "id:xxx" format)
 * @returns Note details with content, or null if not found
 */
export async function getNoteByTitle(
  title: string
): Promise<NoteDetails | null> {
  debug(`Getting note by title: ${title}`);

  // Check for id:xxx format for direct ID lookup
  if (title.startsWith("id:")) {
    const noteId = title.slice(3);
    debug(`ID prefix detected, looking up note by ID: ${noteId}`);
    return getNoteById(noteId);
  }

  // Check for folder/title format
  let targetFolder: string | null = null;
  let targetTitle = title;

  if (title.includes("/")) {
    const parts = title.split("/");
    targetFolder = parts.slice(0, -1).join("/");
    targetTitle = parts[parts.length - 1];
    debug(`Parsed folder: ${targetFolder}, title: ${targetTitle}`);
  }

  const escapedTitle = JSON.stringify(targetTitle);
  const escapedFolder = targetFolder ? JSON.stringify(targetFolder) : "null";

  const jxaCode = `
    const app = Application('Notes');
    app.includeStandardAdditions = true;

    const targetTitle = ${escapedTitle};
    const targetFolder = ${escapedFolder};

    let foundNotes = [];
    const folders = app.folders();

    for (const folder of folders) {
      const folderName = folder.name();

      // Skip if folder filter is specified and doesn't match
      if (targetFolder !== null && folderName !== targetFolder) {
        continue;
      }

      const notes = folder.notes.whose({ name: targetTitle });

      for (let i = 0; i < notes.length; i++) {
        try {
          const note = notes[i];
          const props = note.properties();
          foundNotes.push({
            id: note.id(),
            title: props.name || '',
            folder: folderName,
            created: props.creationDate ? props.creationDate.toISOString() : '',
            modified: props.modificationDate ? props.modificationDate.toISOString() : '',
            htmlContent: note.body()
          });
        } catch (e) {
          // Skip notes that can't be accessed
        }
      }
    }

    return JSON.stringify(foundNotes);
  `;

  const result = await executeJxa<string>(jxaCode);
  const notes = JSON.parse(result) as Array<{
    id: string;
    title: string;
    folder: string;
    created: string;
    modified: string;
    htmlContent: string;
  }>;

  if (notes.length === 0) {
    debug("Note not found");
    return null;
  }

  if (notes.length > 1) {
    debug(`Multiple notes found with title: ${targetTitle}`);
    // If folder wasn't specified and multiple exist, return the first one
    // but log a warning
    debug(
      "Returning first match. Use folder/title format for disambiguation."
    );
  }

  const note = notes[0];
  const content = htmlToMarkdown(note.htmlContent);

  debug(`Found note in folder: ${note.folder}`);

  return {
    id: note.id,
    title: note.title,
    folder: note.folder,
    created: note.created,
    modified: note.modified,
    content,
    htmlContent: note.htmlContent,
  };
}

/**
 * Get a note by its Apple Notes ID.
 * Use this for precise access when title-based lookup is ambiguous.
 *
 * @param id - The Apple Notes unique identifier
 * @returns Note details with content, or null if not found
 */
export async function getNoteById(id: string): Promise<NoteDetails | null> {
  debug(`Getting note by ID: ${id}`);

  const escapedId = JSON.stringify(id);

  const jxaCode = `
    const app = Application('Notes');
    app.includeStandardAdditions = true;

    const targetId = ${escapedId};

    try {
      const note = app.notes.byId(targetId);
      const props = note.properties();

      // Find the folder this note belongs to
      let folderName = 'Notes';
      const folders = app.folders();
      for (const folder of folders) {
        const notes = folder.notes();
        for (let i = 0; i < notes.length; i++) {
          if (notes[i].id() === targetId) {
            folderName = folder.name();
            break;
          }
        }
      }

      return JSON.stringify({
        id: note.id(),
        title: props.name || '',
        folder: folderName,
        created: props.creationDate ? props.creationDate.toISOString() : '',
        modified: props.modificationDate ? props.modificationDate.toISOString() : '',
        htmlContent: note.body()
      });
    } catch (e) {
      return JSON.stringify(null);
    }
  `;

  const result = await executeJxa<string>(jxaCode);
  const note = JSON.parse(result) as {
    id: string;
    title: string;
    folder: string;
    created: string;
    modified: string;
    htmlContent: string;
  } | null;

  if (!note) {
    debug("Note not found by ID");
    return null;
  }

  const content = htmlToMarkdown(note.htmlContent);

  debug(`Found note: ${note.title} in folder: ${note.folder}`);

  return {
    id: note.id,
    title: note.title,
    folder: note.folder,
    created: note.created,
    modified: note.modified,
    content,
    htmlContent: note.htmlContent,
  };
}

/**
 * Get a note by explicit folder and title (no "/" parsing).
 * Use this when you have folder and title separately to avoid
 * issues with "/" characters in note titles.
 *
 * @param folder - The folder name
 * @param title - The note title (can contain "/" characters)
 * @returns Note details with content, or null if not found
 */
export async function getNoteByFolderAndTitle(
  folder: string,
  title: string
): Promise<NoteDetails | null> {
  debug(`Getting note: folder="${folder}", title="${title}"`);

  const escapedTitle = JSON.stringify(title);
  const escapedFolder = JSON.stringify(folder);

  const jxaCode = `
    const app = Application('Notes');
    app.includeStandardAdditions = true;

    const targetTitle = ${escapedTitle};
    const targetFolder = ${escapedFolder};

    let foundNotes = [];
    const folders = app.folders();

    for (const folder of folders) {
      const folderName = folder.name();

      // Only look in the specified folder
      if (folderName !== targetFolder) {
        continue;
      }

      const notes = folder.notes.whose({ name: targetTitle });

      for (let i = 0; i < notes.length; i++) {
        try {
          const note = notes[i];
          const props = note.properties();
          foundNotes.push({
            id: note.id(),
            title: props.name || '',
            folder: folderName,
            created: props.creationDate ? props.creationDate.toISOString() : '',
            modified: props.modificationDate ? props.modificationDate.toISOString() : '',
            htmlContent: note.body()
          });
        } catch (e) {
          // Skip notes that can't be accessed
        }
      }
    }

    return JSON.stringify(foundNotes);
  `;

  const result = await executeJxa<string>(jxaCode);
  const notes = JSON.parse(result) as Array<{
    id: string;
    title: string;
    folder: string;
    created: string;
    modified: string;
    htmlContent: string;
  }>;

  if (notes.length === 0) {
    debug("Note not found");
    return null;
  }

  const note = notes[0];
  const content = htmlToMarkdown(note.htmlContent);

  debug(`Found note in folder: ${note.folder}`);

  return {
    id: note.id,
    title: note.title,
    folder: note.folder,
    created: note.created,
    modified: note.modified,
    content,
    htmlContent: note.htmlContent,
  };
}

/**
 * Get all folder names from Apple Notes
 *
 * @returns Array of folder names
 */
export async function getAllFolders(): Promise<string[]> {
  debug("Getting all folders...");

  const jxaCode = `
    const app = Application('Notes');
    app.includeStandardAdditions = true;

    const folders = app.folders();
    const folderNames = [];

    for (const folder of folders) {
      try {
        folderNames.push(folder.name());
      } catch (e) {
        // Skip folders that can't be accessed
      }
    }

    return JSON.stringify(folderNames);
  `;

  const result = await executeJxa<string>(jxaCode);
  const folders = JSON.parse(result) as string[];

  debug(`Found ${folders.length} folders`);
  return folders;
}
