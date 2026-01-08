/**
 * Text processing utilities.
 */

import { MAX_INPUT_LENGTH } from "../config/constants.js";
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
