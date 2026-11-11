import { describe, it, expect } from "vitest";
import { escapeForFilter } from "./validation.js";

describe("escapeForFilter", () => {
  it("doubles single quotes", () => {
    expect(escapeForFilter("O'Brien's")).toBe("O''Brien''s");
  });

  it("leaves backslashes and control characters untouched (DataFusion reads them literally)", () => {
    expect(escapeForFilter("a\\b\nc\td")).toBe("a\\b\nc\td");
  });
});
