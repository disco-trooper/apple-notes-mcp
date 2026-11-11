import { describe, expect, it } from "vitest";
import { isIndexLocked, withIndexLock } from "./lock.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("withIndexLock", () => {
  it("runs holders one at a time in call order", async () => {
    const order: string[] = [];
    const gate = deferred();

    const first = withIndexLock(async () => {
      order.push("first:start");
      await gate.promise;
      order.push("first:end");
    });
    const second = withIndexLock(async () => {
      order.push("second");
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    expect(isIndexLocked()).toBe(true);

    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("releases after a rejection and propagates the error", async () => {
    const gate = deferred();
    const failing = withIndexLock(async () => {
      await gate.promise;
    });
    const next = withIndexLock(async () => "ran");

    gate.reject(new Error("boom"));
    await expect(failing).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ran");
    await Promise.resolve();
    expect(isIndexLocked()).toBe(false);
  });
});
