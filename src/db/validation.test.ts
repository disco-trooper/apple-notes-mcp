import { describe, it, expect } from "vitest";
import { validateTitle, escapeForFilter } from "./validation.js";

describe("validateTitle", () => {
  it("accepts valid titles", () => {
    expect(validateTitle("My Note")).toBe("My Note");
    expect(validateTitle("  Trimmed  ")).toBe("Trimmed");
    expect(validateTitle("Note with numbers 123")).toBe("Note with numbers 123");
    expect(validateTitle("Unicode: cestina 日本語")).toBe("Unicode: cestina 日本語");
  });

  it("rejects empty titles", () => {
    expect(() => validateTitle("")).toThrow("non-empty");
    expect(() => validateTitle("   ")).toThrow("empty or whitespace");
  });

  it("rejects very long titles", () => {
    const longTitle = "a".repeat(501);
    expect(() => validateTitle(longTitle)).toThrow("maximum length");
  });

  it("rejects invalid characters", () => {
    expect(() => validateTitle("Note\x00with\x00null")).toThrow("invalid characters");
  });
});

describe("escapeForFilter", () => {
  it("escapes single quotes", () => {
    expect(escapeForFilter("O'Brien")).toBe("O''Brien");
  });

  it("escapes backslashes", () => {
    expect(escapeForFilter("path\\to\\note")).toBe("path\\\\to\\\\note");
  });

  it("escapes newlines and tabs", () => {
    expect(escapeForFilter("line1\nline2")).toBe("line1\\nline2");
    expect(escapeForFilter("col1\tcol2")).toBe("col1\\tcol2");
  });

  it("handles combined escapes", () => {
    expect(escapeForFilter("O'Brien's\nnote")).toBe("O''Brien''s\\nnote");
  });
});
