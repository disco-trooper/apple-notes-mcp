// src/graph/export.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { exportGraph, type GraphData } from "./export.js";
import { GRAPH_TAG_CLIQUE_MAX } from "../config/constants.js";

const mockStore = {
  getAllMetadata: vi.fn(),
};

vi.mock("../db/lancedb.js", () => ({
  getVectorStore: vi.fn(() => mockStore),
}));

type Row = { id: string; title: string; folder?: string; tags?: string[]; outlinks?: string[] };

function useRows(rows: Row[]): void {
  mockStore.getAllMetadata.mockResolvedValue(rows.map((r) => ({ folder: "Work", tags: [], outlinks: [], ...r })));
}

describe("exportGraph", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("JSON format", () => {
    it("exports nodes, link edges and tag edges", async () => {
      useRows([
        { id: "1", title: "Note A", tags: ["project"], outlinks: ["note b"] },
        { id: "2", title: "Note B", tags: ["project"] },
      ]);

      const result = (await exportGraph({ format: "json" })) as GraphData;

      expect(result.nodes).toHaveLength(2);
      expect(result.edges).toEqual([
        { source: "1", target: "2", type: "link", weight: expect.any(Number) },
        { source: "1", target: "2", type: "tag", weight: expect.any(Number) },
      ]);
    });

    it("filters by folder and drops links leaving the folder", async () => {
      useRows([
        { id: "1", title: "Note A", folder: "Work", outlinks: ["Note B"] },
        { id: "2", title: "Note B", folder: "Personal" },
      ]);

      const result = (await exportGraph({ format: "json", folder: "work" })) as GraphData;

      expect(result.nodes.map((n) => n.id)).toEqual(["1"]);
      expect(result.edges).toEqual([]);
    });

    it("keeps tag edges for distinct pairs whose ids contain '-'", async () => {
      useRows([
        { id: "a-b", title: "1", tags: ["t1"] },
        { id: "c", title: "2", tags: ["t1"] },
        { id: "a", title: "3", tags: ["t2"] },
        { id: "b-c", title: "4", tags: ["t2"] },
      ]);

      const result = (await exportGraph({ format: "json" })) as GraphData;

      expect(result.edges.filter((e) => e.type === "tag")).toHaveLength(2);
    });

    it("emits one tag edge per pair even when notes share several tags", async () => {
      useRows([
        { id: "1", title: "A", tags: ["x", "y"] },
        { id: "2", title: "B", tags: ["y", "x"] },
      ]);

      const result = (await exportGraph({ format: "json" })) as GraphData;

      expect(result.edges).toHaveLength(1);
    });

    it("links large tag groups as a star instead of all pairs", async () => {
      const n = GRAPH_TAG_CLIQUE_MAX + 5;
      useRows(Array.from({ length: n }, (_, i) => ({ id: `n${i}`, title: `T${i}`, tags: ["common"] })));

      const result = (await exportGraph({ format: "json" })) as GraphData;

      expect(result.edges).toHaveLength(n - 1);
    });
  });

  describe("GraphML format", () => {
    it("exports GraphML with directed link edges and undirected tag edges", async () => {
      useRows([
        { id: "1", title: "Note A", tags: ["t"], outlinks: ["Note B"] },
        { id: "2", title: "Note B", tags: ["t"] },
      ]);

      const result = (await exportGraph({ format: "graphml" })) as string;

      expect(result).toContain('<?xml version="1.0"');
      expect(result).toContain('<graph id="G" edgedefault="directed">');
      expect(result).toContain('<edge source="1" target="2">');
      expect(result).toContain('<edge source="1" target="2" directed="false">');
      expect(result).toContain("</graphml>");
    });

    it("escapes special XML characters", async () => {
      useRows([{ id: "1", title: 'Note <with> & "special"' }]);
      const result = (await exportGraph({ format: "graphml" })) as string;
      expect(result).toContain("Note &lt;with&gt; &amp; &quot;special&quot;");
    });
  });

  it("throws for unknown format", async () => {
    useRows([]);
    await expect(exportGraph({ format: "unknown" as never })).rejects.toThrow("Unknown format");
  });
});
