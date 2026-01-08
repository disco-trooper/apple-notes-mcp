import { describe, it, expect } from "vitest";
import { extractTitleFromKey } from "./indexer.js";

describe("extractTitleFromKey", () => {
  it("extracts title from simple folder/title key", () => {
    expect(extractTitleFromKey("Work/My Note")).toBe("My Note");
  });

  it("extracts title from nested folder key", () => {
    expect(extractTitleFromKey("Work/Projects/My Note")).toBe("My Note");
  });

  it("extracts title from deeply nested folder key", () => {
    expect(extractTitleFromKey("Personal/Archive/2024/January/Meeting Notes")).toBe("Meeting Notes");
  });

  it("handles single segment (no folder)", () => {
    expect(extractTitleFromKey("My Note")).toBe("My Note");
  });
});
