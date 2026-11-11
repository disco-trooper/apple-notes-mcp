import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { Field, FixedSizeList, Float32, Int32, List, Schema, Utf8 } from "apache-arrow";
import { escapeForFilter } from "./validation.js";
import { createDebugLogger } from "../utils/debug.js";
import { getDataDir } from "../config/paths.js";

// Schema for stored notes (one row per note)
export interface NoteRecord {
  id: string;           // Apple Notes unique identifier
  title: string;
  content: string;
  vector: number[];
  folder: string;
  created: string;      // ISO date
  modified: string;     // ISO date (note's own modification date)
  indexed_at: string;   // ISO date - when embedding was generated
  // Knowledge Graph fields
  tags: string[];       // Extracted #hashtags (without #)
  outlinks: string[];   // Extracted [[wiki-links]] titles
  [key: string]: unknown; // Index signature for LanceDB compatibility
}

/** Note row without its vector (graph features). */
export interface NoteMetadata {
  id: string;
  title: string;
  content: string;
  folder: string;
  created: string;
  modified: string;
  indexed_at: string;
  tags: string[];
  outlinks: string[];
}

export interface IndexMetadataRecord {
  id: string;
  title: string;
  folder: string;
  modified: string;
  indexed_at: string;
}

/** Per-note metadata of the chunks table. */
export interface ChunkNoteMetadata {
  note_id: string;
  note_title: string;
  folder: string;
  modified: string;
}

/** Row returned by notes-table vector/FTS search. */
export interface NoteSearchRow {
  id: string;
  title: string;
  folder: string;
  content: string;
  modified: string;
  /** Rank-based score (higher = more relevant) */
  score: number;
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

/** Row returned by chunk-table vector/FTS search. */
export interface ChunkRow {
  chunk_id: string;
  note_id: string;
  note_title: string;
  folder: string;
  chunk_index: number;
  total_chunks: number;
  content: string;
  modified: string;
  /** Rank-based score (higher = more relevant) */
  score: number;
}

const debug = createDebugLogger("DB");

/** Max ids per `IN (...)` predicate. */
const IN_BATCH_SIZE = 500;

/** `column IN (...)` predicates covering `values`, at most IN_BATCH_SIZE values each. */
function inPredicates(column: string, values: string[]): string[] {
  const predicates: string[] = [];
  for (let i = 0; i < values.length; i += IN_BATCH_SIZE) {
    const list = values.slice(i, i + IN_BATCH_SIZE).map((v) => `'${escapeForFilter(v)}'`).join(", ");
    predicates.push(`${column} IN (${list})`);
  }
  return predicates;
}

const MODEL_FILE = "index-model.json";

/** Error lancedb raises for fullTextSearch on a table without an inverted (FTS) index. */
const NO_FTS_INDEX_PATTERN = /unless an INVERTED index has been created/i;

/**
 * FTS index on `content`. Positions are stored so quoted queries ("exact phrase"),
 * which lancedb parses as phrase queries, work instead of failing. Notes are mostly
 * Czech/multilingual, so English stemming and stop words are off; ASCII folding
 * lets `prilis` match `příliš`.
 */
function ftsIndexConfig(): lancedb.Index {
  return lancedb.Index.fts({ withPosition: true, stem: false, removeStopWords: false, asciiFolding: true });
}

// ---------------------------------------------------------------------------
// Arrow schemas (explicit, so empty tags/outlinks never break type inference)
// ---------------------------------------------------------------------------

function utf8(name: string): Field {
  return new Field(name, new Utf8(), true);
}

function stringList(name: string): Field {
  return new Field(name, new List(new Field("item", new Utf8(), true)), true);
}

function vectorField(dims: number): Field {
  return new Field("vector", new FixedSizeList(dims, new Field("item", new Float32(), true)), true);
}

export function noteSchema(dims: number): Schema {
  return new Schema([
    utf8("id"),
    utf8("title"),
    utf8("content"),
    vectorField(dims),
    utf8("folder"),
    utf8("created"),
    utf8("modified"),
    utf8("indexed_at"),
    stringList("tags"),
    stringList("outlinks"),
  ]);
}

export function chunkSchema(dims: number): Schema {
  return new Schema([
    utf8("chunk_id"),
    utf8("note_id"),
    utf8("note_title"),
    utf8("folder"),
    new Field("chunk_index", new Int32(), true),
    new Field("total_chunks", new Int32(), true),
    utf8("content"),
    vectorField(dims),
    utf8("created"),
    utf8("modified"),
    utf8("indexed_at"),
    stringList("tags"),
    stringList("outlinks"),
  ]);
}

// ---------------------------------------------------------------------------
// Row conversion helpers
// ---------------------------------------------------------------------------

/** Arrow list/vector values come back as Arrow Vectors; convert to JS arrays. */
function toArray<T>(value: unknown): T[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value as T[];
  return Array.from(value as Iterable<T>);
}

function rowToNoteRecord(row: Record<string, unknown>): NoteRecord {
  return {
    id: (row.id as string) ?? "",
    title: row.title as string,
    content: row.content as string,
    vector: toArray<number>(row.vector),
    folder: row.folder as string,
    created: row.created as string,
    modified: row.modified as string,
    indexed_at: row.indexed_at as string,
    tags: toArray<string>(row.tags),
    outlinks: toArray<string>(row.outlinks),
  };
}

function rowToNoteSearchRow(row: Record<string, unknown>, index: number): NoteSearchRow {
  return {
    id: (row.id as string) ?? "",
    title: row.title as string,
    folder: row.folder as string,
    content: row.content as string,
    modified: row.modified as string,
    score: 1 / (1 + index),
  };
}

function rowToChunkRow(row: Record<string, unknown>, index: number): ChunkRow {
  return {
    chunk_id: row.chunk_id as string,
    note_id: row.note_id as string,
    note_title: row.note_title as string,
    folder: row.folder as string,
    chunk_index: Number(row.chunk_index),
    total_chunks: Number(row.total_chunks),
    content: row.content as string,
    modified: row.modified as string,
    score: 1 / (1 + index),
  };
}

// ---------------------------------------------------------------------------
// Embedding model guard
// ---------------------------------------------------------------------------

interface IndexModelInfo {
  provider: string;
  dims: number;
}

function modelFilePath(dataDir: string): string {
  return path.join(dataDir, MODEL_FILE);
}

/**
 * Persist the embedding provider description and vector dimensions the index
 * was built with. Call after a successful full index.
 */
export async function recordIndexModel(
  description: string,
  dims: number,
  dataDir: string = getDataDir()
): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  const info: IndexModelInfo = { provider: description, dims };
  await fs.writeFile(modelFilePath(dataDir), JSON.stringify(info), "utf8");
}

/** The recorded index model, or null when none was recorded (empty or pre-guard index). */
async function readIndexModel(dataDir: string): Promise<IndexModelInfo | null> {
  let raw: string;
  try {
    raw = await fs.readFile(modelFilePath(dataDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return JSON.parse(raw) as IndexModelInfo;
}

/**
 * Throw when the active embedding model differs from the one the index was
 * built with. No-op when no record exists (empty or pre-guard index).
 */
export async function assertIndexCompatible(
  description: string,
  dims: number,
  dataDir: string = getDataDir()
): Promise<void> {
  const stored = await readIndexModel(dataDir);
  if (stored && (stored.provider !== description || stored.dims !== dims)) {
    throw new Error(
      `Embedding model changed (${stored.provider}, ${stored.dims} dims -> ${description}, ${dims} dims). ` +
        "Run purge-index, then index-notes mode=full."
    );
  }
}

/**
 * True only when a model record exists and matches exactly, i.e. stored
 * vectors come from the active model and can be reused.
 */
export async function indexModelMatches(
  description: string,
  dims: number,
  dataDir: string = getDataDir()
): Promise<boolean> {
  const stored = await readIndexModel(dataDir);
  return stored !== null && stored.provider === description && stored.dims === dims;
}

// ---------------------------------------------------------------------------
// Shared table plumbing
// ---------------------------------------------------------------------------

abstract class LanceTable {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  protected readonly dbPath: string;

  protected abstract readonly tableName: string;
  protected abstract readonly missingMessage: string;
  protected abstract schemaFor(dims: number): Schema;

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

  protected async ensureTable(): Promise<lancedb.Table> {
    if (!this.table) {
      const db = await this.ensureConnection();
      try {
        this.table = await db.openTable(this.tableName);
        debug(`Opened table: ${this.tableName}`);
      } catch (error) {
        debug(`Table ${this.tableName} not found:`, error);
        throw new Error(this.missingMessage);
      }
    }
    return this.table;
  }

  /** Replace the table contents with `rows` (explicit schema, dims from the first vector). */
  protected async overwrite(rows: Array<Record<string, unknown> & { vector: number[] }>): Promise<void> {
    if (rows.length === 0) {
      debug(`${this.tableName}: nothing to index`);
      return;
    }
    const db = await this.ensureConnection();
    const schema = this.schemaFor(rows[0].vector.length);
    // Keep serving the old handle until the new table exists, then cache the
    // new handle before building FTS on it: a reader that opened its own handle
    // in between would keep a version without the FTS index.
    const table = await db.createTable(this.tableName, rows, { schema, mode: "overwrite" });
    this.table = table;
    await table.createIndex("content", { config: ftsIndexConfig(), replace: true });
    debug(`${this.tableName}: indexed ${rows.length} rows`);
  }

  protected async append(rows: Record<string, unknown>[]): Promise<void> {
    if (rows.length === 0) return;
    const table = await this.ensureTable();
    // Table.add converts rows using the table's own schema.
    await table.add(rows);
    debug(`${this.tableName}: added ${rows.length} rows`);
  }

  protected async upsertOn(key: string, rows: Record<string, unknown>[]): Promise<void> {
    if (rows.length === 0) return;
    const table = await this.ensureTable();
    // mergeInsert converts rows with the table's own schema (like Table.add),
    // so all-empty list columns need no Arrow inference.
    await table.mergeInsert(key).whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(rows);
    debug(`${this.tableName}: upserted ${rows.length} rows`);
  }

  protected async deleteWhereIn(column: string, values: string[]): Promise<void> {
    if (values.length === 0) return;
    const table = await this.ensureTable();
    for (const predicate of inPredicates(column, values)) {
      await table.delete(predicate);
    }
    debug(`${this.tableName}: deleted rows for ${values.length} ${column} values`);
  }

  protected async vectorSearch(queryVector: number[], limit: number): Promise<Record<string, unknown>[]> {
    const table = await this.ensureTable();
    return table.search(queryVector).limit(limit).toArray();
  }

  /** Full-text search; [] when no FTS index exists, real errors propagate. */
  protected async ftsSearch(query: string, limit: number): Promise<Record<string, unknown>[]> {
    const table = await this.ensureTable();
    // Probe by querying, not listIndices(): FTS indexes written by lancedb <=0.13
    // still serve queries but are not reported by listIndices() in newer releases.
    try {
      return await table.query().fullTextSearch(query).limit(limit).toArray();
    } catch (error) {
      if (error instanceof Error && NO_FTS_INDEX_PATTERN.test(error.message)) {
        debug(`${this.tableName}: no FTS index, skipping full-text search`);
        return [];
      }
      throw error;
    }
  }

  async rebuildFtsIndex(): Promise<void> {
    const table = await this.ensureTable();
    await table.createIndex("content", { config: ftsIndexConfig(), replace: true });
    debug(`${this.tableName}: FTS index rebuilt`);
  }

  async count(): Promise<number> {
    try {
      const table = await this.ensureTable();
      return await table.countRows();
    } catch (error) {
      debug(`${this.tableName}: count failed (table may not exist):`, error);
      return 0;
    }
  }

  /** Drop the table and the embedding model record (purge). */
  async clear(): Promise<void> {
    const db = await this.ensureConnection();
    const names = await db.tableNames();
    if (names.includes(this.tableName)) {
      await db.dropTable(this.tableName);
      debug(`${this.tableName}: dropped`);
    }
    // Forget the handle only once the table is gone, so no reader can cache it after.
    this.table = null;
    await fs.rm(modelFilePath(this.dbPath), { force: true });
  }
}

// ---------------------------------------------------------------------------
// Notes table: one row per note (graph, related-notes, change detection)
// ---------------------------------------------------------------------------

export class LanceDBStore extends LanceTable {
  protected readonly tableName = "notes";
  protected readonly missingMessage = "Index not found. Run index-notes first.";

  protected schemaFor(dims: number): Schema {
    return noteSchema(dims);
  }

  /** Create or overwrite the table with `records`. */
  async index(records: NoteRecord[]): Promise<void> {
    await this.overwrite(records);
  }

  /** Append records to the existing table. */
  async addRecords(records: NoteRecord[]): Promise<void> {
    await this.append(records);
  }

  /** Insert or replace records by id. */
  async upsert(records: NoteRecord[]): Promise<void> {
    await this.upsertOn("id", records);
  }

  async deleteByIds(ids: string[]): Promise<void> {
    await this.deleteWhereIn("id", ids);
  }

  async getById(id: string): Promise<NoteRecord | null> {
    const table = await this.ensureTable();
    const rows = await table
      .query()
      .where(`id = '${escapeForFilter(id)}'`)
      .limit(1)
      .toArray();
    return rows.length === 0 ? null : rowToNoteRecord(rows[0]);
  }

  async getIndexMetadata(): Promise<IndexMetadataRecord[]> {
    const table = await this.ensureTable();
    const rows = await table
      .query()
      .select(["id", "title", "folder", "modified", "indexed_at"])
      .toArray();
    return rows.map((row): IndexMetadataRecord => ({
      id: (row.id as string) ?? "",
      title: row.title as string,
      folder: row.folder as string,
      modified: row.modified as string,
      indexed_at: row.indexed_at as string,
    }));
  }

  /** All rows without vectors (graph features). */
  async getAllMetadata(): Promise<NoteMetadata[]> {
    const table = await this.ensureTable();
    const rows = await table
      .query()
      .select(["id", "title", "content", "folder", "created", "modified", "indexed_at", "tags", "outlinks"])
      .toArray();
    return rows.map((row) => ({
      id: (row.id as string) ?? "",
      title: row.title as string,
      content: row.content as string,
      folder: row.folder as string,
      created: row.created as string,
      modified: row.modified as string,
      indexed_at: row.indexed_at as string,
      tags: toArray<string>(row.tags),
      outlinks: toArray<string>(row.outlinks),
    }));
  }

  async search(queryVector: number[], limit: number): Promise<NoteSearchRow[]> {
    const rows = await this.vectorSearch(queryVector, limit);
    return rows.map(rowToNoteSearchRow);
  }

  async searchFTS(query: string, limit: number): Promise<NoteSearchRow[]> {
    const rows = await this.ftsSearch(query, limit);
    return rows.map(rowToNoteSearchRow);
  }
}

let storeInstance: LanceDBStore | null = null;

export function getVectorStore(): LanceDBStore {
  if (!storeInstance) {
    storeInstance = new LanceDBStore();
  }
  return storeInstance;
}

// ---------------------------------------------------------------------------
// Chunks table: Parent Document Retriever pattern (search)
// ---------------------------------------------------------------------------

export class ChunkStore extends LanceTable {
  protected readonly tableName = "chunks";
  protected readonly missingMessage = "Chunk index not found. Run index-notes first.";

  protected schemaFor(dims: number): Schema {
    return chunkSchema(dims);
  }

  /** Create or overwrite the table with `chunks`. */
  async indexChunks(chunks: ChunkRecord[]): Promise<void> {
    await this.overwrite(chunks);
  }

  /** Append chunks. Does not rebuild the FTS index; call rebuildFtsIndex() once after a batch of writes. */
  async addChunks(chunks: ChunkRecord[]): Promise<void> {
    await this.append(chunks);
  }

  async deleteChunksByNoteIds(noteIds: string[]): Promise<void> {
    await this.deleteWhereIn("note_id", noteIds);
  }

  /** One entry per indexed note: id, title, folder and modified (change detection, skip matching). */
  async getNoteMetadata(): Promise<ChunkNoteMetadata[]> {
    const table = await this.ensureTable();
    const rows = await table.query().select(["note_id", "note_title", "folder", "modified"]).toArray();
    const byNote = new Map<string, ChunkNoteMetadata>();
    for (const row of rows) {
      const noteId = row.note_id as string;
      if (!byNote.has(noteId)) {
        byNote.set(noteId, {
          note_id: noteId,
          note_title: row.note_title as string,
          folder: row.folder as string,
          modified: row.modified as string,
        });
      }
    }
    return [...byNote.values()];
  }

  /**
   * Stored vector per distinct chunk content, for embedding reuse. Reads only
   * the `content` and `vector` columns; `noteIds` limits the read to those notes.
   */
  async getContentVectors(noteIds?: string[]): Promise<Map<string, number[]>> {
    const vectors = new Map<string, number[]>();
    if (noteIds?.length === 0) return vectors;
    const table = await this.ensureTable();
    const filters = noteIds ? inPredicates("note_id", noteIds) : [undefined];
    for (const filter of filters) {
      const query = table.query().select(["content", "vector"]);
      const rows = await (filter ? query.where(filter) : query).toArray();
      for (const row of rows) {
        vectors.set(row.content as string, toArray<number>(row.vector));
      }
    }
    return vectors;
  }

  async searchChunks(queryVector: number[], limit: number): Promise<ChunkRow[]> {
    const rows = await this.vectorSearch(queryVector, limit);
    return rows.map(rowToChunkRow);
  }

  async searchChunksFTS(query: string, limit: number): Promise<ChunkRow[]> {
    const rows = await this.ftsSearch(query, limit);
    return rows.map(rowToChunkRow);
  }
}

let chunkStoreInstance: ChunkStore | null = null;

export function getChunkStore(): ChunkStore {
  if (!chunkStoreInstance) {
    chunkStoreInstance = new ChunkStore();
  }
  return chunkStoreInstance;
}
