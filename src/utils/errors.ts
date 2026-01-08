/**
 * Error message sanitization for client responses.
 */

import { ERROR_MESSAGE_MAX_LENGTH } from "../config/constants.js";

const SAFE_ERROR_PATTERNS = [
  /^Note not found/,
  /^Title must be/,
  /^Title cannot be/,
  /^Title exceeds/,
  /^Title contains/,
  /^Invalid arguments/,
  /^Query cannot be empty/,
  /^READONLY_MODE is enabled/,
  /^Add confirm: true/,
  /^Multiple notes found/,
  /^Folder not found/,
];

const INTERNAL_ERROR_PATTERNS = [
  /\/[a-zA-Z]+\/[a-zA-Z]+\//,
  /at\s+\S+\s+\(/,
  /:\d+:\d+\)/,
  /TypeError:/,
  /ReferenceError:/,
  /ENOENT:/,
  /EACCES:/,
];

export function sanitizeErrorMessage(message: string): string {
  for (const pattern of SAFE_ERROR_PATTERNS) {
    if (pattern.test(message)) {
      return message;
    }
  }

  for (const pattern of INTERNAL_ERROR_PATTERNS) {
    if (pattern.test(message)) {
      return "An internal error occurred";
    }
  }

  const firstLine = message.split("\n")[0];
  return firstLine.substring(0, ERROR_MESSAGE_MAX_LENGTH);
}
