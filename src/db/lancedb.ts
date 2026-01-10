import * as lancedb from "@lancedb/lancedb";
import { validateTitle, escapeForFilter } from "./validation.js";
import type { DBSearchResult as SearchResult } from "../types/index.js";
import { createDebugLogger } from "../utils/debug.js";
import { getDataDir } from "../config/paths.js";

// Schema for stored notes
export interface NoteRecord {
  id: string;           // Apple Notes unique identifier
  title: string;
  content: string;
  vector: number[];
  folder: string;
  created: string;      // ISO date
  modified: string;     // ISO date
  indexed_at: string;   // ISO date - when embedding was generated
  // Knowledge Graph fields
  tags: string[];       // Extracted #hashtags (without #)
  outlinks: string[];   // Extracted [[wiki-links]] titles
  [key: string]: unknown; // Index signature for LanceDB compatibility
}

// Schema for chunked notes (Parent Document Retriever pattern)
export interface ChunkRecord {
  chunk_id: string;      // `${note_id}_chunk_${index}`
  note_id: string;       // Parent note Apple ID
  note_title: string;    // For display and deduplication
  folder: string;
  chunk_index: number;   // 0, 1, 2...
  total_chunks: number;  // Total chunks in this note
  content: string;       // Chunk content
  vector: number[];
  created: string;       // ISO date (from parent)
  modified: string;      // ISO date (from parent)
  indexed_at: string;    // ISO date
  tags: string[];        // From parent note
  outlinks: string[];    // From parent note
  [key: string]: unknown; // Index signature for LanceDB
}

// SearchResult is imported from ../types/index.js as DBSearchResult
export type { SearchResult };

// VectorStore interface for future extensibility
export interface VectorStore {
  index(records: NoteRecord[]): Promise<void>;
  update(record: NoteRecord): Promise<void>;
  delete(title: string): Promise<void>;
  deleteByFolderAndTitle(folder: string, title: string): Promise<void>;
  search(queryVector: number[], limit: number): Promise<SearchResult[]>;
  searchFTS(query: string, limit: number): Promise<SearchResult[]>;
  getByTitle(title: string): Promise<NoteRecord | null>;
  getAll(): Promise<NoteRecord[]>;
  count(): Promise<number>;
  clear(): Promise<void>;
  rebuildFtsIndex(): Promise<void>;
}

// Debug logging
const debug = createDebugLogger("DB");

/**
 * Convert a database row to a SearchResult with rank-based score.
 */
function rowToSearchResult(row: Record<string, unknown>, index: number): SearchResult {
  return {
    id: row.id as string | undefined,
    title: row.title as string,
    folder: row.folder as string,
    content: row.content as string,
    modified: row.modified as string,
    score: 1 / (1 + index),
  };
}

// LanceDB implementation
export class LanceDBStore implements VectorStore {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private readonly dbPath: string;
  private readonly tableName = "notes";

  constructor(dataDir?: string) {
    this.dbPath = dataDir || getDataDir();
  }

  private async ensureConnection(): Promise<lancedb.Connection> {
    if (!this.db) {
      debug(`Connecting to LanceDB at ${this.dbPath}`);
      this.db = await lancedb.connect(this.dbPath);
    }
    return this.db;
  }

  private async ensureTable(): Promise<lancedb.Table> {
    if (!this.table) {
      const db = await this.ensureConnection();
      try {
        this.table = await db.openTable(this.tableName);
        debug(`Opened existing table: ${this.tableName}`);
      } catch (error) {
        // Table doesn't exist yet - will be created on first index
        debug(`Table ${this.tableName} not found, will create on first index. Error:`, error);
        throw new Error("Index not found. Run index-notes first.");
      }
    }
    return this.table;
  }

  async index(records: NoteRecord[]): Promise<void> {
    if (records.length === 0) {
      debug("No records to index");
      return;
    }

    const db = await this.ensureConnection();

    // Drop existing table if exists
    try {
      await db.dropTable(this.tableName);
      debug(`Dropped existing table: ${this.tableName}`);
    } catch (error) {
      debug("Table drop skipped (table may not exist):", error);
    }

    // Arrow type inference requires the FIRST record to have non-empty arrays.
    // Strategy: Reorder records so the first has non-empty tags/outlinks,
    // or add placeholders that stay in the data (filtered on read).
    const processedRecords = records.map((r) => ({
      ...r,
      tags: r.tags ?? [],
      outlinks: r.outlinks ?? [],
    }));

    // Track if we added placeholders
    let addedTagPlaceholder = false;
    let addedOutlinkPlaceholder = false;

    if (processedRecords.length > 0) {
      // Ensure FIRST record has non-empty tags for type inference
      if (processedRecords[0].tags.length === 0) {
        // Try to find a record with tags and swap
        const tagIdx = processedRecords.findIndex(r => r.tags.length > 0);
        if (tagIdx > 0) {
          // Swap first record with the one that has tags
          [processedRecords[0], processedRecords[tagIdx]] =
            [processedRecords[tagIdx], processedRecords[0]];
        } else {
          // No record has tags - add placeholder
          processedRecords[0].tags = ["__type_placeholder__"];
          addedTagPlaceholder = true;
        }
      }

      // Ensure FIRST record has non-empty outlinks for type inference
      if (processedRecords[0].outlinks.length === 0) {
        // Try to find a record with outlinks and copy its structure
        const outlinkIdx = processedRecords.findIndex(r => r.outlinks.length > 0);
        if (outlinkIdx === -1) {
          // No record has outlinks - add placeholder
          processedRecords[0].outlinks = ["__type_placeholder__"];
          addedOutlinkPlaceholder = true;
        } else {
          // Copy first outlink to first record temporarily, then remove
          processedRecords[0].outlinks = ["__type_placeholder__"];
          addedOutlinkPlaceholder = true;
        }
      }
    }

    debug(`Creating table with ${processedRecords.length} records (tag placeholder: ${addedTagPlaceholder}, outlink placeholder: ${addedOutlinkPlaceholder})`);

    // Create new table with records
    this.table = await db.createTable(this.tableName, processedRecords);

    // Remove placeholders by deleting and re-inserting the first record
    if (addedTagPlaceholder || addedOutlinkPlaceholder) {
      const firstRecord = processedRecords[0];
      const cleanRecord = {
        ...firstRecord,
        tags: addedTagPlaceholder ? [] : firstRecord.tags,
        outlinks: addedOutlinkPlaceholder ? [] : firstRecord.outlinks,
      };

      // Delete the record with placeholders
      await this.table.delete(`id = '${escapeForFilter(firstRecord.id)}'`);
      // Re-insert without placeholders
      await this.table.add([cleanRecord]);
      debug("Removed type inference placeholders via delete+insert");
    }

    // Create FTS index for hybrid search
    debug("Creating FTS index on content");
    await this.table.createIndex("content", {
      config: lancedb.Index.fts(),
      replace: true,
    });

    debug(`Indexed ${records.length} records`);
  }

  async update(record: NoteRecord): Promise<void> {
    const table = await this.ensureTable();

    // Add new record first (LanceDB allows duplicates with same title)
    // This ensures we never lose data - if add fails, old record still exists
    await table.add([record]);
    debug(`Added new version of record: ${record.title}`);

    // Now delete old record(s) - use indexed_at to identify which is old
    const validTitle = validateTitle(record.title);
    const escapedTitle = escapeForFilter(validTitle);

    try {
      // Delete records with same title but different indexed_at (older versions)
      const allWithTitle = await table
        .query()
        .where(`title = '${escapedTitle}'`)
        .toArray();

      for (const existing of allWithTitle) {
        if (existing.indexed_at !== record.indexed_at) {
          const escapedOldIndexedAt = escapeForFilter(existing.indexed_at as string);
          await table.delete(`title = '${escapedTitle}' AND indexed_at = '${escapedOldIndexedAt}'`);
          debug(`Deleted old version: ${record.title} (indexed_at: ${existing.indexed_at})`);
        }
      }
    } catch (deleteError) {
      // Log but don't fail - we have the new record, old one is just orphaned
      debug(`Warning: Failed to delete old record versions for: ${record.title}`, deleteError);
    }

    debug(`Updated record: ${record.title}`);
  }

  async delete(title: string): Promise<void> {
    const table = await this.ensureTable();
    const validTitle = validateTitle(title);
    const escapedTitle = escapeForFilter(validTitle);
    await table.delete(`title = '${escapedTitle}'`);
    debug(`Deleted record: ${title}`);
  }

  async deleteByFolderAndTitle(folder: string, title: string): Promise<void> {
    const table = await this.ensureTable();
    const validTitle = validateTitle(title);
    const escapedTitle = escapeForFilter(validTitle);
    const escapedFolder = escapeForFilter(folder);
    await table.delete(`folder = '${escapedFolder}' AND title = '${escapedTitle}'`);
    debug(`Deleted record: ${folder}/${title}`);
  }

  async search(queryVector: number[], limit: number): Promise<SearchResult[]> {
    const table = await this.ensureTable();

    const results = await table
      .search(queryVector)
      .limit(limit)
      .toArray();

    return results.map(rowToSearchResult);
  }

  async searchFTS(query: string, limit: number): Promise<SearchResult[]> {
    const table = await this.ensureTable();

    try {
      const results = await table
        .query()
        .fullTextSearch(query)
        .limit(limit)
        .toArray();

      return results.map(rowToSearchResult);
    } catch (error) {
      debug("FTS search failed, returning empty results. Error:", error);
      return [];
    }
  }

  async getByTitle(title: string): Promise<NoteRecord | null> {
    const table = await this.ensureTable();

    const validTitle = validateTitle(title);
    const escapedTitle = escapeForFilter(validTitle);
    const results = await table
      .query()
      .where(`title = '${escapedTitle}'`)
      .limit(1)
      .toArray();

    if (results.length === 0) return null;

    return results[0] as unknown as NoteRecord;
  }

  async getAll(): Promise<NoteRecord[]> {
    const table = await this.ensureTable();

    const results = await table.query().toArray();

    return results.map((row): NoteRecord => ({
      id: (row.id as string) ?? "",
      title: row.title as string,
      content: row.content as string,
      vector: Array.isArray(row.vector) ? row.vector : Array.from(row.vector as Iterable<number>),
      folder: row.folder as string,
      created: row.created as string,
      modified: row.modified as string,
      indexed_at: row.indexed_at as string,
      // Arrow Vectors need explicit conversion to JS arrays
      tags: Array.isArray(row.tags) ? row.tags : Array.from(row.tags as Iterable<string>),
      outlinks: Array.isArray(row.outlinks) ? row.outlinks : Array.from(row.outlinks as Iterable<string>),
    }));
  }

  async count(): Promise<number> {
    try {
      const table = await this.ensureTable();
      return await table.countRows();
    } catch (error) {
      debug("Count failed (table may not exist):", error);
      return 0;
    }
  }

  async clear(): Promise<void> {
    const db = await this.ensureConnection();
    try {
      await db.dropTable(this.tableName);
      this.table = null;
      debug("Cleared table");
    } catch (error) {
      debug("Clear skipped (table may not exist):", error);
    }
  }

  async rebuildFtsIndex(): Promise<void> {
    const table = await this.ensureTable();
    debug("Rebuilding FTS index on content");
    await table.createIndex("content", {
      config: lancedb.Index.fts(),
      replace: true,
    });
    debug("FTS index rebuilt");
  }
}

// Singleton instance
let storeInstance: LanceDBStore | null = null;

export function getVectorStore(): VectorStore {
  if (!storeInstance) {
    storeInstance = new LanceDBStore();
  }
  return storeInstance;
}

// Search result type for chunks
export interface ChunkSearchResult {
  chunk_id: string;
  note_id: string;
  note_title: string;
  folder: string;
  chunk_index: number;
  total_chunks: number;
  content: string;
  modified: string;
  score: number;
}

/**
 * Convert a chunk database row to a ChunkSearchResult with rank-based score.
 */
function rowToChunkSearchResult(row: Record<string, unknown>, index: number): ChunkSearchResult {
  return {
    chunk_id: row.chunk_id as string,
    note_id: row.note_id as string,
    note_title: row.note_title as string,
    folder: row.folder as string,
    chunk_index: row.chunk_index as number,
    total_chunks: row.total_chunks as number,
    content: row.content as string,
    modified: row.modified as string,
    score: 1 / (1 + index),
  };
}

// ChunkStore for Parent Document Retriever pattern
export class ChunkStore {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private readonly dbPath: string;
  private readonly tableName = "chunks";

  constructor(dataDir?: string) {
    this.dbPath = dataDir || getDataDir();
  }

  private async ensureConnection(): Promise<lancedb.Connection> {
    if (!this.db) {
      debug(`ChunkStore: Connecting to LanceDB at ${this.dbPath}`);
      this.db = await lancedb.connect(this.dbPath);
    }
    return this.db;
  }

  private async ensureTable(): Promise<lancedb.Table> {
    if (!this.table) {
      const db = await this.ensureConnection();
      try {
        this.table = await db.openTable(this.tableName);
        debug(`ChunkStore: Opened existing table: ${this.tableName}`);
      } catch (error) {
        debug(`ChunkStore: Table ${this.tableName} not found. Error:`, error);
        throw new Error("Chunk index not found. Run index-notes first.");
      }
    }
    return this.table;
  }

  async indexChunks(chunks: ChunkRecord[]): Promise<void> {
    if (chunks.length === 0) {
      debug("ChunkStore: No chunks to index");
      return;
    }

    const db = await this.ensureConnection();

    // Drop existing table if exists
    try {
      await db.dropTable(this.tableName);
      debug(`ChunkStore: Dropped existing table: ${this.tableName}`);
    } catch (error) {
      debug("ChunkStore: Table drop skipped (table may not exist):", error);
    }

    // Arrow type inference requires the FIRST record to have non-empty arrays.
    // Same strategy as LanceDBStore
    const processedChunks = chunks.map((c) => ({
      ...c,
      tags: c.tags ?? [],
      outlinks: c.outlinks ?? [],
    }));

    let addedTagPlaceholder = false;
    let addedOutlinkPlaceholder = false;

    if (processedChunks.length > 0) {
      // Ensure FIRST chunk has non-empty tags for type inference
      if (processedChunks[0].tags.length === 0) {
        const tagIdx = processedChunks.findIndex(c => c.tags.length > 0);
        if (tagIdx > 0) {
          [processedChunks[0], processedChunks[tagIdx]] =
            [processedChunks[tagIdx], processedChunks[0]];
        } else {
          processedChunks[0].tags = ["__type_placeholder__"];
          addedTagPlaceholder = true;
        }
      }

      // Ensure FIRST chunk has non-empty outlinks for type inference
      if (processedChunks[0].outlinks.length === 0) {
        const outlinkIdx = processedChunks.findIndex(c => c.outlinks.length > 0);
        if (outlinkIdx === -1) {
          processedChunks[0].outlinks = ["__type_placeholder__"];
          addedOutlinkPlaceholder = true;
        } else {
          processedChunks[0].outlinks = ["__type_placeholder__"];
          addedOutlinkPlaceholder = true;
        }
      }
    }

    debug(`ChunkStore: Creating table with ${processedChunks.length} chunks (tag placeholder: ${addedTagPlaceholder}, outlink placeholder: ${addedOutlinkPlaceholder})`);

    // Create new table with chunks
    this.table = await db.createTable(this.tableName, processedChunks);

    // Remove placeholders by deleting and re-inserting the first chunk
    if (addedTagPlaceholder || addedOutlinkPlaceholder) {
      const firstChunk = processedChunks[0];
      const cleanChunk = {
        ...firstChunk,
        tags: addedTagPlaceholder ? [] : firstChunk.tags,
        outlinks: addedOutlinkPlaceholder ? [] : firstChunk.outlinks,
      };

      // Delete the chunk with placeholders
      await this.table.delete(`chunk_id = '${escapeForFilter(firstChunk.chunk_id)}'`);
      // Re-insert without placeholders
      await this.table.add([cleanChunk]);
      debug("ChunkStore: Removed type inference placeholders via delete+insert");
    }

    // Create FTS index for hybrid search
    debug("ChunkStore: Creating FTS index on content");
    await this.table.createIndex("content", {
      config: lancedb.Index.fts(),
      replace: true,
    });

    debug(`ChunkStore: Indexed ${chunks.length} chunks`);
  }

  async searchChunks(queryVector: number[], limit: number): Promise<ChunkSearchResult[]> {
    const table = await this.ensureTable();

    const results = await table
      .search(queryVector)
      .limit(limit)
      .toArray();

    return results.map(rowToChunkSearchResult);
  }

  async searchChunksFTS(query: string, limit: number): Promise<ChunkSearchResult[]> {
    const table = await this.ensureTable();

    try {
      const results = await table
        .query()
        .fullTextSearch(query)
        .limit(limit)
        .toArray();

      return results.map(rowToChunkSearchResult);
    } catch (error) {
      debug("ChunkStore: FTS search failed, returning empty results. Error:", error);
      return [];
    }
  }

  async getChunksByNoteId(noteId: string): Promise<ChunkRecord[]> {
    const table = await this.ensureTable();
    const escapedNoteId = escapeForFilter(noteId);

    const results = await table
      .query()
      .where(`note_id = '${escapedNoteId}'`)
      .toArray();

    // Convert and sort by chunk_index
    const chunks = results.map((row): ChunkRecord => ({
      chunk_id: row.chunk_id as string,
      note_id: row.note_id as string,
      note_title: row.note_title as string,
      folder: row.folder as string,
      chunk_index: row.chunk_index as number,
      total_chunks: row.total_chunks as number,
      content: row.content as string,
      vector: Array.isArray(row.vector) ? row.vector : Array.from(row.vector as Iterable<number>),
      created: row.created as string,
      modified: row.modified as string,
      indexed_at: row.indexed_at as string,
      tags: Array.isArray(row.tags) ? row.tags : Array.from(row.tags as Iterable<string>),
      outlinks: Array.isArray(row.outlinks) ? row.outlinks : Array.from(row.outlinks as Iterable<string>),
    }));

    return chunks.sort((a, b) => a.chunk_index - b.chunk_index);
  }

  async deleteNoteChunks(noteId: string): Promise<void> {
    const table = await this.ensureTable();
    const escapedNoteId = escapeForFilter(noteId);
    await table.delete(`note_id = '${escapedNoteId}'`);
    debug(`ChunkStore: Deleted chunks for note: ${noteId}`);
  }

  async count(): Promise<number> {
    try {
      const table = await this.ensureTable();
      return await table.countRows();
    } catch (error) {
      debug("ChunkStore: Count failed (table may not exist):", error);
      return 0;
    }
  }

  async clear(): Promise<void> {
    const db = await this.ensureConnection();
    try {
      await db.dropTable(this.tableName);
      this.table = null;
      debug("ChunkStore: Cleared table");
    } catch (error) {
      debug("ChunkStore: Clear skipped (table may not exist):", error);
    }
  }

  async rebuildFtsIndex(): Promise<void> {
    const table = await this.ensureTable();
    debug("ChunkStore: Rebuilding FTS index on content");
    await table.createIndex("content", {
      config: lancedb.Index.fts(),
      replace: true,
    });
    debug("ChunkStore: FTS index rebuilt");
  }

  /**
   * Delete chunks for multiple notes at once.
   */
  async deleteChunksByNoteIds(noteIds: string[]): Promise<void> {
    if (noteIds.length === 0) return;

    const table = await this.ensureTable();
    for (const noteId of noteIds) {
      const escapedNoteId = escapeForFilter(noteId);
      await table.delete(`note_id = '${escapedNoteId}'`);
    }
    debug(`ChunkStore: Deleted chunks for ${noteIds.length} notes`);
  }

  /**
   * Add chunks to existing table (for incremental updates).
   */
  async addChunks(chunks: ChunkRecord[]): Promise<void> {
    if (chunks.length === 0) return;

    const table = await this.ensureTable();
    await table.add(chunks);
    debug(`ChunkStore: Added ${chunks.length} chunks`);

    // Rebuild FTS index after adding
    await this.rebuildFtsIndex();
  }
}

// Singleton instance for ChunkStore
let chunkStoreInstance: ChunkStore | null = null;

export function getChunkStore(): ChunkStore {
  if (!chunkStoreInstance) {
    chunkStoreInstance = new ChunkStore();
  }
  return chunkStoreInstance;
}
