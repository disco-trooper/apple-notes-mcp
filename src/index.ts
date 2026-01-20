#!/usr/bin/env bun
import { hasConfig, getEnvPath } from "./config/paths.js";
import { checkBunRuntime, isTTY } from "./utils/runtime.js";
import * as dotenv from "dotenv";

// Load config from unified location
dotenv.config({ path: getEnvPath() });

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// Import constants
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MAX_INPUT_LENGTH,
  MAX_TITLE_LENGTH
} from "./config/constants.js";
import { validateEnv } from "./config/env.js";

// Import implementations
import { getVectorStore, getChunkStore } from "./db/lancedb.js";
import { getNoteByTitle, getAllFolders, listNotes } from "./notes/read.js";
import { createNote, updateNote, deleteNote, moveNote, editTable, batchDelete, batchMove } from "./notes/crud.js";
import { searchNotes } from "./search/index.js";
import { indexNotes, reindexNote } from "./search/indexer.js";
import { fullChunkIndex, hasChunkIndex } from "./search/chunk-indexer.js";
import { searchChunks } from "./search/chunk-search.js";
import { refreshIfNeeded } from "./search/refresh.js";
import { listTags, searchByTag, findRelatedNotes } from "./graph/queries.js";
import { exportGraph } from "./graph/export.js";
import { findTables, parseTable } from "./notes/tables.js";

// Debug logging and error handling
import { createDebugLogger } from "./utils/debug.js";
import { sanitizeErrorMessage } from "./utils/errors.js";
const debug = createDebugLogger("MCP");

// Runtime and config checks
checkBunRuntime();

if (!hasConfig()) {
  if (isTTY()) {
    // Interactive terminal - run setup wizard
    console.log("No configuration found. Starting setup wizard...\n");
    const { spawn } = await import("node:child_process");
    const setupPath = new URL("./setup.ts", import.meta.url).pathname;
    const child = spawn("bun", ["run", setupPath], {
      stdio: "inherit",
    });
    child.on("exit", (code) => process.exit(code ?? 0));
    // Wait for setup to complete
    await new Promise(() => {}); // Setup will exit the process
  } else {
    // Non-interactive (MCP server mode) - show error
    console.error(`
╭─────────────────────────────────────────────────────────────╮
│  apple-notes-mcp: Configuration required                    │
│                                                             │
│  Run this command in your terminal first:                   │
│                                                             │
│      apple-notes-mcp                                        │
│                                                             │
│  The setup wizard will guide you through configuration.     │
╰─────────────────────────────────────────────────────────────╯
`);
    process.exit(1);
  }
}

// Tool parameter schemas
const SearchNotesSchema = z.object({
  query: z.string().min(1, "Query cannot be empty").max(MAX_INPUT_LENGTH),
  folder: z.string().max(200).optional(),
  limit: z.number().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_SEARCH_LIMIT),
  mode: z.enum(["hybrid", "keyword", "semantic"]).default("hybrid"),
  include_content: z.boolean().default(false),
});

const IndexNotesSchema = z.object({
  mode: z.enum(["full", "incremental"]).default("incremental"),
  force: z.boolean().default(false),
});

const ReindexNoteSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
});

const GetNoteSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
  include_html: z.boolean().default(false),
});

const GetTablesSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
});

const CreateNoteSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
  content: z.string().min(1).max(MAX_INPUT_LENGTH),
  folder: z.string().max(200).optional(),
});

const UpdateNoteSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
  content: z.string().min(1).max(MAX_INPUT_LENGTH),
  reindex: z.boolean().default(true),
});

const DeleteNoteSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
  confirm: z.boolean(),
});

const MoveNoteSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
  folder: z.string().min(1).max(200),
});

const EditTableSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
  table_index: z.number().min(0).default(0),
  edits: z.array(z.object({
    row: z.number().min(0),
    column: z.number().min(0),
    value: z.string().max(10000),
  })).min(1).max(100),
});

const BatchDeleteSchema = z.object({
  titles: z.array(z.string().max(MAX_TITLE_LENGTH)).optional(),
  folder: z.string().max(200).optional(),
  confirm: z.literal(true),
}).refine(
  (data) => (data.titles && !data.folder) || (!data.titles && data.folder),
  { message: "Specify either titles or folder, not both" }
);

const BatchMoveSchema = z.object({
  titles: z.array(z.string().max(MAX_TITLE_LENGTH)).optional(),
  sourceFolder: z.string().max(200).optional(),
  targetFolder: z.string().min(1).max(200),
}).refine(
  (data) => (data.titles && !data.sourceFolder) || (!data.titles && data.sourceFolder),
  { message: "Specify either titles or sourceFolder, not both" }
);

const PurgeIndexSchema = z.object({
  confirm: z.literal(true),
});

const ListNotesSchema = z.object({
  sort_by: z.enum(["created", "modified", "title"]).default("modified"),
  order: z.enum(["asc", "desc"]).default("desc"),
  limit: z.number().min(1).max(100).optional(),
  folder: z.string().max(200).optional(),
});

/** Exported type for listNotes options - derived from Zod schema (single source of truth)
 * Using z.input to get the input type (with optionals) rather than z.infer (output with defaults applied) */
export type ListNotesOptions = z.input<typeof ListNotesSchema>;

// Knowledge Graph tool schemas
const ListTagsSchema = z.object({});

const SearchByTagSchema = z.object({
  tag: z.string().min(1).max(100),
  folder: z.string().max(200).optional(),
  limit: z.number().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_SEARCH_LIMIT),
});

const RelatedNotesSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
  types: z.array(z.enum(["tag", "link", "similar"])).default(["tag", "link", "similar"]),
  limit: z.number().min(1).max(50).default(10),
});

const ExportGraphSchema = z.object({
  format: z.enum(["json", "graphml"]),
  folder: z.string().max(200).optional(),
});

// Create MCP server
const server = new Server(
  {
    name: "apple-notes-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Helper to create text responses
function textResponse(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

function errorResponse(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

// Register tool list
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      // Read tools
      {
        name: "search-notes",
        description: "Search notes using hybrid vector + fulltext search",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            folder: { type: "string", description: "Filter by folder (optional)" },
            limit: { type: "number", description: "Max results (default: 20)" },
            mode: {
              type: "string",
              enum: ["hybrid", "keyword", "semantic"],
              description: "Search mode (default: hybrid)"
            },
            include_content: {
              type: "boolean",
              description: "Include full content instead of preview (default: false)"
            },
          },
          required: ["query"],
        },
      },
      {
        name: "index-notes",
        description: "Index all notes for semantic search. Use mode='incremental' (default) to only process changed notes.",
        inputSchema: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["full", "incremental"],
              description: "full = reindex everything, incremental = only changes (default)"
            },
            force: {
              type: "boolean",
              description: "Force reindex even if TTL hasn't expired (default: false)"
            },
          },
          required: [],
        },
      },
      {
        name: "reindex-note",
        description: "Re-index a single note after manual edits",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Note title (use folder/title for disambiguation)" },
          },
          required: ["title"],
        },
      },
      {
        name: "purge-index",
        description: "Delete all indexed data (notes and chunks). Use when switching embedding models or to fix corrupted index.",
        inputSchema: {
          type: "object",
          properties: {
            confirm: { type: "boolean", description: "Must be true to confirm deletion" },
          },
          required: ["confirm"],
        },
      },
      {
        name: "list-notes",
        description: "List notes from Apple Notes with sorting and filtering. Without parameters, shows index statistics.",
        inputSchema: {
          type: "object",
          properties: {
            sort_by: {
              type: "string",
              enum: ["created", "modified", "title"],
              description: "Sort by date or title (default: modified)"
            },
            order: {
              type: "string",
              enum: ["asc", "desc"],
              description: "Sort order (default: desc)"
            },
            limit: {
              type: "number",
              description: "Max notes to return (1-100)"
            },
            folder: {
              type: "string",
              description: "Filter by folder"
            },
          },
          required: [],
        },
      },
      {
        name: "get-note",
        description: "Get full content of a note by title",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Note title (use folder/title for disambiguation)" },
            include_html: { type: "boolean", description: "Include raw HTML content (default: false)" },
          },
          required: ["title"],
        },
      },
      {
        name: "get-tables",
        description: "Get parsed table data from a note. Returns structured table content with rows and formatting.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Note title (use folder/title for disambiguation)" },
          },
          required: ["title"],
        },
      },
      {
        name: "list-folders",
        description: "List all folders in Apple Notes",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      // Write tools
      {
        name: "create-note",
        description: "Create a new note in Apple Notes",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Note title" },
            content: { type: "string", description: "Note content (Markdown)" },
            folder: { type: "string", description: "Target folder (optional, defaults to Notes)" },
          },
          required: ["title", "content"],
        },
      },
      {
        name: "update-note",
        description: "Update an existing note",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Note title (use folder/title for disambiguation)" },
            content: { type: "string", description: "New content (Markdown)" },
            reindex: { type: "boolean", description: "Re-embed after update (default: true)" },
          },
          required: ["title", "content"],
        },
      },
      {
        name: "delete-note",
        description: "Delete a note (requires confirm: true for safety)",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Note title (use folder/title for disambiguation)" },
            confirm: { type: "boolean", description: "Must be true to confirm deletion" },
          },
          required: ["title", "confirm"],
        },
      },
      {
        name: "move-note",
        description: "Move a note to a different folder",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Note title (use folder/title for disambiguation)" },
            folder: { type: "string", description: "Target folder" },
          },
          required: ["title", "folder"],
        },
      },
      {
        name: "edit-table",
        description: "Edit cells in a table within a note. Use for updating table data without rewriting the entire note.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Note title (use folder/title for disambiguation)" },
            table_index: { type: "number", description: "Which table to edit (0 = first table, default: 0)" },
            edits: {
              type: "array",
              description: "Array of cell edits",
              items: {
                type: "object",
                properties: {
                  row: { type: "number", description: "Row index (0 = header row)" },
                  column: { type: "number", description: "Column index (0 = first column)" },
                  value: { type: "string", description: "New cell value" },
                },
                required: ["row", "column", "value"],
              },
            },
          },
          required: ["title", "edits"],
        },
      },
      {
        name: "batch-delete",
        description: "Delete multiple notes at once. Requires confirm: true for safety.",
        inputSchema: {
          type: "object",
          properties: {
            titles: {
              type: "array",
              items: { type: "string" },
              description: "Note titles to delete (supports folder/title and id:xxx formats)",
            },
            folder: {
              type: "string",
              description: "Delete ALL notes in this folder",
            },
            confirm: {
              type: "boolean",
              description: "Must be true to confirm deletion",
            },
          },
          required: ["confirm"],
        },
      },
      {
        name: "batch-move",
        description: "Move multiple notes to a target folder at once.",
        inputSchema: {
          type: "object",
          properties: {
            titles: {
              type: "array",
              items: { type: "string" },
              description: "Note titles to move (supports folder/title and id:xxx formats)",
            },
            sourceFolder: {
              type: "string",
              description: "Move ALL notes from this folder",
            },
            targetFolder: {
              type: "string",
              description: "Target folder to move notes to",
            },
          },
          required: ["targetFolder"],
        },
      },
      // Knowledge Graph tools
      {
        name: "list-tags",
        description: "List all tags with occurrence counts",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "search-by-tag",
        description: "Find notes with a specific tag",
        inputSchema: {
          type: "object",
          properties: {
            tag: { type: "string", description: "Tag to search for (without #)" },
            folder: { type: "string", description: "Filter by folder (optional)" },
            limit: { type: "number", description: "Max results (default: 20)" },
          },
          required: ["tag"],
        },
      },
      {
        name: "related-notes",
        description: "Find notes related to a source note by tags, links, or semantic similarity",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Source note title (use folder/title or id:xxx)" },
            types: {
              type: "array",
              items: { type: "string", enum: ["tag", "link", "similar"] },
              description: "Relationship types to include (default: all)"
            },
            limit: { type: "number", description: "Max results (default: 10)" },
          },
          required: ["title"],
        },
      },
      {
        name: "export-graph",
        description: "Export knowledge graph to JSON or GraphML format for visualization",
        inputSchema: {
          type: "object",
          properties: {
            format: {
              type: "string",
              enum: ["json", "graphml"],
              description: "Export format: json (for D3.js, custom viz) or graphml (for Gephi, yEd)"
            },
            folder: { type: "string", description: "Filter by folder (optional)" },
          },
          required: ["format"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  debug(`Tool called: ${name}`, args);

  try {
    switch (name) {
      // Read tools
      case "search-notes": {
        const params = SearchNotesSchema.parse(args);

        // Smart refresh: check for changes before search
        const refreshed = await refreshIfNeeded();
        if (refreshed) {
          debug("Index refreshed before search");
        }

        // Use chunk-based search if chunk index exists (better for long notes)
        const useChunkSearch = await hasChunkIndex();

        if (useChunkSearch) {
          debug("Using chunk-based search");
          const chunkResults = await searchChunks(params.query, {
            folder: params.folder,
            limit: params.limit,
            mode: params.mode,
          });

          if (chunkResults.length === 0) {
            return textResponse("No notes found matching your query.");
          }

          // Transform chunk results to match expected format
          const results = chunkResults.map((r) => ({
            id: r.note_id,
            title: r.note_title,
            folder: r.folder,
            preview: r.matchedChunk.slice(0, 200) + (r.matchedChunk.length > 200 ? "..." : ""),
            modified: r.modified,
            score: r.score,
            matchedChunkIndex: r.matchedChunkIndex,
          }));

          return textResponse(JSON.stringify(results, null, 2));
        }

        // Fall back to legacy search if no chunk index
        debug("Using legacy search (no chunk index)");
        const results = await searchNotes(params.query, {
          folder: params.folder,
          limit: params.limit,
          mode: params.mode,
          include_content: params.include_content,
        });

        if (results.length === 0) {
          return textResponse("No notes found matching your query.");
        }

        return textResponse(JSON.stringify(results, null, 2));
      }

      case "index-notes": {
        const params = IndexNotesSchema.parse(args);
        const result = await indexNotes(params.mode);

        let message = `Indexed ${result.indexed} notes in ${(result.timeMs / 1000).toFixed(1)}s`;

        if (result.breakdown) {
          message += ` (added: ${result.breakdown.added}, updated: ${result.breakdown.updated}, deleted: ${result.breakdown.deleted}, skipped: ${result.breakdown.skipped})`;
        }

        if (result.errors > 0) {
          message += `\n${result.errors} errors occurred.`;
          if (result.failedNotes && result.failedNotes.length > 0) {
            message += `\nFailed notes:\n${result.failedNotes.map(n => `  - ${n}`).join("\n")}`;
          }
        }

        // Run chunk indexing for full mode (for semantic search on long notes)
        if (params.mode === "full") {
          debug("Running chunk indexing for full mode...");
          const chunkResult = await fullChunkIndex();
          message += `\nChunk index: ${chunkResult.totalChunks} chunks from ${chunkResult.totalNotes} notes in ${(chunkResult.timeMs / 1000).toFixed(1)}s`;
        }

        return textResponse(message);
      }

      case "reindex-note": {
        const params = ReindexNoteSchema.parse(args);
        await reindexNote(params.title);
        return textResponse(`Reindexed note: "${params.title}"`);
      }

      case "purge-index": {
        PurgeIndexSchema.parse(args);
        const store = getVectorStore();
        const chunkStore = getChunkStore();

        await store.clear();
        await chunkStore.clear();

        return textResponse("Index purged. Run index-notes to rebuild.");
      }

      case "list-notes": {
        const params = ListNotesSchema.parse(args);

        // No parameters provided: show index statistics (backwards compatible)
        const hasFilteringParams =
          params.limit !== undefined ||
          params.folder !== undefined ||
          (args && ("sort_by" in args || "order" in args));

        if (!hasFilteringParams) {
          const store = getVectorStore();
          const noteCount = await store.count();
          const hasChunks = await hasChunkIndex();

          if (hasChunks) {
            const chunkStore = getChunkStore();
            const chunkCount = await chunkStore.count();
            return textResponse(
              `${noteCount} notes indexed. ${chunkCount} chunks indexed for semantic search.`
            );
          }

          return textResponse(
            `${noteCount} notes indexed. Run index-notes with mode='full' to enable chunk-based search.`
          );
        }

        const notes = await listNotes(params);
        return textResponse(JSON.stringify(notes, null, 2));
      }

      case "get-note": {
        const params = GetNoteSchema.parse(args);
        const note = await getNoteByTitle(params.title);

        if (!note) {
          return errorResponse(`Note not found: "${params.title}"`);
        }

        return textResponse(JSON.stringify({
          title: note.title,
          folder: note.folder,
          content: note.content,
          ...(params.include_html && { htmlContent: note.htmlContent }),
          created: note.created,
          modified: note.modified,
        }, null, 2));
      }

      case "get-tables": {
        const params = GetTablesSchema.parse(args);
        const note = await getNoteByTitle(params.title);

        if (!note) {
          return errorResponse(`Note not found: "${params.title}"`);
        }

        const tables = findTables(note.htmlContent);
        const parsedTables = tables.map((html, index) => ({
          index,
          ...parseTable(html),
        }));

        return textResponse(JSON.stringify({
          title: note.title,
          folder: note.folder,
          tableCount: tables.length,
          tables: parsedTables.map((t) => ({
            index: t.index,
            rows: t.rows,
            formatting: t.formatting,
          })),
        }, null, 2));
      }

      case "list-folders": {
        const folders = await getAllFolders();
        return textResponse(JSON.stringify(folders, null, 2));
      }

      // Write tools
      case "create-note": {
        const params = CreateNoteSchema.parse(args);
        await createNote(params.title, params.content, params.folder);
        const location = params.folder ? `${params.folder}/${params.title}` : params.title;
        return textResponse(`Created note: "${location}"`);
      }

      case "update-note": {
        const params = UpdateNoteSchema.parse(args);
        const result = await updateNote(params.title, params.content);

        // Build location string for messages
        const location = `${result.folder}/${result.newTitle}`;
        const renamedMsg = result.titleChanged
          ? ` (renamed from "${result.originalTitle}")`
          : "";

        if (params.reindex) {
          try {
            // Use new title for reindexing (Apple Notes may have renamed it)
            const reindexTitle = `${result.folder}/${result.newTitle}`;
            await reindexNote(reindexTitle);
            return textResponse(`Updated and reindexed note: "${location}"${renamedMsg}`);
          } catch (reindexError) {
            debug("Reindex after update failed:", reindexError);
            return textResponse(`Updated note: "${location}"${renamedMsg} (reindexing failed, run index-notes to update)`);
          }
        }

        return textResponse(`Updated note: "${location}"${renamedMsg}`);
      }

      case "delete-note": {
        const params = DeleteNoteSchema.parse(args);
        if (!params.confirm) {
          return errorResponse("Add confirm: true to delete the note");
        }
        await deleteNote(params.title);
        return textResponse(`Deleted note: "${params.title}"`);
      }

      case "move-note": {
        const params = MoveNoteSchema.parse(args);
        await moveNote(params.title, params.folder);
        return textResponse(`Moved note: "${params.title}" to folder "${params.folder}"`);
      }

      case "edit-table": {
        const params = EditTableSchema.parse(args);
        await editTable(params.title, params.table_index, params.edits);
        return textResponse(`Updated ${params.edits.length} cell(s) in table ${params.table_index}`);
      }

      case "batch-delete": {
        const params = BatchDeleteSchema.parse(args);
        const result = await batchDelete({
          titles: params.titles,
          folder: params.folder,
        });

        let message = `Deleted ${result.deleted} notes.`;
        if (result.failed.length > 0) {
          message += `\nFailed to delete: ${result.failed.join(", ")}`;
        }
        return textResponse(message);
      }

      case "batch-move": {
        const params = BatchMoveSchema.parse(args);
        const result = await batchMove({
          titles: params.titles,
          sourceFolder: params.sourceFolder,
          targetFolder: params.targetFolder,
        });

        let message = `Moved ${result.moved} notes to "${params.targetFolder}".`;
        if (result.failed.length > 0) {
          message += `\nFailed to move: ${result.failed.join(", ")}`;
        }
        return textResponse(message);
      }

      // Knowledge Graph tools
      case "list-tags": {
        ListTagsSchema.parse(args);
        const tags = await listTags();

        if (tags.length === 0) {
          return textResponse("No tags found. Add #tags to your notes and reindex.");
        }

        return textResponse(JSON.stringify(tags, null, 2));
      }

      case "search-by-tag": {
        const params = SearchByTagSchema.parse(args);
        const results = await searchByTag(params.tag, {
          folder: params.folder,
          limit: params.limit,
        });

        if (results.length === 0) {
          return textResponse(`No notes found with tag: #${params.tag}`);
        }

        return textResponse(JSON.stringify(results, null, 2));
      }

      case "related-notes": {
        const params = RelatedNotesSchema.parse(args);

        // Resolve note to get ID
        const note = await getNoteByTitle(params.title);
        if (!note) {
          return errorResponse(`Note not found: "${params.title}"`);
        }

        const results = await findRelatedNotes(note.id, {
          types: params.types,
          limit: params.limit,
        });

        if (results.length === 0) {
          return textResponse("No related notes found.");
        }

        return textResponse(JSON.stringify(results, null, 2));
      }

      case "export-graph": {
        const params = ExportGraphSchema.parse(args);
        const result = await exportGraph({
          format: params.format,
          folder: params.folder,
        });

        if (typeof result === "string") {
          return textResponse(result);
        }

        return textResponse(JSON.stringify(result, null, 2));
      }

      default:
        return errorResponse(`Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ");
      return errorResponse(`Invalid arguments: ${issues}`);
    }

    // Handle other errors gracefully
    const rawMessage = error instanceof Error ? error.message : String(error);
    debug("Tool error:", error);
    return errorResponse(sanitizeErrorMessage(rawMessage));
  }
});

// Start server
async function main() {
  // Validate environment variables before anything else
  validateEnv();

  debug("Starting apple-notes-mcp server...");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  debug("Server connected");
}

main().catch((error) => {
  const rawMessage = error instanceof Error ? error.message : String(error);
  console.error("Fatal error:", sanitizeErrorMessage(rawMessage));
  process.exit(1);
});
