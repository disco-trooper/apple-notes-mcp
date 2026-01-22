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
// Internal types and helpers
// -----------------------------------------------------------------------------

/** Raw note data from JXA before markdown conversion */
interface RawNoteData {
  id: string;
  title: string;
  folder: string;
  created: string;
  modified: string;
  htmlContent: string;
}

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

/**
 * Convert raw JXA note data to NoteDetails with markdown content
 */
function toNoteDetails(raw: RawNoteData): NoteDetails {
  return {
    id: raw.id,
    title: raw.title,
    folder: raw.folder,
    created: raw.created,
    modified: raw.modified,
    content: htmlToMarkdown(raw.htmlContent),
    htmlContent: raw.htmlContent,
  };
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
  const notes = JSON.parse(result) as RawNoteData[];

  if (notes.length === 0) {
    debug("Note not found");
    return null;
  }

  if (notes.length > 1) {
    debug(`Multiple notes found with title: ${targetTitle}`);
    debug("Returning first match. Use folder/title format for disambiguation.");
  }

  debug(`Found note in folder: ${notes[0].folder}`);
  return toNoteDetails(notes[0]);
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
  const note = JSON.parse(result) as RawNoteData | null;

  if (!note) {
    debug("Note not found by ID");
    return null;
  }

  debug(`Found note: ${note.title} in folder: ${note.folder}`);
  return toNoteDetails(note);
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
  const notes = JSON.parse(result) as RawNoteData[];

  if (notes.length === 0) {
    debug("Note not found");
    return null;
  }

  debug(`Found note in folder: ${notes[0].folder}`);
  return toNoteDetails(notes[0]);
}

/**
 * Get all notes in a specific folder with full content.
 * Used as fallback when getAllNotesWithContent fails on the whole dataset.
 *
 * @param folderName - The folder name to fetch notes from
 * @returns Array of note details with content from that folder
 */
export async function getNotesInFolder(folderName: string): Promise<NoteDetails[]> {
  debug(`Getting notes from folder: ${folderName}`);

  const escapedFolder = JSON.stringify(folderName);

  const jxaCode = `
    const app = Application('Notes');
    app.includeStandardAdditions = true;

    const targetFolder = ${escapedFolder};
    const allNotes = [];
    const folders = app.folders();

    for (const folder of folders) {
      if (folder.name() !== targetFolder) continue;

      const notes = folder.notes();

      for (let i = 0; i < notes.length; i++) {
        try {
          const note = notes[i];
          const props = note.properties();

          // Get body with fallback for undefined/null
          let htmlContent = '';
          try {
            const body = note.body();
            htmlContent = (body !== undefined && body !== null) ? body : '';
          } catch (bodyErr) {
            // Body access failed (locked note, sync issue, etc.)
            htmlContent = '';
          }

          allNotes.push({
            id: note.id(),
            title: props.name || '',
            folder: targetFolder,
            created: props.creationDate ? props.creationDate.toISOString() : '',
            modified: props.modificationDate ? props.modificationDate.toISOString() : '',
            htmlContent: htmlContent
          });
        } catch (e) {
          // Skip notes that can't be accessed
        }
      }
    }

    return JSON.stringify(allNotes);
  `;

  const result = await executeJxa<string>(jxaCode);

  // Validate JXA result before parsing
  if (result === undefined || result === null) {
    debug(`JXA returned undefined/null for folder: ${folderName}`);
    throw new Error(`Failed to read notes from folder "${folderName}" (JXA returned no data).`);
  }

  const notes = JSON.parse(result) as RawNoteData[];

  debug(`Fetched ${notes.length} notes from folder: ${folderName}`);

  return notes.map(toNoteDetails);
}

/**
 * Get all notes with full content in a single JXA call.
 * This is much faster than calling getNoteByFolderAndTitle for each note
 * because it avoids the JXA process spawn overhead per note.
 *
 * @returns Array of note details with content
 */
export async function getAllNotesWithContent(): Promise<NoteDetails[]> {
  debug("Getting all notes with content (single JXA call)...");

  const jxaCode = `
    const app = Application('Notes');
    app.includeStandardAdditions = true;

    const allNotes = [];
    const folders = app.folders();

    for (const folder of folders) {
      const folderName = folder.name();
      const notes = folder.notes();

      for (let i = 0; i < notes.length; i++) {
        try {
          const note = notes[i];
          const props = note.properties();

          // Get body with fallback for undefined/null
          let htmlContent = '';
          try {
            const body = note.body();
            htmlContent = (body !== undefined && body !== null) ? body : '';
          } catch (bodyErr) {
            // Body access failed (locked note, sync issue, etc.)
            htmlContent = '';
          }

          allNotes.push({
            id: note.id(),
            title: props.name || '',
            folder: folderName,
            created: props.creationDate ? props.creationDate.toISOString() : '',
            modified: props.modificationDate ? props.modificationDate.toISOString() : '',
            htmlContent: htmlContent
          });
        } catch (e) {
          // Skip notes that can't be accessed
        }
      }
    }

    return JSON.stringify(allNotes);
  `;

  const result = await executeJxa<string>(jxaCode);

  // Validate JXA result before parsing
  if (result === undefined || result === null) {
    debug("JXA returned undefined/null - possible causes: OOM, process killed, Apple Notes unavailable");
    throw new Error(
      "Failed to read notes from Apple Notes (JXA returned no data). " +
      "Possible causes: out of memory, process interrupted, or Apple Notes is not responding. " +
      "Try: 1) Close other apps to free memory, 2) Restart Apple Notes, 3) Run index-notes again."
    );
  }

  const notes = JSON.parse(result) as RawNoteData[];

  debug(`Fetched ${notes.length} notes with content`);

  return notes.map(toNoteDetails);
}

/** Result type for getAllNotesWithFallback */
export interface FallbackResult {
  /** Successfully fetched notes */
  notes: NoteDetails[];
  /** List of skipped notes (folder/title format) that couldn't be read */
  skipped: string[];
}

/**
 * Get all notes with hybrid fallback strategy for robustness.
 *
 * Strategy:
 * 1. Try single JXA call (fastest)
 * 2. On failure, try folder-by-folder
 * 3. On folder failure, try note-by-note within that folder
 *
 * This ensures indexing completes even when some notes are problematic
 * (locked, syncing, corrupted).
 *
 * @returns Notes and list of skipped notes
 */
export async function getAllNotesWithFallback(): Promise<FallbackResult> {
  debug("Getting all notes with fallback strategy...");

  const allNotes: NoteDetails[] = [];
  const skipped: string[] = [];

  // Strategy 1: Try single JXA call (fastest)
  try {
    const notes = await getAllNotesWithContent();
    debug(`Single JXA call succeeded: ${notes.length} notes`);
    return { notes, skipped: [] };
  } catch (singleCallError) {
    debug("Single JXA call failed, falling back to folder-by-folder:", singleCallError);
  }

  // Strategy 2: Folder-by-folder
  const folders = await getAllFolders();
  debug(`Trying folder-by-folder approach for ${folders.length} folders`);

  for (const folderName of folders) {
    try {
      const folderNotes = await getNotesInFolder(folderName);
      allNotes.push(...folderNotes);
      debug(`Folder "${folderName}": ${folderNotes.length} notes`);
    } catch (folderError) {
      debug(`Folder "${folderName}" failed, falling back to note-by-note:`, folderError);

      // Strategy 3: Note-by-note for this folder
      const notesList = await getAllNotes();
      const folderNoteTitles = notesList
        .filter((n) => n.folder === folderName)
        .map((n) => n.title);

      for (const noteTitle of folderNoteTitles) {
        try {
          const note = await getNoteByFolderAndTitle(folderName, noteTitle);
          if (note) {
            allNotes.push(note);
          } else {
            skipped.push(`${folderName}/${noteTitle}`);
          }
        } catch (noteError) {
          debug(`Skipping problematic note: ${folderName}/${noteTitle}`, noteError);
          skipped.push(`${folderName}/${noteTitle}`);
        }
      }
    }
  }

  debug(`Fallback complete: ${allNotes.length} notes, ${skipped.length} skipped`);
  return { notes: allNotes, skipped };
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

// -----------------------------------------------------------------------------
// List Notes with Sorting and Filtering
// -----------------------------------------------------------------------------

// Re-export ListNotesOptions from index.ts (derived from Zod schema - single source of truth)
export type { ListNotesOptions } from "../index.js";

// Import the type for internal use
import type { ListNotesOptions } from "../index.js";

/**
 * List notes with sorting and filtering.
 *
 * @param options - Sorting and filtering options
 * @returns Array of note metadata sorted and filtered as specified
 */
export async function listNotes(options: ListNotesOptions = {}): Promise<NoteInfo[]> {
  const { sort_by = "modified", order = "desc", limit, folder } = options;

  debug(`Listing notes: sort_by=${sort_by}, order=${order}, limit=${limit}, folder=${folder}`);

  const allNotes = await getAllNotes();

  // Filter by folder (case-insensitive for better UX)
  const filtered = folder
    ? allNotes.filter((n) => n.folder.toLowerCase() === folder.toLowerCase())
    : allNotes;

  filtered.sort((a, b) => {
    let comparison: number;

    if (sort_by === "title") {
      comparison = a.title.localeCompare(b.title);
    } else {
      // Handle empty dates by treating them as epoch (0)
      const aTime = a[sort_by] ? new Date(a[sort_by]).getTime() : 0;
      const bTime = b[sort_by] ? new Date(b[sort_by]).getTime() : 0;
      comparison = aTime - bTime;
    }

    return order === "desc" ? -comparison : comparison;
  });

  const result = limit ? filtered.slice(0, limit) : filtered;

  debug(`Returning ${result.length} notes`);
  return result;
}
