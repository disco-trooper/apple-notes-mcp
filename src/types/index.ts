/**
 * Shared type definitions for Apple Notes MCP.
 */

/**
 * Search result returned from the database layer.
 * Contains the full content of the note.
 */
export interface DBSearchResult {
  /** Apple Notes unique identifier */
  id?: string;
  /** Note title */
  title: string;
  /** Folder containing the note */
  folder: string;
  /** Full content of the note */
  content: string;
  /** Last modified date (ISO string) */
  modified: string;
  /** Relevance score (higher = more relevant) */
  score: number;
}

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
