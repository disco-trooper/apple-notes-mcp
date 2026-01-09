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

  // Find and replace the specific cell
  let currentRow = 0;
  let result = html;

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    if (currentRow === row) {
      const rowContent = rowMatch[1];
      let currentCol = 0;
      let newRowContent = rowContent;

      const cellRegex = /(<td[^>]*>[\s\S]*?<div[^>]*>)([\s\S]*?)(<\/div>[\s\S]*?<\/td>)/gi;
      let cellMatch;
      const replacements: Array<{original: string; replacement: string}> = [];

      while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
        if (currentCol === column) {
          const prefix = cellMatch[1];
          const suffix = cellMatch[3];
          const isBold = parsed.formatting[row][column].bold;
          const newContent = isBold ? `<b>${value}</b>` : value;
          replacements.push({
            original: cellMatch[0],
            replacement: `${prefix}${newContent}${suffix}`
          });
        }
        currentCol++;
      }

      for (const r of replacements) {
        newRowContent = newRowContent.replace(r.original, r.replacement);
      }

      result = result.replace(rowMatch[0], `<tr>${newRowContent}</tr>`);
      break;
    }
    currentRow++;
  }

  return result;
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
