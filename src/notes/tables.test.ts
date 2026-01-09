import { describe, it, expect } from "vitest";
import { parseTable, updateTableCell, findTables } from "./tables.js";

const SAMPLE_TABLE_HTML = `<object><table cellspacing="0" cellpadding="0" style="border-collapse: collapse">
<tbody>
<tr><td valign="top" style="border-style: solid"><div><b>Typ</b></div></td><td valign="top" style="border-style: solid"><div><b>Částka</b></div></td></tr>
<tr><td valign="top" style="border-style: solid"><div>Sociální</div></td><td valign="top" style="border-style: solid"><div>9 154 Kč</div></td></tr>
<tr><td valign="top" style="border-style: solid"><div>Zdravotní</div></td><td valign="top" style="border-style: solid"><div>3 848 Kč</div></td></tr>
</tbody>
</table></object>`;

describe("parseTable", () => {
  it("should parse table rows and cells", () => {
    const result = parseTable(SAMPLE_TABLE_HTML);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toEqual(["Typ", "Částka"]);
    expect(result.rows[1]).toEqual(["Sociální", "9 154 Kč"]);
    expect(result.rows[2]).toEqual(["Zdravotní", "3 848 Kč"]);
  });

  it("should preserve bold formatting info", () => {
    const result = parseTable(SAMPLE_TABLE_HTML);
    expect(result.formatting[0][0].bold).toBe(true);
    expect(result.formatting[1][0].bold).toBe(false);
  });

  it("should return empty for non-table HTML", () => {
    const result = parseTable("<div>Not a table</div>");
    expect(result.rows).toHaveLength(0);
  });
});

describe("updateTableCell", () => {
  it("should update cell content", () => {
    const updated = updateTableCell(SAMPLE_TABLE_HTML, 1, 0, "✅ Sociální");
    expect(updated).toContain("✅ Sociální");
  });

  it("should preserve table structure", () => {
    const updated = updateTableCell(SAMPLE_TABLE_HTML, 1, 0, "✅ Sociální");
    expect(updated).toContain("<object>");
    expect(updated).toContain("</table></object>");
  });

  it("should throw for out of bounds row", () => {
    expect(() => updateTableCell(SAMPLE_TABLE_HTML, 10, 0, "test")).toThrow("Row 10 out of bounds");
  });

  it("should throw for out of bounds column", () => {
    expect(() => updateTableCell(SAMPLE_TABLE_HTML, 0, 10, "test")).toThrow("Column 10 out of bounds");
  });
});

describe("findTables", () => {
  it("should find single table", () => {
    const tables = findTables(SAMPLE_TABLE_HTML);
    expect(tables).toHaveLength(1);
  });

  it("should find multiple tables", () => {
    const html = `<div>${SAMPLE_TABLE_HTML}</div><p>text</p>${SAMPLE_TABLE_HTML}`;
    const tables = findTables(html);
    expect(tables).toHaveLength(2);
  });

  it("should return empty for no tables", () => {
    const tables = findTables("<div>No tables here</div>");
    expect(tables).toHaveLength(0);
  });
});
