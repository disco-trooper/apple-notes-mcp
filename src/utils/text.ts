/**
 * Text processing utilities.
 */

import { MAX_INPUT_LENGTH, PREVIEW_LENGTH, PREVIEW_TRUNCATE_RATIO } from "../config/constants.js";
import { createDebugLogger } from "./debug.js";

const debug = createDebugLogger("TEXT");

/**
 * Truncate text to maximum allowed length for embedding models.
 *
 * @param text - Text to truncate
 * @param maxLength - Maximum length (default: MAX_INPUT_LENGTH from constants)
 * @returns Truncated text
 */
export function truncateForEmbedding(text: string, maxLength = MAX_INPUT_LENGTH): string {
  if (text.length <= maxLength) {
    return text;
  }
  debug(`Truncating text from ${text.length} to ${maxLength} chars`);
  return text.substring(0, maxLength);
}

/**
 * Collapse whitespace and cut to `maxLength`, preferring a word boundary,
 * with "..." appended when truncated.
 */
export function generatePreview(content: string, maxLength = PREVIEW_LENGTH): string {
  const cleaned = content.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  const truncated = cleaned.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxLength * PREVIEW_TRUNCATE_RATIO) {
    return truncated.slice(0, lastSpace) + "...";
  }
  return truncated + "...";
}
