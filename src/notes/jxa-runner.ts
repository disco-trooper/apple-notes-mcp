/**
 * Single entry point for every Apple Notes JXA call (reads and writes).
 *
 * `executeJxa` spawns `osascript -l JavaScript` with `timeout` and `signal`
 * passed straight to `node:child_process` execFile, so a timeout or abort
 * really kills the child instead of leaving it hammering Notes after the
 * caller gave up.
 *
 * The script travels on the child's stdin, never as an argv element: write
 * payloads embed whole note bodies, and macOS caps argv+env (ARG_MAX), so a
 * large note sent via `-e` would fail with E2BIG.
 *
 * Wire format: the snippet is wrapped in a zero-arg function (so top-level
 * `return ...` in caller code works), invoked immediately, and its return
 * value is JSON-encoded between two marker strings on stderr (osascript
 * forwards JXA console.log to stderr). The markers carry a per-call nonce
 * and the end marker is searched from the end, so note content can never
 * truncate the payload.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { getJxaTimeoutMs } from "../config/constants.js";
import { IndexCancelledError } from "../indexing/contracts.js";

/** Generous stdio cap: a full batch of notes with bodies must fit easily. */
const MAX_JXA_BUFFER_BYTES = 64 * 1024 * 1024;

/** Characters of process output tail kept in error messages. */
const ERROR_TAIL_CHARS = 2000;

/** execFile error code when stdout/stderr outgrow maxBuffer. */
const MAX_BUFFER_CODE = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";

export interface JxaRunOptions {
  /** AbortSignal that kills the osascript child when aborted. */
  signal?: AbortSignal;
  /** Per-call timeout in milliseconds. Defaults to getJxaTimeoutMs(). */
  timeoutMs?: number;
}

/** execFile failure with the process output attached for diagnosis. */
interface ExecFailure {
  message: string;
  code: unknown;
  killed: boolean;
  stderr: string;
}

interface ResultMarkers {
  prefix: string;
  postfix: string;
}

function createMarkers(): ResultMarkers {
  const nonce = randomUUID();
  return {
    prefix: `@@[apple-notes-mcp-jxa-result:${nonce}]@@`,
    postfix: `##[apple-notes-mcp-jxa-result:${nonce}]##`,
  };
}

/**
 * Wrap caller JXA as a zero-arg function plus a marked console.log carrying
 * the JSON-encoded return value.
 */
function wrapAsJxaScript(code: string, markers: ResultMarkers): string {
  const functionCall = `(function(){\n${code}\n})()`;
  return (
    `console.log(${JSON.stringify(markers.prefix)} + ` +
    `JSON.stringify({data: ${functionCall}}) + ${JSON.stringify(markers.postfix)});`
  );
}

function tailOf(text: string | undefined): string {
  if (!text) {
    return "";
  }
  const trimmed = text.trim();
  return trimmed.length > ERROR_TAIL_CHARS ? `…${trimmed.slice(-ERROR_TAIL_CHARS)}` : trimmed;
}

/**
 * The script's own error from osascript stderr: `execution error: Error:
 * Error: Folder not found: X (-2700)` becomes `Folder not found: X`. Falls
 * back to the stderr tail when the line has another shape.
 */
function scriptErrorOf(stderr: string | undefined): string {
  const match = stderr?.match(/execution error: (?:Error: )*([\s\S]*?) \(-?\d+\)\s*$/);
  return match ? match[1].trim() : tailOf(stderr);
}

/** Spawn osascript, feed the script on stdin, surface stderr on failure. */
function execOsascript(
  script: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string> {
  // Executor form, not Promise.withResolvers: the package supports Node 18.
  return new Promise((resolve, reject) => {
    const child = execFile(
      "osascript",
      ["-l", "JavaScript"],
      { timeout: timeoutMs, signal, maxBuffer: MAX_JXA_BUFFER_BYTES },
      (error, _stdout, stderr) => {
        const err = typeof stderr === "string" ? stderr : String(stderr ?? "");
        if (error) {
          const failure: ExecFailure = {
            message: error.message,
            code: error.code ?? null,
            killed: error.killed ?? false,
            stderr: err,
          };
          reject(failure);
          return;
        }
        resolve(err);
      }
    );
    // A child killed early (timeout/abort) closes stdin: EPIPE is reported
    // through the execFile callback, so the stream error itself is ignored.
    child.stdin?.on("error", () => {});
    child.stdin?.end(script);
  });
}

function isExecFailure(value: unknown): value is ExecFailure {
  return (
    !!value &&
    typeof value === "object" &&
    "message" in value &&
    typeof value.message === "string" &&
    "killed" in value &&
    typeof value.killed === "boolean" &&
    "stderr" in value &&
    typeof value.stderr === "string"
  );
}

/** Extract the snippet's return value between this call's markers. */
function extractJxaResult(stderr: string, markers: ResultMarkers): string {
  const start = stderr.indexOf(markers.prefix);
  const end = start === -1 ? -1 : stderr.lastIndexOf(markers.postfix);
  if (start === -1 || end < start + markers.prefix.length) {
    throw new Error(
      `JXA execution failed: result markers not found in osascript output (stderr tail: ${tailOf(stderr) || "<empty>"})`
    );
  }
  const payload = stderr.slice(start + markers.prefix.length, end);
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error(
      `JXA execution failed: result is not valid JSON (payload tail: ${tailOf(payload) || "<empty>"})`
    );
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "data" in parsed) {
    const data: unknown = parsed.data;
    return typeof data === "string" ? data : JSON.stringify(data ?? null);
  }
  throw new Error(
    `JXA execution failed: result has no data field (payload tail: ${tailOf(payload) || "<empty>"})`
  );
}

/**
 * Run a JXA snippet via osascript, killing the child on timeout or abort.
 *
 * Resolves with the snippet's return value as a string: snippets in this
 * codebase `return JSON.stringify(...)`, so callers JSON.parse the result.
 * A non-string return value is JSON-encoded.
 *
 * @throws IndexCancelledError when the signal is aborted (before or during the call)
 * @throws Error "JXA execution timed out after <ms>ms" on timeout
 * @throws Error "JXA execution failed: ..." on output overflow, a non-zero
 * osascript exit (message carries the stderr tail, i.e. the script's own
 * error), or a missing/corrupt result payload
 */
export async function executeJxa<T = string>(code: string, opts?: JxaRunOptions): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? getJxaTimeoutMs();
  const signal = opts?.signal;

  if (signal?.aborted) {
    throw new IndexCancelledError("JXA execution cancelled before start");
  }

  const markers = createMarkers();
  let stderr: string;
  try {
    stderr = await execOsascript(wrapAsJxaScript(code, markers), timeoutMs, signal);
  } catch (thrown: unknown) {
    if (signal?.aborted) {
      throw new IndexCancelledError("JXA execution cancelled");
    }
    const failure = isExecFailure(thrown) ? thrown : null;
    const message = failure?.message ?? String(thrown);
    if (failure?.code === MAX_BUFFER_CODE) {
      throw new Error(
        `JXA execution failed: osascript output exceeded ${MAX_JXA_BUFFER_BYTES / (1024 * 1024)} MiB. ` +
          `Lower NOTES_FETCH_BATCH_SIZE to reduce per-call output.`
      );
    }
    if (failure?.killed === true || failure?.code === "ETIMEDOUT") {
      throw new Error(
        `JXA execution timed out after ${timeoutMs}ms. ` +
          `Raise JXA_TIMEOUT_MS, or lower NOTES_FETCH_BATCH_SIZE for bulk reads.`
      );
    }
    throw new Error(`JXA execution failed: ${scriptErrorOf(failure?.stderr) || message}`);
  }
  return extractJxaResult(stderr, markers) as T;
}
