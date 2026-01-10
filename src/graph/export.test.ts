// src/graph/export.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { exportGraph } from "./export.js";

// Create a shared mock store instance
const mockStore = {
  getAll: vi.fn(),
};

vi.mock("../db/lancedb.js", () => ({
  getVectorStore: vi.fn(() => mockStore),
}));

describe("exportGraph", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("JSON format", () => {
    it("exports nodes and edges", async () => {
      mockStore.getAll.mockResolvedValue([
        { id: "1", title: "Note A", folder: "Work", tags: ["project"], outlinks: ["Note B"], vector: [1,0] },
        { id: "2", title: "Note B", folder: "Work", tags: ["project"], outlinks: [], vector: [0,1] },
      ]);

      const result = await exportGraph({ format: "json" }) as any;

      expect(result).toHaveProperty("nodes");
      expect(result).toHaveProperty("edges");
      expect(result.nodes).toHaveLength(2);
      expect(result.edges.some((e: any) => e.type === "link")).toBe(true);
      expect(result.edges.some((e: any) => e.type === "tag")).toBe(true);
    });

    it("filters by folder", async () => {
      mockStore.getAll.mockResolvedValue([
        { id: "1", title: "Note A", folder: "Work", tags: [], outlinks: [], vector: [] },
        { id: "2", title: "Note B", folder: "Personal", tags: [], outlinks: [], vector: [] },
      ]);

      const result = await exportGraph({ format: "json", folder: "Work" }) as any;

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].folder).toBe("Work");
    });
  });

  describe("GraphML format", () => {
    it("exports valid GraphML XML", async () => {
      mockStore.getAll.mockResolvedValue([
        { id: "1", title: "Note A", folder: "Work", tags: [], outlinks: ["Note B"], vector: [] },
        { id: "2", title: "Note B", folder: "Work", tags: [], outlinks: [], vector: [] },
      ]);

      const result = await exportGraph({ format: "graphml" });

      expect(typeof result).toBe("string");
      expect(result).toContain('<?xml version="1.0"');
      expect(result).toContain("<graphml");
      expect(result).toContain("<node");
      expect(result).toContain("<edge");
      expect(result).toContain("</graphml>");
    });

    it("escapes special XML characters in GraphML", async () => {
      mockStore.getAll.mockResolvedValue([
        { id: "1", title: 'Note <with> & "special"', folder: "Work", tags: [], outlinks: [], vector: [] },
      ]);
      const result = await exportGraph({ format: "graphml" }) as string;
      expect(result).toContain("&lt;with&gt;");
      expect(result).toContain("&amp;");
    });
  });

  describe("Unknown format", () => {
    it("throws for unknown format", async () => {
      mockStore.getAll.mockResolvedValue([]);
      await expect(exportGraph({ format: "unknown" as any })).rejects.toThrow("Unknown format");
    });
  });
});
