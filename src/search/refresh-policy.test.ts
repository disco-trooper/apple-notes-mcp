import { describe, it, expect } from "vitest";
import { parseIndexTtlSeconds, shouldAutoRefreshByTtl } from "./refresh-policy.js";

describe("parseIndexTtlSeconds", () => {
  it("disables auto-refresh for unset or invalid values", () => {
    expect(parseIndexTtlSeconds(undefined)).toBeNull();
    expect(parseIndexTtlSeconds("abc")).toBeNull();
    expect(parseIndexTtlSeconds("0")).toBeNull();
    expect(parseIndexTtlSeconds("-5")).toBeNull();
  });

  it("parses positive seconds", () => {
    expect(parseIndexTtlSeconds("3600")).toBe(3600);
  });
});

describe("shouldAutoRefreshByTtl", () => {
  it("returns false when TTL has not expired", () => {
    expect(shouldAutoRefreshByTtl(3600, 2_000_000, 1_999_000)).toBe(false);
  });

  it("returns true exactly at expiry", () => {
    expect(shouldAutoRefreshByTtl(60, 1_060_000, 1_000_000)).toBe(true);
  });

  it("returns true when nothing has been indexed yet", () => {
    expect(shouldAutoRefreshByTtl(60, 2_000_000, null)).toBe(true);
  });
});
