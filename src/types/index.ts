/**
 * Shared type definitions for Apple Notes MCP.
 */

/**
 * Search result returned to clients.
 * Contains a preview instead of full content by default.
 */
export interface SearchResult {
  /** Apple Notes unique identifier */
  id?: string;
  /** Note title */
  title: string;
  /** Folder containing the note */
  folder: string;
  /** Preview of content (200 chars) or full content if include_content=true */
  preview: string;
  /** Full content (only when include_content=true) */
  content?: string;
  /** Last modified date (ISO string) */
  modified: string;
  /** Combined relevance score (higher = more relevant) */
  score: number;
}

/** Options for listing notes (mirrors the list-notes tool input). */
export interface ListNotesOptions {
  sort_by?: "created" | "modified" | "title";
  order?: "asc" | "desc";
  limit?: number;
  folder?: string;
}
