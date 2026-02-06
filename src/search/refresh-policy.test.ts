import { describe, it, expect } from "vitest";
import { shouldAutoRefreshByTtl } from "./refresh-policy.js";

describe("shouldAutoRefreshByTtl", () => {
  it("returns false when INDEX_TTL is not configured", () => {
    expect(shouldAutoRefreshByTtl(undefined, 2_000_000, 1_000_000)).toBe(false);
  });

  it("returns false when TTL is invalid", () => {
    expect(shouldAutoRefreshByTtl("abc", 2_000_000, 1_000_000)).toBe(false);
    expect(shouldAutoRefreshByTtl("0", 2_000_000, 1_000_000)).toBe(false);
  });

  it("returns false when TTL has not expired", () => {
    expect(shouldAutoRefreshByTtl("3600", 2_000_000, 1_999_000)).toBe(false);
  });

  it("returns true when TTL has expired", () => {
    expect(shouldAutoRefreshByTtl("60", 2_000_000, 1_000_000)).toBe(true);
  });

  it("returns true when index is empty and TTL is enabled", () => {
    expect(shouldAutoRefreshByTtl("60", 2_000_000, null)).toBe(true);
  });
});
