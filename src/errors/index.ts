/**
 * Typed error classes for better error handling.
 */

export class NoteNotFoundError extends Error {
  readonly title: string;

  constructor(title: string) {
    super(`Note not found: "${title}"`);
    this.name = "NoteNotFoundError";
    this.title = title;
  }
}

export class ReadOnlyModeError extends Error {
  constructor() {
    super("Operation disabled in read-only mode");
    this.name = "ReadOnlyModeError";
  }
}

/**
 * Rich suggestion for duplicate note disambiguation.
 */
export interface NoteSuggestion {
  id: string;
  folder: string;
  title: string;
  created: string;
}

export class DuplicateNoteError extends Error {
  readonly title: string;
  readonly suggestions: NoteSuggestion[];

  constructor(title: string, suggestions: NoteSuggestion[]) {
    const suggestionList = suggestions
      .map(s => `id:${s.id} (${s.folder}, created: ${s.created.split("T")[0]})`)
      .join("\n  - ");
    super(`Multiple notes found with title "${title}". Use ID prefix:\n  - ${suggestionList}`);
    this.name = "DuplicateNoteError";
    this.title = title;
    this.suggestions = suggestions;
  }
}

export class FolderNotFoundError extends Error {
  readonly folder: string;

  constructor(folder: string) {
    super(`Folder not found: "${folder}"`);
    this.name = "FolderNotFoundError";
    this.folder = folder;
  }
}

export class TableOutOfBoundsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TableOutOfBoundsError";
  }
}
