/**
 * Apple Notes table HTML parsing and editing utilities.
 *
 * Apple Notes wraps tables in <object> tags with a specific structure:
 * <object><table><tbody><tr><td><div>content</div></td>...</tr>...</tbody></table></object>
 */

export interface CellFormatting {
  bold: boolean;
}

export interface TableData {
  rows: string[][];
  formatting: CellFormatting[][];
}

export interface TableCellEdit {
  row: number;
  column: number;
  value: string;
}

/**
 * An <object> that wraps a <table>. The object may not contain another
 * <object> before or after the table, so a preceding attachment object can't
 * be swallowed together with everything up to a later table.
 */
const TABLE_OBJECT_REGEX =
  /<object\b[^>]*>(?:(?!<\/?object\b)[\s\S])*?<table\b[\s\S]*?<\/table>(?:(?!<\/?object\b)[\s\S])*?<\/object>/gi;

interface CellSpan {
  /** Offset of the cell's inner HTML (after the opening <td>) */
  innerStart: number;
  /** Offset of the cell's closing </td> */
  innerEnd: number;
  inner: string;
}

interface RowSpan {
  cells: CellSpan[];
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Decode HTML entities in a single pass (so `&amp;lt;` becomes `&lt;`, not `<`).
 * Also decodes the legacy no-semicolon forms Apple Notes writes back
 * (`$&amp cheap`) when not followed by a letter or digit, so `&ampersand` stays.
 */
function decodeEntities(text: string): string {
  return text.replace(
    /&(?:(#\d+|#x[0-9a-f]+|[a-z]+);|(amp|lt|gt|quot|nbsp)(?![a-z0-9]))/gi,
    (match, entity: string | undefined, legacy: string | undefined) => {
      if (legacy) return NAMED_ENTITIES[legacy.toLowerCase()];
      const name = entity ?? "";
      if (name[0] === "#") {
        const code =
          name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return code <= 0x10ffff ? String.fromCodePoint(code) : match;
      }
      return NAMED_ENTITIES[name.toLowerCase()] ?? match;
    }
  );
}

/**
 * Escape HTML special characters to prevent injection.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Plain text of a cell: each <div>/<br> line becomes its own line,
 * blank lines are dropped, entities are decoded.
 */
function cellText(inner: string): string {
  const text = inner
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:div|p|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * Locate the rows and cells of the first table in `html`, with absolute offsets.
 * Rows without cells are skipped so indices match `parseTable`.
 */
function scanRows(html: string): RowSpan[] {
  const tableMatch = /<table\b[\s\S]*?<\/table>/i.exec(html);
  if (!tableMatch) return [];

  const rows: RowSpan[] = [];
  const rowRegex = /(<tr\b[^>]*>)([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRegex.exec(tableMatch[0])) !== null) {
    const rowInnerStart = tableMatch.index + rowMatch.index + rowMatch[1].length;
    const cells: CellSpan[] = [];
    const cellRegex = /(<(td|th)\b[^>]*>)([\s\S]*?)<\/\2>/gi;
    let cellMatch: RegExpExecArray | null;

    while ((cellMatch = cellRegex.exec(rowMatch[2])) !== null) {
      const innerStart = rowInnerStart + cellMatch.index + cellMatch[1].length;
      cells.push({
        innerStart,
        innerEnd: innerStart + cellMatch[3].length,
        inner: cellMatch[3],
      });
    }

    if (cells.length > 0) rows.push({ cells });
  }

  return rows;
}

/**
 * Parse Apple Notes table HTML into structured data.
 * Cell text is entity-decoded; multi-line cells are joined with "\n".
 */
export function parseTable(html: string): TableData {
  const result: TableData = { rows: [], formatting: [] };

  for (const row of scanRows(html)) {
    result.rows.push(row.cells.map((cell) => cellText(cell.inner)));
    result.formatting.push(row.cells.map((cell) => ({ bold: /<b\b/i.test(cell.inner) })));
  }

  return result;
}

/**
 * Find all tables in note HTML content with their offsets.
 */
function findTableSpans(html: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const regex = new RegExp(TABLE_OBJECT_REGEX.source, TABLE_OBJECT_REGEX.flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

/**
 * Find all tables in note HTML content.
 * Returns array of table HTML strings (each an <object> wrapping a <table>).
 */
export function findTables(html: string): string[] {
  return findTableSpans(html).map(({ start, end }) => html.slice(start, end));
}

/**
 * Render new cell content, reusing the cell's first <div> opening tag and
 * keeping bold formatting. Each line of `value` becomes one <div>.
 */
function renderCell(originalInner: string, value: string, bold: boolean): string {
  const divOpen = /<div\b[^>]*>/i.exec(originalInner)?.[0] ?? "<div>";
  return value
    .split(/\r?\n/)
    .map((line) => {
      const escaped = escapeHtml(line);
      const content = escaped === "" ? "<br>" : bold ? `<b>${escaped}</b>` : escaped;
      return `${divOpen}${content}</div>`;
    })
    .join("");
}

function checkIndex(index: number, length: number, label: string, container: string): void {
  if (!Number.isInteger(index) || index < 0 || index >= length) {
    throw new Error(`${label} ${index} out of bounds (${container} has ${length} ${label.toLowerCase()}s)`);
  }
}

/**
 * Apply cell edits to one table of a note's HTML.
 *
 * Edits are spliced by position (not by string search), so identical cells or
 * rows elsewhere are never touched, `$` patterns in values are literal, and
 * <tr>/<td> attributes are preserved.
 *
 * @param html - Full note HTML
 * @param tableIndex - Table index (0-based, as returned by findTables)
 * @param edits - Cell edits; `row` 0 is the header row. `value` is plain text
 *   (escaped here exactly once; do not pre-escape).
 * @returns Updated full note HTML
 * @throws Error when the table, row or column index is out of range
 */
export function applyTableEdits(html: string, tableIndex: number, edits: TableCellEdit[]): string {
  const spans = findTableSpans(html);
  if (!Number.isInteger(tableIndex) || tableIndex < 0 || tableIndex >= spans.length) {
    throw new Error(`Table index ${tableIndex} out of bounds (note has ${spans.length} tables)`);
  }

  const { start, end } = spans[tableIndex];
  let table = html.slice(start, end);

  for (const edit of edits) {
    const rows = scanRows(table);
    checkIndex(edit.row, rows.length, "Row", "table");
    const cells = rows[edit.row].cells;
    checkIndex(edit.column, cells.length, "Column", `row ${edit.row}`);

    const cell = cells[edit.column];
    const bold = /<b\b/i.test(cell.inner);
    table =
      table.slice(0, cell.innerStart) +
      renderCell(cell.inner, edit.value, bold) +
      table.slice(cell.innerEnd);
  }

  return html.slice(0, start) + table + html.slice(end);
}
