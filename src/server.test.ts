import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult, CompatibilityCallToolResult } from "@modelcontextprotocol/sdk/types.js";

vi.mock("./notes/read.js", () => ({
  getNoteByTitle: vi.fn(),
  getNoteById: vi.fn(),
  getAllFolders: vi.fn(),
  listNotes: vi.fn(),
}));
vi.mock("./notes/crud.js", () => ({
  createNote: vi.fn(),
  updateNote: vi.fn(),
  deleteNote: vi.fn(),
  moveNote: vi.fn(),
  editTable: vi.fn(),
  batchDelete: vi.fn(),
  batchMove: vi.fn(),
}));
vi.mock("./search/indexer.js", () => ({ indexNotes: vi.fn(), reindexNote: vi.fn() }));
vi.mock("./search/chunk-indexer.js", () => ({ hasChunkIndex: vi.fn() }));
vi.mock("./search/chunk-search.js", () => ({ searchChunks: vi.fn() }));
vi.mock("./search/refresh.js", () => ({ refreshIfNeeded: vi.fn().mockResolvedValue(false) }));
vi.mock("./search/write-sync.js", () => ({
  syncAfterCreate: vi.fn(),
  syncAfterUpdate: vi.fn(),
  syncAfterDelete: vi.fn(),
  syncAfterMove: vi.fn(),
  syncAfterBatchDelete: vi.fn(),
  syncAfterBatchMove: vi.fn(),
  syncAfterNoteChange: vi.fn(),
}));
vi.mock("./db/lancedb.js", () => ({ getVectorStore: vi.fn(), getChunkStore: vi.fn() }));
vi.mock("./indexing/job-manager.js", () => ({ getIndexJobManager: vi.fn() }));
vi.mock("./indexing/lock.js", () => ({
  withIndexLock: vi.fn((fn: () => Promise<unknown>) => fn()),
  isIndexLocked: vi.fn().mockReturnValue(false),
}));
vi.mock("./graph/queries.js", () => ({ listTags: vi.fn(), searchByTag: vi.fn(), findRelatedNotes: vi.fn() }));
vi.mock("./graph/export.js", () => ({ exportGraph: vi.fn() }));

import { createServer } from "./server.js";
import { getNoteById } from "./notes/read.js";
import { editTable } from "./notes/crud.js";
import { hasChunkIndex } from "./search/chunk-indexer.js";
import { searchChunks } from "./search/chunk-search.js";
import { getVectorStore } from "./db/lancedb.js";
import { getIndexJobManager } from "./indexing/job-manager.js";
import { listTags } from "./graph/queries.js";

const READ_TOOLS = [
  "search-notes",
  "index-notes",
  "start-index-job",
  "get-index-job",
  "list-index-jobs",
  "cancel-index-job",
  "reindex-note",
  "purge-index",
  "list-notes",
  "get-note",
  "get-tables",
  "list-folders",
  "list-tags",
  "search-by-tag",
  "related-notes",
  "export-graph",
];
const WRITE_TOOLS = [
  "create-note",
  "update-note",
  "delete-note",
  "move-note",
  "edit-table",
  "batch-delete",
  "batch-move",
];

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([createServer().connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function text(result: CompatibilityCallToolResult): string {
  if (!("content" in result)) throw new Error("callTool returned a legacy toolResult");
  const [first] = result.content as CallToolResult["content"];
  if (first?.type !== "text") throw new Error("expected a text content block");
  return first.text;
}

describe("MCP server", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv("READONLY_MODE", "false");
    client = await connect();
  });

  afterEach(async () => {
    await client.close();
    vi.unstubAllEnvs();
  });

  it("lists every tool with annotations and integer-typed index params", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
    expect(tools.every((t) => t.annotations !== undefined && t.title)).toBe(true);

    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("search-notes")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("delete-note")?.annotations?.destructiveHint).toBe(true);
    expect(byName.get("create-note")?.annotations?.destructiveHint).toBe(false);

    const editProps = byName.get("edit-table")?.inputSchema.properties as Record<string, { type?: string }>;
    expect(editProps.table_index.type).toBe("integer");
  });

  it("does not register Apple Notes write tools in read-only mode", async () => {
    vi.stubEnv("READONLY_MODE", "true");
    const readOnlyClient = await connect();
    const names = (await readOnlyClient.listTools()).tools.map((t) => t.name);
    await readOnlyClient.close();

    expect(names.sort()).toEqual([...READ_TOOLS].sort());
  });

  it("accepts calls without an arguments object for parameterless tools", async () => {
    vi.mocked(listTags).mockResolvedValue([]);
    const tags = await client.callTool({ name: "list-tags" });
    expect(tags.isError).toBeFalsy();
    expect(text(tags)).toContain("No tags found");

    vi.mocked(getVectorStore).mockReturnValue({ count: vi.fn().mockResolvedValue(7) } as never);
    vi.mocked(hasChunkIndex).mockResolvedValue(false);
    const stats = await client.callTool({ name: "list-notes" });
    expect(stats.isError).toBeFalsy();
    expect(text(stats)).toContain("7 notes indexed");
  });

  it("rejects non-integer indices with a readable validation error", async () => {
    const result = await client.callTool({
      name: "edit-table",
      arguments: { title: "Budget", edits: [{ row: 1.5, column: 0, value: "x" }] },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/integer/i);
    expect(text(result)).toContain("edits");
    expect(editTable).not.toHaveBeenCalled();
  });

  it("tells the user to index when there is no search index", async () => {
    vi.mocked(hasChunkIndex).mockResolvedValue(false);
    const result = await client.callTool({ name: "search-notes", arguments: { query: "budget" } });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("index-notes");
    expect(searchChunks).not.toHaveBeenCalled();
  });

  it("returns full note content for include_content and a preview otherwise", async () => {
    vi.mocked(hasChunkIndex).mockResolvedValue(true);
    vi.mocked(searchChunks).mockResolvedValue([
      {
        note_id: "n1",
        note_title: "Budget",
        folder: "Work",
        matchedChunk: "chunk text",
        matchedChunkIndex: 2,
        score: 0.5,
        modified: "2026-01-01T00:00:00Z",
      },
    ]);
    vi.mocked(getNoteById).mockResolvedValue({
      id: "n1",
      title: "Budget",
      folder: "Work",
      created: "",
      modified: "",
      content: "the whole note",
      htmlContent: "",
    });

    const full = JSON.parse(text(await client.callTool({
      name: "search-notes",
      arguments: { query: "budget", include_content: true },
    })));
    expect(full[0]).toMatchObject({ id: "n1", content: "the whole note" });
    expect(getNoteById).toHaveBeenCalledWith("n1");

    const preview = JSON.parse(text(await client.callTool({ name: "search-notes", arguments: { query: "budget" } })));
    expect(preview[0]).toMatchObject({ id: "n1", preview: "chunk text" });
    expect(preview[0].content).toBeUndefined();
  });

  it("reports a reused background job with its real mode", async () => {
    const job = { id: "job-1", mode: "incremental", status: "running", progress: { phase: "embed", percent: 40, message: "" } };
    vi.mocked(getIndexJobManager).mockReturnValue({ start: vi.fn().mockReturnValue({ job, reused: true }) } as never);

    const result = JSON.parse(text(await client.callTool({
      name: "index-notes",
      arguments: { mode: "full", background: true },
    })));

    expect(result.job_id).toBe("job-1");
    expect(result.message).toContain("already running (mode=incremental)");
  });
});
