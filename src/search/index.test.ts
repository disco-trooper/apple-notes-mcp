import { describe, it, expect } from "vitest";
import { rrfScore, generatePreview, filterByFolder } from "./index.js";
import type { DBSearchResult } from "../types/index.js";

describe("rrfScore", () => {
  it("calculates RRF score correctly", () => {
    // RRF formula: 1 / (k + rank) where k = 60
    expect(rrfScore(1)).toBeCloseTo(1 / 61, 5);
    expect(rrfScore(10)).toBeCloseTo(1 / 70, 5);
  });

  it("returns smaller scores for higher ranks", () => {
    expect(rrfScore(1)).toBeGreaterThan(rrfScore(10));
    expect(rrfScore(10)).toBeGreaterThan(rrfScore(100));
  });
});

describe("generatePreview", () => {
  it("returns full text if shorter than limit", () => {
    expect(generatePreview("Short text")).toBe("Short text");
  });

  it("truncates long text with ellipsis", () => {
    const text = "a".repeat(300);
    const preview = generatePreview(text);
    expect(preview.length).toBeLessThanOrEqual(203);
    expect(preview).toMatch(/\.\.\.$/);
  });

  it("handles empty content", () => {
    expect(generatePreview("")).toBe("");
  });
});

describe("filterByFolder", () => {
  const mockResults: DBSearchResult[] = [
    { title: "Note 1", folder: "Work", content: "content", score: 1, modified: "2024-01-01" },
    { title: "Note 2", folder: "Personal", content: "content", score: 0.9, modified: "2024-01-01" },
    { title: "Note 3", folder: "Work/Projects", content: "content", score: 0.8, modified: "2024-01-01" },
  ];

  it("filters by exact folder name", () => {
    const filtered = filterByFolder(mockResults, "Work");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].title).toBe("Note 1");
  });

  it("returns all results when folder is undefined", () => {
    const filtered = filterByFolder(mockResults, undefined);
    expect(filtered).toHaveLength(3);
  });
});
