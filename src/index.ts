import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import "dotenv/config";

// Import constants
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MAX_INPUT_LENGTH,
  MAX_TITLE_LENGTH
} from "./config/constants.js";
import { validateEnv } from "./config/env.js";

// Import implementations
import { getVectorStore } from "./db/lancedb.js";
import { getNoteByTitle, getAllFolders } from "./notes/read.js";
import { createNote, updateNote, deleteNote, moveNote, editTable } from "./notes/crud.js";
import { searchNotes } from "./search/index.js";
import { indexNotes, reindexNote } from "./search/indexer.js";

// Debug logging and error handling
import { createDebugLogger } from "./utils/debug.js";
import { sanitizeErrorMessage } from "./utils/errors.js";
const debug = createDebugLogger("MCP");

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
        name: "list-notes",
        description: "Count how many notes are indexed",
        inputSchema: {
          type: "object",
          properties: {},
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

        return textResponse(message);
      }

      case "reindex-note": {
        const params = ReindexNoteSchema.parse(args);
        await reindexNote(params.title);
        return textResponse(`Reindexed note: "${params.title}"`);
      }

      case "list-notes": {
        const store = getVectorStore();
        const count = await store.count();
        return textResponse(`${count} notes indexed. Run index-notes to update the index.`);
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
          created: note.created,
          modified: note.modified,
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
        await updateNote(params.title, params.content);

        if (params.reindex) {
          try {
            await reindexNote(params.title);
            return textResponse(`Updated and reindexed note: "${params.title}"`);
          } catch (reindexError) {
            debug("Reindex after update failed:", reindexError);
            return textResponse(`Updated note: "${params.title}" (reindexing failed, run index-notes to update)`);
          }
        }

        return textResponse(`Updated note: "${params.title}"`);
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
