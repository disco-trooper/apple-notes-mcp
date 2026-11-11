/**
 * Error message sanitization for client responses.
 *
 * Typed domain errors and validation errors carry messages written for the
 * user, so they are returned in full. Anything else is reduced to its first
 * line and replaced entirely when it looks like an internal failure
 * (absolute filesystem paths, stack frames, programming errors).
 */

import { ERROR_MESSAGE_MAX_LENGTH } from "../config/constants.js";
import { DuplicateNoteError, NoteNotFoundError, ReadOnlyModeError } from "../errors/index.js";
import { IndexCancelledError } from "../indexing/contracts.js";

const INTERNAL_ERROR_MESSAGE = "An internal error occurred";

const EXPOSED_ERROR_TYPES = [
  NoteNotFoundError,
  DuplicateNoteError,
  ReadOnlyModeError,
  IndexCancelledError,
];

const INTERNAL_ERROR_TYPES = [TypeError, ReferenceError, SyntaxError, RangeError];

/** Multi-line messages that are safe and useless when cut to their first line. */
const MULTILINE_SAFE_PATTERNS = [/^Invalid environment configuration/];

const INTERNAL_ERROR_PATTERNS = [
  // Absolute filesystem path (macOS/Unix roots), bare or inside a file:// URL.
  // Notes folder paths such as "Work/Projects/Note" are relative and stay visible.
  /(?:^|[\s"'`(=:,[]|file:\/\/)\/(?:Users|home|private|var|tmp|opt|usr|etc|Library|System|Applications|Volumes)\//,
  /\n\s+at\s/,
  /:\d+:\d+\)/,
  /\b(?:TypeError|ReferenceError|SyntaxError|RangeError):/,
  /\b(?:ENOENT|EACCES|EPERM|EISDIR|ENOTDIR):/,
];

/**
 * Turn any thrown value into a message that is safe to send to the MCP client.
 */
export function sanitizeErrorMessage(error: unknown): string {
  if (EXPOSED_ERROR_TYPES.some((type) => error instanceof type)) {
    return (error as Error).message;
  }

  if (INTERNAL_ERROR_TYPES.some((type) => error instanceof type)) {
    return INTERNAL_ERROR_MESSAGE;
  }

  const message = error instanceof Error ? error.message : String(error);

  if (MULTILINE_SAFE_PATTERNS.some((pattern) => pattern.test(message))) {
    return message;
  }

  if (INTERNAL_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
    return INTERNAL_ERROR_MESSAGE;
  }

  const firstLine = message.split("\n")[0];
  return firstLine.substring(0, ERROR_MESSAGE_MAX_LENGTH);
}
