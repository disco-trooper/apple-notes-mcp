/**
 * Input validation for database operations.
 */

// Maximum allowed title length
const MAX_TITLE_LENGTH = 500;

// Pattern for allowed characters in titles
// Allows: letters (any language), numbers, spaces, common punctuation
const SAFE_TITLE_PATTERN = /^[\p{L}\p{N}\p{P}\p{Z}]+$/u;

/**
 * Validate and sanitize a note title for database operations.
 *
 * @param title - The title to validate
 * @throws Error if title is invalid
 * @returns Sanitized title safe for database queries
 */
export function validateTitle(title: string): string {
  if (!title || typeof title !== "string") {
    throw new Error("Title must be a non-empty string");
  }

  const trimmed = title.trim();

  if (trimmed.length === 0) {
    throw new Error("Title cannot be empty or whitespace only");
  }

  if (trimmed.length > MAX_TITLE_LENGTH) {
    throw new Error(`Title exceeds maximum length of ${MAX_TITLE_LENGTH} characters`);
  }

  // Check for potentially dangerous characters
  if (!SAFE_TITLE_PATTERN.test(trimmed)) {
    throw new Error("Title contains invalid characters");
  }

  return trimmed;
}

/**
 * Escape a string for use in LanceDB SQL-like filters.
 * Uses comprehensive escaping beyond just single quotes.
 *
 * @param value - The value to escape
 * @returns Escaped string safe for filter expressions
 */
export function escapeForFilter(value: string): string {
  return value
    .replace(/\\/g, "\\\\")  // Escape backslashes first
    .replace(/'/g, "''")      // Escape single quotes
    .replace(/\n/g, "\\n")    // Escape newlines
    .replace(/\r/g, "\\r")    // Escape carriage returns
    .replace(/\t/g, "\\t");   // Escape tabs
}
