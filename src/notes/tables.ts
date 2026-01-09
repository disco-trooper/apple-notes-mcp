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
  raw: string;
}

/**
 * Parse Apple Notes table HTML into structured data.
 */
export function parseTable(html: string): TableData {
  const result: TableData = {
    rows: [],
    formatting: [],
    raw: html,
  };

  // Match table content inside <object>
  const tableMatch = html.match(/<object[^>]*>[\s\S]*?<table[\s\S]*?<tbody>([\s\S]*?)<\/tbody>[\s\S]*?<\/table>[\s\S]*?<\/object>/i);
  if (!tableMatch) {
    return result;
  }

  const tbodyContent = tableMatch[1];

  // Match all rows
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(tbodyContent)) !== null) {
    const rowContent = rowMatch[1];
    const cells: string[] = [];
    const cellFormats: CellFormatting[] = [];

    // Match all cells in this row
    const cellRegex = /<td[^>]*>[\s\S]*?<div[^>]*>([\s\S]*?)<\/div>[\s\S]*?<\/td>/gi;
    let cellMatch;

    while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
      const cellContent = cellMatch[1];
      // Extract text, stripping HTML tags
      const text = cellContent.replace(/<[^>]+>/g, "").trim();
      const isBold = /<b>/i.test(cellContent);

      cells.push(text);
      cellFormats.push({ bold: isBold });
    }

    if (cells.length > 0) {
      result.rows.push(cells);
      result.formatting.push(cellFormats);
    }
  }

  return result;
}

/**
 * Find the HTML of a specific row in a table.
 */
function findRowHtml(tableHtml: string, rowIndex: number): { match: RegExpMatchArray; content: string } | null {
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let currentRow = 0;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
    if (currentRow === rowIndex) {
      return { match: rowMatch, content: rowMatch[1] };
    }
    currentRow++;
  }
  return null;
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
 * Update a specific cell within a row's HTML.
 */
function updateCellInRow(rowContent: string, columnIndex: number, value: string, isBold: boolean): string {
  const cellRegex = /(<td[^>]*>[\s\S]*?<div[^>]*>)([\s\S]*?)(<\/div>[\s\S]*?<\/td>)/gi;
  let currentCol = 0;
  let result = rowContent;
  let cellMatch;

  const replacements: Array<{original: string; replacement: string}> = [];

  // Escape HTML to prevent injection
  const escapedValue = escapeHtml(value);

  while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
    if (currentCol === columnIndex) {
      const prefix = cellMatch[1];
      const suffix = cellMatch[3];
      const newContent = isBold ? `<b>${escapedValue}</b>` : escapedValue;
      replacements.push({
        original: cellMatch[0],
        replacement: `${prefix}${newContent}${suffix}`
      });
    }
    currentCol++;
  }

  for (const r of replacements) {
    result = result.replace(r.original, r.replacement);
  }

  return result;
}

/**
 * Update a specific cell in an Apple Notes table HTML.
 *
 * @param html - The table HTML
 * @param row - Row index (0-based, 0 = header)
 * @param column - Column index (0-based)
 * @param value - New cell value
 * @returns Updated HTML
 */
export function updateTableCell(html: string, row: number, column: number, value: string): string {
  const parsed = parseTable(html);

  if (row >= parsed.rows.length) {
    throw new Error(`Row ${row} out of bounds (table has ${parsed.rows.length} rows)`);
  }

  if (column >= parsed.rows[row].length) {
    throw new Error(`Column ${column} out of bounds (row has ${parsed.rows[row].length} columns)`);
  }

  const rowData = findRowHtml(html, row);
  if (!rowData) {
    throw new Error(`Could not find row ${row} in table HTML`);
  }

  const isBold = parsed.formatting[row][column].bold;
  const updatedRowContent = updateCellInRow(rowData.content, column, value, isBold);

  return html.replace(rowData.match[0], `<tr>${updatedRowContent}</tr>`);
}

/**
 * Find all tables in note HTML content.
 * Returns array of table HTML strings.
 */
export function findTables(html: string): string[] {
  const tables: string[] = [];
  const tableRegex = /<object[^>]*>[\s\S]*?<table[\s\S]*?<\/table>[\s\S]*?<\/object>/gi;
  let match;

  while ((match = tableRegex.exec(html)) !== null) {
    tables.push(match[0]);
  }

  return tables;
}
