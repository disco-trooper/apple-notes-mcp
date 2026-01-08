import * as lancedb from "@lancedb/lancedb";
import path from "node:path";
import os from "node:os";

// Schema for stored notes
export interface NoteRecord {
  title: string;
  content: string;
  vector: number[];
  folder: string;
  created: string;      // ISO date
  modified: string;     // ISO date
  indexed_at: string;   // ISO date - when embedding was generated
  [key: string]: unknown; // Index signature for LanceDB compatibility
}

// Search result with score
export interface SearchResult {
  title: string;
  folder: string;
  content: string;
  modified: string;
  score: number;
}

// VectorStore interface for future extensibility
export interface VectorStore {
  index(records: NoteRecord[]): Promise<void>;
  update(record: NoteRecord): Promise<void>;
  delete(title: string): Promise<void>;
  search(queryVector: number[], limit: number): Promise<SearchResult[]>;
  searchFTS(query: string, limit: number): Promise<SearchResult[]>;
  getByTitle(title: string): Promise<NoteRecord | null>;
  getAll(): Promise<NoteRecord[]>;
  count(): Promise<number>;
  clear(): Promise<void>;
}

// Debug logging
const DEBUG = process.env.DEBUG === "true";
function debug(...args: unknown[]) {
  if (DEBUG) {
    console.error("[DB]", ...args);
  }
}

// LanceDB implementation
export class LanceDBStore implements VectorStore {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private readonly dbPath: string;
  private readonly tableName = "notes";

  constructor(dataDir?: string) {
    this.dbPath = dataDir || path.join(os.homedir(), ".apple-notes-mcp", "data");
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
      } catch {
        // Table doesn't exist yet - will be created on first index
        debug(`Table ${this.tableName} not found, will create on first index`);
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
    } catch {
      // Table didn't exist, that's fine
    }

    // Create new table with records
    debug(`Creating table with ${records.length} records`);
    this.table = await db.createTable(this.tableName, records);

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

    // Delete existing record with same title
    await this.delete(record.title);

    // Add the updated record
    await table.add([record]);
    debug(`Updated record: ${record.title}`);
  }

  async delete(title: string): Promise<void> {
    const table = await this.ensureTable();

    // LanceDB uses SQL-like filter syntax
    const escapedTitle = title.replace(/'/g, "''");
    await table.delete(`title = '${escapedTitle}'`);
    debug(`Deleted record: ${title}`);
  }

  async search(queryVector: number[], limit: number): Promise<SearchResult[]> {
    const table = await this.ensureTable();

    const results = await table
      .search(queryVector)
      .limit(limit)
      .toArray();

    return results.map((row, index) => ({
      title: row.title as string,
      folder: row.folder as string,
      content: row.content as string,
      modified: row.modified as string,
      score: 1 / (1 + index), // Simple rank-based score
    }));
  }

  async searchFTS(query: string, limit: number): Promise<SearchResult[]> {
    const table = await this.ensureTable();

    try {
      // LanceDB FTS search - use queryType option
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const results = await (table as any)
        .search(query, { queryType: "fts" })
        .limit(limit)
        .toArray();

      return results.map((row: Record<string, unknown>, index: number) => ({
        title: row.title as string,
        folder: row.folder as string,
        content: row.content as string,
        modified: row.modified as string,
        score: 1 / (1 + index),
      }));
    } catch {
      // FTS might fail if no index or no matches
      debug("FTS search failed, returning empty results");
      return [];
    }
  }

  async getByTitle(title: string): Promise<NoteRecord | null> {
    const table = await this.ensureTable();

    const escapedTitle = title.replace(/'/g, "''");
    const results = await table
      .query()
      .where(`title = '${escapedTitle}'`)
      .limit(1)
      .toArray();

    if (results.length === 0) {
      return null;
    }

    const row = results[0];
    return {
      title: row.title as string,
      content: row.content as string,
      vector: row.vector as number[],
      folder: row.folder as string,
      created: row.created as string,
      modified: row.modified as string,
      indexed_at: row.indexed_at as string,
    };
  }

  async getAll(): Promise<NoteRecord[]> {
    const table = await this.ensureTable();

    const results = await table.query().toArray();

    return results.map((row) => ({
      title: row.title as string,
      content: row.content as string,
      vector: row.vector as number[],
      folder: row.folder as string,
      created: row.created as string,
      modified: row.modified as string,
      indexed_at: row.indexed_at as string,
    }));
  }

  async count(): Promise<number> {
    try {
      const table = await this.ensureTable();
      return await table.countRows();
    } catch {
      return 0;
    }
  }

  async clear(): Promise<void> {
    const db = await this.ensureConnection();
    try {
      await db.dropTable(this.tableName);
      this.table = null;
      debug("Cleared table");
    } catch {
      // Table didn't exist
    }
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
