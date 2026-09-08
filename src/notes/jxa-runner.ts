/**
 * Killable JXA runner for Apple Notes automation.
 *
 * Replaces `run-jxa` on the notes read path. `run-jxa` spawns `osascript`
 * without a timeout or abort signal, so a slow Notes call left the child
 * hammering Notes in the background after the caller gave up waiting. This
 * runner passes `timeout` and `signal` straight to `node:child_process`
 * execFile, so a timeout or AbortSignal truly kills the child process.
 *
 * Wire format mirrors run-jxa: the snippet is wrapped in a zero-arg function
 * (so top-level `return ...` in caller code keeps working), invoked
 * immediately, and its return value is JSON-encoded between two marker lines
 * on stderr (osascript forwards JXA console.log to stderr). The markers are
 * own constants; no new npm dependencies.
 */

import { execFile } from "node:child_process";

/** Prefix marking the start of the JSON payload on osascript stderr. */
export const JXA_RESULT_PREFIX = "@@[apple-notes-mcp-jxa-result]@@";
/** Postfix marking the end of the JSON payload on osascript stderr. */
export const JXA_RESULT_POSTFIX = "##[apple-notes-mcp-jxa-result]##";

/** Generous stdio cap: a full batch of notes with bodies must fit easily. */
const MAX_JXA_BUFFER_BYTES = 64 * 1024 * 1024;

/** Characters of process output tail kept in error messages. */
const ERROR_TAIL_CHARS = 2000;

export interface RunJxaWithKillOptions {
  /** Per-call timeout in milliseconds; the osascript child is killed past it. */
  timeoutMs: number;
  /** AbortSignal that kills the osascript child when aborted. */
  signal?: AbortSignal;
}

/** execFile failure with the process output attached for diagnosis. */
interface ExecFailure {
  message: string;
  code: unknown;
  killed: boolean;
  stderr: string;
}

/**
 * Wrap caller JXA the way run-jxa does: a zero-arg function body plus a
 * marked console.log carrying the JSON-encoded return value.
 */
function wrapAsJxaScript(code: string): string {
  const functionString = `function(){const args=[].slice.call(arguments);\n${code}\n}`;
  const functionCall = `(${functionString})()`;
  const output = `JSON.stringify({data: ${functionCall}})`;
  return (
    `console.log(${JSON.stringify(JXA_RESULT_PREFIX)} + ${output} + ` +
    `${JSON.stringify(JXA_RESULT_POSTFIX)});`
  );
}

function tailOf(text: string | undefined): string {
  if (!text) {
    return "";
  }
  const trimmed = text.trim();
  return trimmed.length > ERROR_TAIL_CHARS ? `…${trimmed.slice(-ERROR_TAIL_CHARS)}` : trimmed;
}
/** execFile promise wrapper that surfaces stderr on failure. */
function execOsascript(
  script: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ stdout: string; stderr: string }> {
  // Deliberately the executor form, not Promise.withResolvers: the package
  // still supports Node 18 (see engines) and compiles against ES2022 lib,
  // neither of which provides withResolvers.
  return new Promise((resolve, reject) => {
    // The script travels as an argv `-e` argument (no shell involved), so
    // no `input`/stdin plumbing is needed and quoting is a non-issue.
    execFile(
      "osascript",
      ["-l", "JavaScript", "-e", script],
      { timeout: timeoutMs, signal, maxBuffer: MAX_JXA_BUFFER_BYTES },
      (error, stdout, stderr) => {
        const out = typeof stdout === "string" ? stdout : String(stdout ?? "");
        const err = typeof stderr === "string" ? stderr : String(stderr ?? "");
        if (error) {
          // ExecFileException already types code/killed; no cast needed.
          const failure: ExecFailure = {
            message: error.message,
            code: error.code ?? null,
            killed: error.killed ?? false,
            stderr: err,
          };
          reject(failure);
          return;
        }
        resolve({ stdout: out, stderr: err });
      }
    );
  });
}

/** Narrow an execOsascript rejection back to its failure shape. */
function isExecFailure(value: unknown): value is ExecFailure {
  return (
    !!value &&
    typeof value === "object" &&
    "message" in value &&
    typeof value.message === "string" &&
    "code" in value &&
    "killed" in value &&
    typeof value.killed === "boolean" &&
    "stderr" in value &&
    typeof value.stderr === "string"
  );
}

/** Extract the JSON payload between the result markers on stderr. */
function extractJxaResult(stderr: string): string {
  const start = stderr.indexOf(JXA_RESULT_PREFIX);
  const end =
    start === -1
      ? -1
      : stderr.indexOf(JXA_RESULT_POSTFIX, start + JXA_RESULT_PREFIX.length);
  if (start === -1 || end === -1) {
    throw new Error(
      `JXA result markers not found in osascript output (stderr tail: ${tailOf(stderr) || "<empty>"})`
    );
  }
  const payload = stderr.slice(start + JXA_RESULT_PREFIX.length, end);
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error(`JXA result is not valid JSON (payload tail: ${tailOf(payload) || "<empty>"})`);
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "data" in parsed) {
    const data: unknown = parsed.data;
    return typeof data === "string" ? data : JSON.stringify(data ?? null);
  }
  throw new Error(`JXA result has no data field (payload tail: ${tailOf(payload) || "<empty>"})`);
}

/**
 * Run JXA via osascript, killing the child on timeout or abort.
 *
 * Resolves with the snippet's return value: snippets in this codebase
 * `return JSON.stringify(...)`, so callers get that JSON string back (the
 * same shape `run-jxa` produced, hence a plain string here).
 *
 * Rejects with an Error containing `cancelled` when aborted (including an
 * already-aborted signal), or `timed out after <ms>ms` plus a
 * NOTES_FETCH_BATCH_SIZE hint on timeout. A missing result marker or a
 * non-zero osascript exit rejects with the stderr tail attached.
 */
export async function runJxaWithKill(code: string, opts: RunJxaWithKillOptions): Promise<string> {
  const { timeoutMs, signal } = opts;
  if (signal?.aborted) {
    throw new Error("JXA execution cancelled before start (cancelled)");
  }
  const script = wrapAsJxaScript(code);
  let stderr = "";
  try {
    const result = await execOsascript(script, timeoutMs, signal);
    stderr = result.stderr;
  } catch (thrown: unknown) {
    if (signal?.aborted) {
      throw new Error("JXA execution cancelled (cancelled)");
    }
    const failure = isExecFailure(thrown) ? thrown : null;
    const message = failure?.message ?? String(thrown);
    const timedOut =
      failure?.code === "ETIMEDOUT" || /timed out/i.test(message) || failure?.killed === true;
    if (timedOut) {
      throw new Error(
        `JXA execution timed out after ${timeoutMs}ms. ` +
          `Try lowering NOTES_FETCH_BATCH_SIZE (or the batchSize option) to reduce per-call work.`
      );
    }
    const tail = tailOf(failure?.stderr);
    throw new Error(`osascript failed: ${message}${tail ? ` (stderr tail: ${tail})` : ""}`);
  }
  return extractJxaResult(stderr);
}
