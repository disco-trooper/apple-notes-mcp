import { describe, it, expect, vi, afterEach } from "vitest";
import { createDebugLogger } from "./debug.js";

describe("createDebugLogger", () => {
  const originalDebug = process.env.DEBUG;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalDebug !== undefined) {
      process.env.DEBUG = originalDebug;
    } else {
      delete process.env.DEBUG;
    }
  });

  it.each([
    ["true", 1],
    ["1", 1],
    ["false", 0],
    ["0", 0],
  ])("DEBUG=%s logs %i time(s) to stderr", (value, calls) => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    process.env.DEBUG = value;

    createDebugLogger("TEST")("hello");

    expect(stderr).toHaveBeenCalledTimes(calls);
    expect(log).not.toHaveBeenCalled();
  });

  it("reads DEBUG at call time", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.DEBUG;
    const logger = createDebugLogger("TEST");

    logger("off");
    process.env.DEBUG = "true";
    logger("on");

    expect(stderr).toHaveBeenCalledTimes(1);
  });
});
