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

export class DuplicateNoteError extends Error {
  readonly title: string;
  readonly suggestions: string[];

  constructor(title: string, suggestions: string[]) {
    const suggestionList = suggestions.join(", ");
    super(`Multiple notes found with title "${title}". Use folder prefix: ${suggestionList}`);
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
