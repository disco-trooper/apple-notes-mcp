import { describe, it, expect } from "vitest";
import { htmlToMarkdown } from "./conversion.js";
import { findTables, parseTable } from "./tables.js";

const SAMPLE_TABLE_HTML = `<object><table cellspacing="0" cellpadding="0" style="border-collapse: collapse">
<tbody>
<tr><td valign="top" style="border-style: solid"><div><b>Typ</b></div></td><td valign="top" style="border-style: solid"><div><b>Částka</b></div></td></tr>
<tr><td valign="top" style="border-style: solid"><div>Sociální</div></td><td valign="top" style="border-style: solid"><div>9 154 Kč</div></td></tr>
<tr><td valign="top" style="border-style: solid"><div>Zdravotní</div></td><td valign="top" style="border-style: solid"><div>3 848 Kč</div></td></tr>
</tbody>
</table></object>`;

describe("htmlToMarkdown", () => {
  describe("table conversion", () => {
    it("should convert table to Markdown format", () => {
      const result = htmlToMarkdown(SAMPLE_TABLE_HTML);
      expect(result).toContain("| Typ | Částka |");
      expect(result).toContain("|---|---|");
      expect(result).toContain("| Sociální | 9 154 Kč |");
      expect(result).toContain("| Zdravotní | 3 848 Kč |");
    });

    it("should not show [Attachment: unknown] for tables", () => {
      const result = htmlToMarkdown(SAMPLE_TABLE_HTML);
      expect(result).not.toContain("[Attachment:");
    });

    it("should handle multiple tables", () => {
      const html = `<div>Some text</div>${SAMPLE_TABLE_HTML}<p>More text</p>${SAMPLE_TABLE_HTML}`;
      const result = htmlToMarkdown(html);
      // Count occurrences of the header row
      const matches = result.match(/\| Typ \| Částka \|/g);
      expect(matches).toHaveLength(2);
    });

    it("should handle header-only table", () => {
      const headerOnlyTable = `<object><table><tbody>
        <tr><td><div>Col1</div></td><td><div>Col2</div></td></tr>
      </tbody></table></object>`;
      const result = htmlToMarkdown(headerOnlyTable);
      expect(result).toContain("| Col1 | Col2 |");
      expect(result).toContain("|---|---|");
    });

    it("should preserve tables alongside attachments", () => {
      const mixed = `${SAMPLE_TABLE_HTML}<object data-filename="file.pdf"></object>`;
      const result = htmlToMarkdown(mixed);
      expect(result).toContain("| Typ | Částka |");
      // Turndown escapes brackets in Markdown with backslash
      expect(result).toContain("Attachment: file.pdf");
    });
  });

  describe("attachment handling", () => {
    it("should convert attachment to placeholder", () => {
      const html = `<object data-filename="document.pdf">content</object>`;
      const result = htmlToMarkdown(html);
      // Turndown escapes brackets in Markdown output
      expect(result).toContain("Attachment: document.pdf");
    });

    it("should handle images", () => {
      const html = `<img alt="screenshot" src="file.png">`;
      const result = htmlToMarkdown(html);
      // Turndown processes images via custom rule
      expect(result).toContain("Attachment:");
    });
  });

  describe("edge cases", () => {
    it("should return empty string for empty input", () => {
      expect(htmlToMarkdown("")).toBe("");
    });

    it("should handle null-like input", () => {
      expect(htmlToMarkdown(null as unknown as string)).toBe("");
    });

    it("should handle plain text", () => {
      const result = htmlToMarkdown("<p>Hello world</p>");
      expect(result).toBe("Hello world");
    });
  });

  describe("pipe character escaping", () => {
    it("should escape pipe characters in cell content", () => {
      const tableWithPipe = `<object><table><tbody>
        <tr><td><div>Name</div></td><td><div>Value</div></td></tr>
        <tr><td><div>Price | Tax</div></td><td><div>100 | 20</div></td></tr>
      </tbody></table></object>`;
      const result = htmlToMarkdown(tableWithPipe);
      // Pipe characters are escaped (Turndown adds additional escaping)
      // Output: Price \\| Tax (double backslash renders correctly in Markdown)
      expect(result).toMatch(/Price\s*\\\\?\|/);
      expect(result).toMatch(/100\s*\\\\?\|/);
    });

    it("should handle multiple pipes in one cell", () => {
      const tableWithMultiplePipes = `<object><table><tbody>
        <tr><td><div>Header</div></td></tr>
        <tr><td><div>A | B | C</div></td></tr>
      </tbody></table></object>`;
      const result = htmlToMarkdown(tableWithMultiplePipes);
      // Multiple pipes should all be escaped
      expect(result).toMatch(/A\s*\\\\?\|.*B\s*\\\\?\|.*C/);
    });
  });
});

describe("get-tables integration", () => {
  it("should find and parse tables from HTML content", () => {
    const htmlContent = `<div>Some text</div>${SAMPLE_TABLE_HTML}<p>More text</p>`;

    // Simulate get-tables tool behavior
    const tables = findTables(htmlContent);
    const parsedTables = tables.map((html, index) => ({
      index,
      ...parseTable(html),
    }));

    expect(tables).toHaveLength(1);
    expect(parsedTables[0].rows).toHaveLength(3);
    expect(parsedTables[0].rows[0]).toEqual(["Typ", "Částka"]);
    expect(parsedTables[0].formatting[0][0].bold).toBe(true);
  });

  it("should return structured data matching get-tables response schema", () => {
    const tables = findTables(SAMPLE_TABLE_HTML);
    const parsedTables = tables.map((html, index) => ({
      index,
      ...parseTable(html),
    }));

    // Verify response structure matches documented schema
    const response = {
      title: "Test Note",
      folder: "Test Folder",
      tableCount: tables.length,
      tables: parsedTables.map((t) => ({
        index: t.index,
        rows: t.rows,
        formatting: t.formatting,
      })),
    };

    expect(response).toHaveProperty("title");
    expect(response).toHaveProperty("folder");
    expect(response).toHaveProperty("tableCount", 1);
    expect(response.tables[0]).toHaveProperty("index", 0);
    expect(response.tables[0]).toHaveProperty("rows");
    expect(response.tables[0]).toHaveProperty("formatting");
    expect(Array.isArray(response.tables[0].rows)).toBe(true);
    expect(Array.isArray(response.tables[0].formatting)).toBe(true);
  });

  it("should handle note with multiple tables", () => {
    const multiTableHtml = `${SAMPLE_TABLE_HTML}<p>text</p>${SAMPLE_TABLE_HTML}`;
    const tables = findTables(multiTableHtml);

    expect(tables).toHaveLength(2);
    tables.forEach((tableHtml) => {
      const parsed = parseTable(tableHtml);
      expect(parsed.rows.length).toBeGreaterThan(0);
    });
  });

  it("should handle note with no tables", () => {
    const noTableHtml = "<div>Just some text without tables</div>";
    const tables = findTables(noTableHtml);

    expect(tables).toHaveLength(0);
  });
});
