import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
import { executeJxa } from "./jxa-runner.js";
import { IndexCancelledError } from "../indexing/contracts.js";

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

interface FakeRun {
  script: string;
  args: string[];
  options: { timeout?: number; signal?: AbortSignal };
}

/**
 * Fake osascript: captures the script written to stdin, then answers with
 * `respond(script, run)` — a stderr string, or an error to fail with.
 * Markers are read back from the script, so responses use this call's nonce.
 */
function fakeOsascript(
  respond: (script: string, run: FakeRun) => { stderr: string; error?: Error & Record<string, unknown> }
): FakeRun[] {
  const runs: FakeRun[] = [];
  vi.mocked(execFile).mockImplementation(((
    _cmd: string,
    args: string[],
    options: FakeRun["options"],
    callback: ExecCallback
  ) => {
    const run: FakeRun = { script: "", args, options };
    runs.push(run);
    return {
      stdin: {
        on: vi.fn(),
        end: (script: string) => {
          run.script = script;
          queueMicrotask(() => {
            const { stderr, error } = respond(script, run);
            callback(error ?? null, "", stderr);
          });
        },
      },
    };
  }) as unknown as typeof execFile);
  return runs;
}

/** Markers embedded in a generated script, as JSON string literals. */
function markersOf(script: string): { prefix: string; postfix: string } {
  const literals = [...script.matchAll(/"(@@\[[^"]+\]@@|##\[[^"]+\]##)"/g)].map((m) => m[1]);
  return { prefix: literals[0], postfix: literals[1] };
}

function reply(script: string, data: unknown): { stderr: string } {
  const { prefix, postfix } = markersOf(script);
  return { stderr: `${prefix}${JSON.stringify({ data })}${postfix}\n` };
}

function execError(message: string, fields: Record<string, unknown>): Error & Record<string, unknown> {
  return Object.assign(new Error(message), fields);
}

describe("executeJxa", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends the script on stdin, not argv", async () => {
    const runs = fakeOsascript((script) => reply(script, "ok"));

    await expect(executeJxa("return 'ok';")).resolves.toBe("ok");

    expect(runs[0].args).toEqual(["-l", "JavaScript"]);
    expect(runs[0].script).toContain("return 'ok';");
  });

  it("uses a fresh marker nonce per call", async () => {
    const runs = fakeOsascript((script) => reply(script, "ok"));

    await executeJxa("return 1;");
    await executeJxa("return 2;");

    expect(markersOf(runs[0].script).prefix).not.toBe(markersOf(runs[1].script).prefix);
  });

  it("keeps payloads that contain the end marker intact", async () => {
    let postfix = "";
    fakeOsascript((script) => {
      postfix = markersOf(script).postfix;
      return reply(script, `body with ${postfix} inside`);
    });

    const result = await executeJxa("return x;");
    expect(result).toBe(`body with ${postfix} inside`);
  });

  it("ignores console noise around the payload", async () => {
    fakeOsascript((script) => {
      const { stderr } = reply(script, { a: 1 });
      return { stderr: `warning: something\n${stderr}trailing log\n` };
    });

    await expect(executeJxa("return {a: 1};")).resolves.toBe('{"a":1}');
  });

  it("rejects when markers are missing", async () => {
    fakeOsascript(() => ({ stderr: "no markers here" }));

    await expect(executeJxa("return 1;")).rejects.toThrow("result markers not found");
  });

  it("maps a killed child to a timeout error", async () => {
    const runs = fakeOsascript(() => ({
      stderr: "",
      error: execError("Command failed", { killed: true, signal: "SIGTERM", code: null }),
    }));

    await expect(executeJxa("return 1;", { timeoutMs: 50 })).rejects.toThrow("timed out after 50ms");
    expect(runs[0].options.timeout).toBe(50);
  });

  it("reports maxBuffer overflow separately from a timeout", async () => {
    fakeOsascript(() => ({
      stderr: "",
      error: execError("stderr maxBuffer length exceeded", {
        killed: true,
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      }),
    }));

    const error = await executeJxa("return 1;").then(
      () => undefined,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : "";
    expect(message).toContain("exceeded");
    expect(message).not.toContain("timed out");
  });

  it("surfaces the script's own error on a non-zero exit", async () => {
    fakeOsascript(() => ({
      stderr: "execution error: Error: Error: Folder not found: Work (-2700)\n",
      error: execError("Command failed: osascript -l JavaScript", { killed: false, code: 1 }),
    }));

    await expect(executeJxa("throw new Error('x');")).rejects.toThrow(
      "JXA execution failed: Folder not found: Work"
    );
  });

  it("throws IndexCancelledError without spawning when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(executeJxa("return 1;", { signal: controller.signal })).rejects.toBeInstanceOf(
      IndexCancelledError
    );
    expect(execFile).not.toHaveBeenCalled();
  });

  it("throws IndexCancelledError when aborted mid-run and passes the signal to execFile", async () => {
    const controller = new AbortController();
    const runs = fakeOsascript(() => {
      controller.abort();
      return { stderr: "", error: execError("The operation was aborted", { killed: false, code: "ABORT_ERR" }) };
    });

    await expect(executeJxa("return 1;", { signal: controller.signal })).rejects.toBeInstanceOf(
      IndexCancelledError
    );
    expect(runs[0].options.signal).toBe(controller.signal);
  });
});
