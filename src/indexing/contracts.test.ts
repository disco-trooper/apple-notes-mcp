import { describe, it, expect } from "vitest";
import { IndexCancelledError, isIndexCancelledError } from "./contracts.js";

describe("indexing contracts", () => {
  it("creates cancellable error type", () => {
    const err = new IndexCancelledError("user requested cancel");
    expect(isIndexCancelledError(err)).toBe(true);
  });

  it("does not treat generic Error as cancelled", () => {
    expect(isIndexCancelledError(new Error("x"))).toBe(false);
  });
});
