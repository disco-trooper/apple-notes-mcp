import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { LanceDBStore } from "./lancedb.js";

describe("Arrow type inference fix", () => {
  let tempDir: string;
  let store: LanceDBStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "arrow-test-"));
    store = new LanceDBStore(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("handles records where ALL tags and outlinks are empty", async () => {
    // This is the exact scenario that triggers the Arrow bug
    const records = [
      {
        id: "1",
        title: "Note 1",
        content: "Hello world",
        vector: new Array(384).fill(0.1),
        folder: "Notes",
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        indexed_at: new Date().toISOString(),
        tags: [],  // Empty!
        outlinks: [],  // Empty!
      },
      {
        id: "2",
        title: "Note 2",
        content: "Test content",
        vector: new Array(384).fill(0.2),
        folder: "Notes",
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        indexed_at: new Date().toISOString(),
        tags: [],  // Empty!
        outlinks: [],  // Empty!
      },
    ];

    // This should NOT throw "Cannot infer list vector from empty array"
    await store.index(records);

    // Verify data was stored
    const count = await store.count();
    expect(count).toBe(2);

    // Verify tags are empty (placeholders removed)
    const all = await store.getAll();
    expect(all[0].tags).toEqual([]);
    expect(all[0].outlinks).toEqual([]);
  });

  it("handles mixed empty and non-empty arrays", async () => {
    const records = [
      {
        id: "1",
        title: "Note with tags",
        content: "Hello",
        vector: new Array(384).fill(0.1),
        folder: "Notes",
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        indexed_at: new Date().toISOString(),
        tags: ["tag1", "tag2"],
        outlinks: [],
      },
      {
        id: "2",
        title: "Note without tags",
        content: "World",
        vector: new Array(384).fill(0.2),
        folder: "Notes",
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        indexed_at: new Date().toISOString(),
        tags: [],
        outlinks: ["Note 1"],
      },
    ];

    await store.index(records);

    const all = await store.getAll();
    const note1 = all.find(n => n.id === "1");
    const note2 = all.find(n => n.id === "2");

    expect(note1?.tags).toEqual(["tag1", "tag2"]);
    expect(note1?.outlinks).toEqual([]);
    expect(note2?.tags).toEqual([]);
    expect(note2?.outlinks).toEqual(["Note 1"]);
  });
});
