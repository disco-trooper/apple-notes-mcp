import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import "dotenv/config";

// Debug logging to stderr (never pollute stdout/MCP protocol)
const DEBUG = process.env.DEBUG === "true";
function debug(...args: unknown[]) {
  if (DEBUG) {
    console.error("[DEBUG]", ...args);
  }
}

// Tool parameter schemas
const SearchNotesSchema = z.object({
  query: z.string(),
  folder: z.string().optional(),
  limit: z.number().default(20),
  mode: z.enum(["hybrid", "keyword", "semantic"]).default("hybrid"),
  include_content: z.boolean().default(false),
});

const IndexNotesSchema = z.object({
  mode: z.enum(["full", "incremental"]).default("incremental"),
  force: z.boolean().default(false),
});

const ReindexNoteSchema = z.object({
  title: z.string(),
});

const GetNoteSchema = z.object({
  title: z.string(),
});

const CreateNoteSchema = z.object({
  title: z.string(),
  content: z.string(),
  folder: z.string().optional(),
});

const UpdateNoteSchema = z.object({
  title: z.string(),
  content: z.string(),
  reindex: z.boolean().default(true),
});

const DeleteNoteSchema = z.object({
  title: z.string(),
  confirm: z.boolean(),
});

const MoveNoteSchema = z.object({
  title: z.string(),
  folder: z.string(),
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
        // TODO: Implement search
        return textResponse(`[TODO] Search for: "${params.query}" (mode: ${params.mode})`);
      }

      case "index-notes": {
        const params = IndexNotesSchema.parse(args);
        // TODO: Implement indexing
        return textResponse(`[TODO] Index notes (mode: ${params.mode}, force: ${params.force})`);
      }

      case "reindex-note": {
        const params = ReindexNoteSchema.parse(args);
        // TODO: Implement single-note reindex
        return textResponse(`[TODO] Reindex note: "${params.title}"`);
      }

      case "list-notes": {
        // TODO: Implement count
        return textResponse(`[TODO] List notes count`);
      }

      case "get-note": {
        const params = GetNoteSchema.parse(args);
        // TODO: Implement get
        return textResponse(`[TODO] Get note: "${params.title}"`);
      }

      case "list-folders": {
        // TODO: Implement folder listing
        return textResponse(`[TODO] List folders`);
      }

      // Write tools
      case "create-note": {
        const params = CreateNoteSchema.parse(args);
        // TODO: Implement create
        return textResponse(`[TODO] Create note: "${params.title}"`);
      }

      case "update-note": {
        const params = UpdateNoteSchema.parse(args);
        // TODO: Implement update
        return textResponse(`[TODO] Update note: "${params.title}" (reindex: ${params.reindex})`);
      }

      case "delete-note": {
        const params = DeleteNoteSchema.parse(args);
        if (!params.confirm) {
          return errorResponse("Add confirm: true to delete the note");
        }
        // TODO: Implement delete
        return textResponse(`[TODO] Delete note: "${params.title}"`);
      }

      case "move-note": {
        const params = MoveNoteSchema.parse(args);
        // TODO: Implement move
        return textResponse(`[TODO] Move note: "${params.title}" to "${params.folder}"`);
      }

      default:
        return errorResponse(`Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ");
      return errorResponse(`Invalid arguments: ${issues}`);
    }
    throw error;
  }
});

// Start server
async function main() {
  debug("Starting apple-notes-mcp server...");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  debug("Server connected");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
