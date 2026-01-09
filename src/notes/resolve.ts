/**
 * Note title resolution and disambiguation.
 *
 * Handles resolving user input (title, folder/title, id:xxx) to a specific note.
 */

import { runJxa } from "run-jxa";
import { createDebugLogger } from "../utils/debug.js";
import type { NoteSuggestion } from "../errors/index.js";
import { getNoteById } from "./read.js";

const debug = createDebugLogger("NOTES");

/**
 * Result of resolving a note title to a specific note.
 */
export interface ResolvedNote {
  /** Whether resolution was successful */
  success: boolean;
  /** The matched note (if exactly one match) */
  note?: {
    title: string;
    folder: string;
    id: string;
  };
  /** Error message if resolution failed */
  error?: string;
  /** Rich suggestions when multiple matches found (includes ID and created date) */
  suggestions?: NoteSuggestion[];
}

/**
 * Execute JXA code safely with error handling.
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
 * Resolve a note title input to a unique note.
 *
 * Handles:
 * - "id:xxx" format for direct ID lookup
 * - Exact title match
 * - "folder/title" format for disambiguation
 * - Returns suggestions when multiple matches exist
 *
 * @param input - The note title, "folder/title", or "id:xxx" string
 * @returns Resolution result with success status, note info, or suggestions
 */
export async function resolveNoteTitle(input: string): Promise<ResolvedNote> {
  debug(`Resolving note title: ${input}`);

  // Check for id:xxx format for direct ID lookup
  if (input.startsWith("id:")) {
    const noteId = input.slice(3);
    debug(`ID prefix detected, looking up note by ID: ${noteId}`);
    const noteDetails = await getNoteById(noteId);
    if (!noteDetails) {
      return {
        success: false,
        error: `Note not found with ID: "${noteId}"`,
      };
    }
    return {
      success: true,
      note: {
        id: noteDetails.id,
        title: noteDetails.title,
        folder: noteDetails.folder,
      },
    };
  }

  // Check for folder/title format
  let targetFolder: string | null = null;
  let targetTitle = input;

  if (input.includes("/")) {
    const parts = input.split("/");
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
            title: note.name(),
            folder: folderName,
            created: props.creationDate ? props.creationDate.toISOString() : ''
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
  }>;

  if (notes.length === 0) {
    debug("No matching notes found");
    return {
      success: false,
      error: `Note not found: "${input}"`,
    };
  }

  if (notes.length === 1) {
    debug(`Resolved to unique note: ${notes[0].folder}/${notes[0].title}`);
    return {
      success: true,
      note: notes[0],
    };
  }

  // Multiple matches - return rich suggestions with ID and created date
  const suggestions: NoteSuggestion[] = notes.map((n) => ({
    id: n.id,
    folder: n.folder,
    title: n.title,
    created: n.created,
  }));
  debug(`Multiple matches found: ${suggestions.map(s => `${s.folder}/${s.title}`).join(", ")}`);

  return {
    success: false,
    error: `Multiple notes found with title "${targetTitle}". Use ID prefix to specify.`,
    suggestions,
  };
}
