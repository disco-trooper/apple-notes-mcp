/**
 * Helpers for building LanceDB (DataFusion SQL) filter expressions.
 */

/**
 * Escape a value for use inside a single-quoted SQL string literal.
 *
 * DataFusion treats backslash and control characters literally inside
 * single-quoted strings, so only the quote itself needs doubling.
 */
export function escapeForFilter(value: string): string {
  return value.replace(/'/g, "''");
}
