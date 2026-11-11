/**
 * MCP server definition: tool registrations and handlers.
 *
 * Kept free of process-level side effects so it can be exercised in tests
 * over an in-memory transport. The stdio bootstrap lives in index.ts.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import packageJson from "../package.json" with { type: "json" };

import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MAX_INPUT_LENGTH,
  MAX_TITLE_LENGTH,
} from "./config/constants.js";
import { envFlag } from "./config/env.js";
import { getVectorStore, getChunkStore } from "./db/lancedb.js";
import { NoteNotFoundError } from "./errors/index.js";
import { getNoteByTitle, getNoteById, getAllFolders, listNotes } from "./notes/read.js";
import type { NoteDetails } from "./notes/read.js";
import { createNote, updateNote, deleteNote, moveNote, editTable, batchDelete, batchMove } from "./notes/crud.js";
import { findTables, parseTable } from "./notes/tables.js";
import { indexNotes, reindexNote } from "./search/indexer.js";
import type { IndexResult } from "./search/indexer.js";
import { hasChunkIndex } from "./search/chunk-indexer.js";
import { searchChunks } from "./search/chunk-search.js";
import { refreshIfNeeded } from "./search/refresh.js";
import {
  syncAfterCreate,
  syncAfterUpdate,
  syncAfterDelete,
  syncAfterMove,
  syncAfterBatchDelete,
  syncAfterBatchMove,
  syncAfterNoteChange,
} from "./search/write-sync.js";
import type { WriteSyncResult } from "./search/write-sync.js";
import { getIndexJobManager } from "./indexing/job-manager.js";
import { withIndexLock, isIndexLocked } from "./indexing/lock.js";
import { listTags, searchByTag, findRelatedNotes } from "./graph/queries.js";
import { exportGraph } from "./graph/export.js";
import { generatePreview } from "./utils/text.js";
import { createDebugLogger } from "./utils/debug.js";
import { sanitizeErrorMessage } from "./utils/errors.js";

const debug = createDebugLogger("MCP");

// --- Shared parameter schemas ---

const noteTitle = z
  .string()
  .min(1)
  .max(MAX_TITLE_LENGTH)
  .describe("Note title; use Folder/Title or id:xxx to disambiguate");
const folderName = z.string().min(1).max(200);
const indexMode = z.enum(["full", "incremental"]);
const searchLimit = z.number().int().min(1).max(MAX_SEARCH_LIMIT);
const titleList = z.array(z.string().min(1).max(MAX_TITLE_LENGTH)).min(1).max(100);

// --- Annotations ---

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
/** Writes only the local search index, never Apple Notes. */
const INDEX_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const destructive = (idempotentHint: boolean): ToolAnnotations => ({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint,
  openWorldHint: false,
});

// --- Response helpers ---

function textResponse(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function jsonResponse(value: unknown): CallToolResult {
  return textResponse(JSON.stringify(value, null, 2));
}

function errorResponse(message: string): CallToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/** Run a handler and turn any thrown error into a sanitized tool error. */
async function guard(handler: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await handler();
  } catch (error) {
    debug("Tool error:", error);
    return errorResponse(sanitizeErrorMessage(error));
  }
}

function syncWarning(result: WriteSyncResult): string {
  return result.warnings.length > 0 ? ` (index sync warning: ${result.warnings.join("; ")})` : "";
}

async function requireNote(title: string): Promise<NoteDetails> {
  const note = await getNoteByTitle(title);
  if (!note) {
    throw new NoteNotFoundError(title);
  }
  return note;
}

/** True when exactly one of the two mutually exclusive options is set. */
function exactlyOne(a: unknown, b: unknown): boolean {
  return (a !== undefined) !== (b !== undefined);
}

function formatIndexResult(result: IndexResult): string {
  let message = `Indexed ${result.indexed} notes in ${(result.timeMs / 1000).toFixed(1)}s`;

  if (result.breakdown) {
    const { added, updated, deleted, skipped } = result.breakdown;
    message += ` (added: ${added}, updated: ${updated}, deleted: ${deleted}, skipped: ${skipped})`;
  }
  if (result.chunks !== undefined) {
    message += `\nChunks written: ${result.chunks}`;
  }
  if (result.skippedNotes && result.skippedNotes.length > 0) {
    message += `\n\nSkipped notes (could not read - may be locked, syncing, or corrupted):\n${result.skippedNotes.map((n) => `  - ${n}`).join("\n")}`;
    message += "\nTip: Check these notes in Apple Notes app. Locked notes can be unlocked, syncing notes will be available after sync completes.";
  }
  return message;
}

/**
 * Create the MCP server with all tools registered.
 * Apple Notes write tools are omitted when READONLY_MODE=true.
 */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: "apple-notes-mcp", version: packageJson.version },
    { capabilities: { tools: {} } }
  );

  registerSearchAndIndexTools(server);
  registerReadTools(server);
  registerGraphTools(server);
  if (!envFlag("READONLY_MODE")) {
    registerWriteTools(server);
  }

  return server;
}

function registerSearchAndIndexTools(server: McpServer): void {
  server.registerTool(
    "search-notes",
    {
      title: "Search notes",
      description: "Search notes using hybrid vector + fulltext search. Requires an index (run index-notes first).",
      inputSchema: {
        query: z.string().min(1, "Query cannot be empty").max(MAX_INPUT_LENGTH).describe("Search query"),
        folder: folderName.optional().describe("Filter by folder"),
        limit: searchLimit.default(DEFAULT_SEARCH_LIMIT).describe(`Max results (default: ${DEFAULT_SEARCH_LIMIT})`),
        mode: z.enum(["hybrid", "keyword", "semantic"]).default("hybrid").describe("Search mode (default: hybrid)"),
        include_content: z.boolean().default(false).describe("Return the full note content instead of a preview (default: false)"),
      },
      annotations: READ_ONLY,
    },
    ({ query, folder, limit, mode, include_content }) =>
      guard(async () => {
        if (await refreshIfNeeded()) {
          debug("Index refreshed before search");
        }
        if (!(await hasChunkIndex())) {
          return errorResponse("No search index found. Run index-notes first.");
        }

        const results = await searchChunks(query, { folder, limit, mode });
        if (results.length === 0) {
          return textResponse("No notes found matching your query.");
        }

        const items: Array<Record<string, unknown>> = [];
        for (const r of results) {
          const base = {
            id: r.note_id,
            title: r.note_title,
            folder: r.folder,
            modified: r.modified,
            score: r.score,
            matchedChunkIndex: r.matchedChunkIndex,
          };
          if (include_content) {
            // Sequential on purpose: each lookup is one osascript process.
            const note = await getNoteById(r.note_id);
            items.push({ ...base, content: note ? note.content : r.matchedChunk });
          } else {
            items.push({ ...base, preview: generatePreview(r.matchedChunk) });
          }
        }
        return jsonResponse(items);
      })
  );

  server.registerTool(
    "index-notes",
    {
      title: "Index notes",
      description: "Index all notes for semantic search. Use mode='incremental' (default) to only process changed notes.",
      inputSchema: {
        mode: indexMode.default("incremental").describe("full = reindex everything, incremental = only changes (default)"),
        background: z.boolean().default(false).describe("Run as a background job and return its id (default: false)"),
      },
      annotations: INDEX_WRITE,
    },
    ({ mode, background }, extra) =>
      guard(async () => {
        if (background) {
          const { job, reused } = getIndexJobManager().start({ mode });
          return jsonResponse({
            message: reused
              ? `Index job already running (mode=${job.mode}); returning existing job`
              : `Started ${job.mode} index job`,
            job_id: job.id,
            status: job.status,
            progress: job.progress,
          });
        }

        const result = await indexNotes(mode, { signal: extra.signal });
        return textResponse(formatIndexResult(result));
      })
  );

  server.registerTool(
    "start-index-job",
    {
      title: "Start index job",
      description: "Start background indexing job and return job id for polling. Returns the running job (reused: true) if one is already active.",
      inputSchema: {
        mode: indexMode.default("incremental").describe("Index mode (default: incremental)"),
      },
      annotations: INDEX_WRITE,
    },
    ({ mode }) =>
      guard(async () => {
        const { job, reused } = getIndexJobManager().start({ mode });
        return jsonResponse({ ...job, reused });
      })
  );

  server.registerTool(
    "get-index-job",
    {
      title: "Get index job",
      description: "Get background indexing job status and progress",
      inputSchema: {
        job_id: z.string().min(1).describe("Job ID returned from start-index-job or index-notes"),
      },
      annotations: READ_ONLY,
    },
    ({ job_id }) =>
      guard(async () => {
        const job = getIndexJobManager().get(job_id);
        return job ? jsonResponse(job) : errorResponse(`Index job not found: "${job_id}"`);
      })
  );

  server.registerTool(
    "list-index-jobs",
    {
      title: "List index jobs",
      description: "List recent background indexing jobs",
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(10).describe("Max jobs to return (default: 10)"),
      },
      annotations: READ_ONLY,
    },
    ({ limit }) => guard(async () => jsonResponse(getIndexJobManager().list(limit)))
  );

  server.registerTool(
    "cancel-index-job",
    {
      title: "Cancel index job",
      description: "Request cancellation for a running background indexing job",
      inputSchema: {
        job_id: z.string().min(1).describe("Job ID returned from start-index-job or index-notes"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ job_id }) =>
      guard(async () => {
        const job = getIndexJobManager().cancel(job_id);
        return job ? jsonResponse(job) : errorResponse(`Index job not found: "${job_id}"`);
      })
  );

  server.registerTool(
    "reindex-note",
    {
      title: "Reindex note",
      description: "Re-index a single note after manual edits",
      inputSchema: { title: noteTitle },
      annotations: INDEX_WRITE,
    },
    ({ title }) =>
      guard(async () => {
        await reindexNote(title);
        return textResponse(`Reindexed note: "${title}"`);
      })
  );

  server.registerTool(
    "purge-index",
    {
      title: "Purge index",
      description:
        "Delete all indexed data (notes and chunks). Use when switching embedding models or to fix corrupted index. Only the local search index is deleted, never Apple Notes.",
      inputSchema: {
        confirm: z.literal(true).describe("Must be true to confirm deletion"),
      },
      annotations: destructive(true),
    },
    () =>
      guard(async () => {
        if (isIndexLocked()) {
          return errorResponse("Indexing is in progress. Cancel the index job or wait for it to finish, then retry.");
        }
        await withIndexLock(async () => {
          await getVectorStore().clear();
          await getChunkStore().clear();
        });
        return textResponse("Index purged. Run index-notes to rebuild.");
      })
  );
}

function registerReadTools(server: McpServer): void {
  server.registerTool(
    "list-notes",
    {
      title: "List notes",
      description: "List notes from Apple Notes with sorting and filtering. Without parameters, shows index statistics.",
      inputSchema: {
        sort_by: z.enum(["created", "modified", "title"]).optional().describe("Sort by date or title (default: modified)"),
        order: z.enum(["asc", "desc"]).optional().describe("Sort order (default: desc)"),
        limit: z.number().int().min(1).max(100).optional().describe("Max notes to return (1-100)"),
        folder: folderName.optional().describe("Filter by folder"),
      },
      annotations: READ_ONLY,
    },
    (params) =>
      guard(async () => {
        const hasListParams = Object.values(params).some((value) => value !== undefined);
        if (!hasListParams) {
          const noteCount = await getVectorStore().count();
          if (await hasChunkIndex()) {
            const chunkCount = await getChunkStore().count();
            return textResponse(`${noteCount} notes indexed. ${chunkCount} chunks indexed for semantic search.`);
          }
          return textResponse(`${noteCount} notes indexed. Run index-notes to enable search.`);
        }

        return jsonResponse(await listNotes(params));
      })
  );

  server.registerTool(
    "get-note",
    {
      title: "Get note",
      description: "Get full content of a note by title",
      inputSchema: {
        title: noteTitle,
        include_html: z.boolean().default(false).describe("Include raw HTML content (default: false)"),
      },
      annotations: READ_ONLY,
    },
    ({ title, include_html }) =>
      guard(async () => {
        const note = await requireNote(title);
        return jsonResponse({
          id: note.id,
          title: note.title,
          folder: note.folder,
          content: note.content,
          ...(include_html && { htmlContent: note.htmlContent }),
          created: note.created,
          modified: note.modified,
        });
      })
  );

  server.registerTool(
    "get-tables",
    {
      title: "Get tables",
      description:
        "Get parsed table data from a note. Returns { title, folder, tableCount, tables: [{ index, rows: string[][], formatting: { bold: boolean }[][] }] }",
      inputSchema: { title: noteTitle },
      annotations: READ_ONLY,
    },
    ({ title }) =>
      guard(async () => {
        const note = await requireNote(title);
        const tables = findTables(note.htmlContent);
        return jsonResponse({
          title: note.title,
          folder: note.folder,
          tableCount: tables.length,
          tables: tables.map((html, index) => ({ index, ...parseTable(html) })),
        });
      })
  );

  server.registerTool(
    "list-folders",
    {
      title: "List folders",
      description: "List all folders in Apple Notes",
      annotations: READ_ONLY,
    },
    () => guard(async () => jsonResponse(await getAllFolders()))
  );
}

function registerGraphTools(server: McpServer): void {
  server.registerTool(
    "list-tags",
    {
      title: "List tags",
      description: "List all tags with occurrence counts",
      annotations: READ_ONLY,
    },
    () =>
      guard(async () => {
        const tags = await listTags();
        return tags.length === 0
          ? textResponse("No tags found. Add #tags to your notes and reindex.")
          : jsonResponse(tags);
      })
  );

  server.registerTool(
    "search-by-tag",
    {
      title: "Search by tag",
      description: "Find notes with a specific tag",
      inputSchema: {
        tag: z.string().min(1).max(100).describe("Tag to search for (without #)"),
        folder: folderName.optional().describe("Filter by folder"),
        limit: searchLimit.default(DEFAULT_SEARCH_LIMIT).describe(`Max results (default: ${DEFAULT_SEARCH_LIMIT})`),
      },
      annotations: READ_ONLY,
    },
    ({ tag, folder, limit }) =>
      guard(async () => {
        const results = await searchByTag(tag, { folder, limit });
        return results.length === 0 ? textResponse(`No notes found with tag: #${tag}`) : jsonResponse(results);
      })
  );

  server.registerTool(
    "related-notes",
    {
      title: "Related notes",
      description: "Find notes related to a source note by tags, links, or semantic similarity",
      inputSchema: {
        title: noteTitle,
        types: z
          .array(z.enum(["tag", "link", "similar"]))
          .default(["tag", "link", "similar"])
          .describe("Relationship types to include (default: all)"),
        limit: z.number().int().min(1).max(50).default(10).describe("Max results (default: 10)"),
      },
      annotations: READ_ONLY,
    },
    ({ title, types, limit }) =>
      guard(async () => {
        const note = await requireNote(title);
        const results = await findRelatedNotes(note.id, { types, limit });
        return results.length === 0 ? textResponse("No related notes found.") : jsonResponse(results);
      })
  );

  server.registerTool(
    "export-graph",
    {
      title: "Export graph",
      description: "Export knowledge graph to JSON or GraphML format for visualization",
      inputSchema: {
        format: z
          .enum(["json", "graphml"])
          .describe("Export format: json (for D3.js, custom viz) or graphml (for Gephi, yEd)"),
        folder: folderName.optional().describe("Filter by folder"),
      },
      annotations: READ_ONLY,
    },
    ({ format, folder }) =>
      guard(async () => {
        const result = await exportGraph({ format, folder });
        return typeof result === "string" ? textResponse(result) : jsonResponse(result);
      })
  );
}

function registerWriteTools(server: McpServer): void {
  server.registerTool(
    "create-note",
    {
      title: "Create note",
      description: "Create a new note in Apple Notes",
      inputSchema: {
        title: z.string().min(1).max(MAX_TITLE_LENGTH).describe("Note title"),
        content: z.string().min(1).max(MAX_INPUT_LENGTH).describe("Note content (Markdown)"),
        folder: folderName.optional().describe("Target folder (default: Notes)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ title, content, folder }) =>
      guard(async () => {
        const result = await createNote(title, content, folder);
        const sync = await syncAfterCreate(result);
        const renamed = result.titleChanged ? ` (Apple Notes titled it from content; requested "${result.requestedTitle}")` : "";
        return textResponse(`Created note: "${result.folder}/${result.title}"${renamed}${syncWarning(sync)}`);
      })
  );

  server.registerTool(
    "update-note",
    {
      title: "Update note",
      description: "Replace the content of an existing note",
      inputSchema: {
        title: noteTitle,
        content: z.string().min(1).max(MAX_INPUT_LENGTH).describe("New content (Markdown)"),
        reindex: z.boolean().default(true).describe("Update the search index after the change (default: true)"),
      },
      annotations: destructive(true),
    },
    ({ title, content, reindex }) =>
      guard(async () => {
        const result = await updateNote(title, content);
        const location = `${result.folder}/${result.newTitle}`;
        const renamed = result.titleChanged ? ` (renamed from "${result.originalTitle}")` : "";

        if (!reindex) {
          return textResponse(`Updated note: "${location}"${renamed}`);
        }
        const sync = await syncAfterUpdate(result);
        return textResponse(`Updated and reindexed note: "${location}"${renamed}${syncWarning(sync)}`);
      })
  );

  server.registerTool(
    "delete-note",
    {
      title: "Delete note",
      description: "Delete a note (requires confirm: true for safety)",
      inputSchema: {
        title: noteTitle,
        confirm: z.literal(true).describe("Must be true to confirm deletion"),
      },
      annotations: destructive(false),
    },
    ({ title }) =>
      guard(async () => {
        const result = await deleteNote(title);
        const sync = await syncAfterDelete(result);
        return textResponse(`Deleted note: "${result.folder}/${result.title}"${syncWarning(sync)}`);
      })
  );

  server.registerTool(
    "move-note",
    {
      title: "Move note",
      description: "Move a note to a different folder",
      inputSchema: {
        title: noteTitle,
        folder: folderName.describe("Target folder"),
      },
      annotations: destructive(true),
    },
    ({ title, folder }) =>
      guard(async () => {
        const result = await moveNote(title, folder);
        const sync = await syncAfterMove(result);
        return textResponse(
          `Moved note "${result.title}" from "${result.fromFolder}" to "${result.toFolder}"${syncWarning(sync)}`
        );
      })
  );

  server.registerTool(
    "edit-table",
    {
      title: "Edit table",
      description: "Edit cells in a table within a note. Use for updating table data without rewriting the entire note.",
      inputSchema: {
        title: noteTitle,
        table_index: z.number().int().min(0).default(0).describe("Which table to edit (0 = first table, default: 0)"),
        edits: z
          .array(
            z.object({
              row: z.number().int().min(0).describe("Row index (0 = header row)"),
              column: z.number().int().min(0).describe("Column index (0 = first column)"),
              value: z.string().max(10000).describe("New cell value"),
            })
          )
          .min(1)
          .max(100)
          .describe("Cell edits"),
      },
      annotations: destructive(true),
    },
    ({ title, table_index, edits }) =>
      guard(async () => {
        const note = await editTable(title, table_index, edits);
        const sync = await syncAfterNoteChange(note.id);
        return textResponse(
          `Updated ${edits.length} cell(s) in table ${table_index} of "${note.folder}/${note.title}"${syncWarning(sync)}`
        );
      })
  );

  server.registerTool(
    "batch-delete",
    {
      title: "Batch delete notes",
      description: "Delete multiple notes at once: pass either titles or folder (all notes in it). Requires confirm: true.",
      inputSchema: {
        titles: titleList.optional().describe("Note titles to delete (supports Folder/Title and id:xxx)"),
        folder: folderName.optional().describe("Delete ALL notes in this folder"),
        confirm: z.literal(true).describe("Must be true to confirm deletion"),
      },
      annotations: destructive(false),
    },
    ({ titles, folder }) =>
      guard(async () => {
        if (!exactlyOne(titles, folder)) {
          return errorResponse("Invalid arguments: Specify exactly one of titles or folder");
        }
        const result = await batchDelete({ titles, folder });
        const sync = result.deleted.length > 0
          ? await syncAfterBatchDelete(result.deleted.map((note) => note.id))
          : null;

        let message = `Deleted ${result.deleted.length} notes.`;
        if (result.failed.length > 0) {
          message += `\nFailed to delete: ${result.failed.join(", ")}`;
        }
        return textResponse(message + (sync ? syncWarning(sync) : ""));
      })
  );

  server.registerTool(
    "batch-move",
    {
      title: "Batch move notes",
      description: "Move multiple notes to a target folder: pass either titles or sourceFolder (all notes in it).",
      inputSchema: {
        titles: titleList.optional().describe("Note titles to move (supports Folder/Title and id:xxx)"),
        sourceFolder: folderName.optional().describe("Move ALL notes from this folder"),
        targetFolder: folderName.describe("Target folder"),
      },
      annotations: destructive(true),
    },
    ({ titles, sourceFolder, targetFolder }) =>
      guard(async () => {
        if (!exactlyOne(titles, sourceFolder)) {
          return errorResponse("Invalid arguments: Specify exactly one of titles or sourceFolder");
        }
        const result = await batchMove({ titles, sourceFolder, targetFolder });
        const sync = result.moved.length > 0
          ? await syncAfterBatchMove(result.moved.map((note) => note.id))
          : null;

        let message = `Moved ${result.moved.length} notes to "${targetFolder}".`;
        if (result.failed.length > 0) {
          message += `\nFailed to move: ${result.failed.join(", ")}`;
        }
        return textResponse(message + (sync ? syncWarning(sync) : ""));
      })
  );
}
