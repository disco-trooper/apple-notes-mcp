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

describe("delete key parsing", () => {
  it("should correctly parse folder and title from key", () => {
    const key = "Work/Projects/My Note";
    const lastSlash = key.lastIndexOf("/");
    const folder = key.substring(0, lastSlash);
    const title = key.substring(lastSlash + 1);

    expect(folder).toBe("Work/Projects");
    expect(title).toBe("My Note");
  });

  it("should handle simple folder/title", () => {
    const key = "Personal/My Note";
    const lastSlash = key.lastIndexOf("/");
    const folder = key.substring(0, lastSlash);
    const title = key.substring(lastSlash + 1);

    expect(folder).toBe("Personal");
    expect(title).toBe("My Note");
  });
});
