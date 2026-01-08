/**
 * Apple Notes read operations using JXA (JavaScript for Automation)
 *
 * This module provides functions to read notes, folders, and note metadata
 * from Apple Notes using macOS automation.
 */

import { runJxa } from "run-jxa";
import TurndownService from "turndown";
import { createDebugLogger } from "../utils/debug.js";

// Debug logging
const debug = createDebugLogger("NOTES");

// Initialize Turndown for HTML to Markdown conversion
const turndownService = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

// Add custom rule to handle Apple Notes attachment placeholders
turndownService.addRule("attachments", {
  filter: (node) => {
    // Apple Notes uses object tags for attachments
    return node.nodeName === "OBJECT" || node.nodeName === "IMG";
  },
  replacement: (_content, node) => {
    // Turndown uses its own Node type, cast to access attributes
    const element = node as unknown as {
      getAttribute: (name: string) => string | null;
    };
    const filename =
      element.getAttribute("data-filename") ||
      element.getAttribute("alt") ||
      element.getAttribute("src")?.split("/").pop() ||
      "unknown";
    return `[Attachment: ${filename}]`;
  },
});

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
  /** Suggestions when multiple matches found */
  suggestions?: string[];
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

/**
 * Convert HTML content to Markdown, handling Apple Notes specifics
 */
function htmlToMarkdown(html: string): string {
  if (!html) return "";

  // Pre-process: handle Apple Notes specific markup
  let processed = html;

  // Replace attachment objects with placeholder text before Turndown
  processed = processed.replace(
    /<object[^>]*data-filename="([^"]*)"[^>]*>.*?<\/object>/gi,
    "[Attachment: $1]"
  );

  // Handle inline images
  processed = processed.replace(
    /<img[^>]*(?:alt="([^"]*)")?[^>]*>/gi,
    (_match, alt) => {
      const filename = alt || "image";
      return `[Attachment: ${filename}]`;
    }
  );

  // Convert to Markdown
  const markdown = turndownService.turndown(processed);

  return markdown.trim();
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
 * @param title - The note title (can be "folder/title" format for disambiguation)
 * @returns Note details with content, or null if not found
 */
export async function getNoteByTitle(
  title: string
): Promise<NoteDetails | null> {
  debug(`Getting note by title: ${title}`);

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

/**
 * Resolve a note title input to a unique note
 *
 * Handles:
 * - Exact title match
 * - "folder/title" format for disambiguation
 * - Returns suggestions when multiple matches exist
 *
 * @param input - The note title or "folder/title" string
 * @returns Resolution result with success status, note info, or suggestions
 */
export async function resolveNoteTitle(input: string): Promise<ResolvedNote> {
  debug(`Resolving note title: ${input}`);

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
          foundNotes.push({
            id: note.id(),
            title: note.name(),
            folder: folderName
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

  // Multiple matches - return suggestions
  const suggestions = notes.map((n) => `${n.folder}/${n.title}`);
  debug(`Multiple matches found: ${suggestions.join(", ")}`);

  return {
    success: false,
    error: `Multiple notes found with title "${targetTitle}". Please specify the folder.`,
    suggestions,
  };
}
