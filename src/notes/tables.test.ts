import { describe, it, expect } from "vitest";
import { parseTable, applyTableEdits, findTables } from "./tables.js";

const SAMPLE_TABLE_HTML = `<object><table cellspacing="0" cellpadding="0" style="border-collapse: collapse">
<tbody>
<tr><td valign="top" style="border-style: solid"><div><b>Typ</b></div></td><td valign="top" style="border-style: solid"><div><b>Částka</b></div></td></tr>
<tr><td valign="top" style="border-style: solid"><div>Sociální</div></td><td valign="top" style="border-style: solid"><div>9 154 Kč</div></td></tr>
<tr><td valign="top" style="border-style: solid"><div>Zdravotní</div></td><td valign="top" style="border-style: solid"><div>3 848 Kč</div></td></tr>
</tbody>
</table></object>`;

const EMPTY_CELL = `<td valign="top"><div><br></div></td>`;
const EMPTY_CELLS_TABLE = `<object><table><tbody>
<tr class="r"><td><div>H1</div></td><td><div>H2</div></td><td><div>H3</div></td></tr>
<tr class="r">${EMPTY_CELL}${EMPTY_CELL}${EMPTY_CELL}</tr>
</tbody></table></object>`;

describe("parseTable", () => {
  it("parses rows and cells", () => {
    expect(parseTable(SAMPLE_TABLE_HTML).rows).toEqual([
      ["Typ", "Částka"],
      ["Sociální", "9 154 Kč"],
      ["Zdravotní", "3 848 Kč"],
    ]);
  });

  it("reports bold formatting per cell", () => {
    const result = parseTable(SAMPLE_TABLE_HTML);
    expect(result.formatting[0]).toEqual([{ bold: true }, { bold: true }]);
    expect(result.formatting[1]).toEqual([{ bold: false }, { bold: false }]);
  });

  it("returns only rows and formatting", () => {
    expect(Object.keys(parseTable(SAMPLE_TABLE_HTML)).sort()).toEqual(["formatting", "rows"]);
  });

  it("returns empty for non-table HTML", () => {
    expect(parseTable("<div>Not a table</div>")).toEqual({ rows: [], formatting: [] });
  });

  it("decodes HTML entities in cell text", () => {
    const html = `<object><table><tbody><tr><td><div>AT&amp;T &lt;b&gt; &#8364; &#x41; &amp;lt;</div></td></tr></tbody></table></object>`;
    expect(parseTable(html).rows).toEqual([["AT&T <b> € A &lt;"]]);
  });

  it("joins multi-line cells with newlines and drops empty lines", () => {
    const html = `<object><table><tbody><tr><td><div>first</div><div><br></div><div>second<br>third</div></td></tr></tbody></table></object>`;
    expect(parseTable(html).rows).toEqual([["first\nsecond\nthird"]]);
  });

  it("decodes the no-semicolon entities Apple Notes writes back", () => {
    const html = `<object><table><tbody><tr><td><div>$&amp cheap</div></td><td><div>&lt b &gt &quot;q&quot &nbspx</div></td></tr></tbody></table></object>`;
    expect(parseTable(html).rows).toEqual([["$& cheap", `< b > "q" &nbspx`]]);
  });

  it("leaves entity-like words without a semicolon untouched", () => {
    const html = `<object><table><tbody><tr><td><div>&ampersand &lte &amp1</div></td></tr></tbody></table></object>`;
    expect(parseTable(html).rows).toEqual([["&ampersand &lte &amp1"]]);
  });

  it("parses Apple Notes <td><br></td> empty cells as empty strings", () => {
    const html = `<object><table><tbody><tr><td valign="top"><br></td><td valign="top"><div>x</div></td></tr></tbody></table></object>`;
    expect(parseTable(html).rows).toEqual([["", "x"]]);
  });

  it("returns empty strings for empty cells", () => {
    expect(parseTable(EMPTY_CELLS_TABLE).rows[1]).toEqual(["", "", ""]);
  });
});

describe("applyTableEdits", () => {
  it("replaces only the targeted cell content", () => {
    const updated = applyTableEdits(SAMPLE_TABLE_HTML, 0, [{ row: 1, column: 0, value: "✅ Sociální" }]);
    expect(updated).toBe(
      SAMPLE_TABLE_HTML.replace("<div>Sociální</div>", "<div>✅ Sociální</div>")
    );
  });

  it("keeps bold formatting of the edited cell", () => {
    const updated = applyTableEdits(SAMPLE_TABLE_HTML, 0, [{ row: 0, column: 1, value: "Suma" }]);
    expect(parseTable(updated).rows[0]).toEqual(["Typ", "Suma"]);
    expect(updated).toContain("<div><b>Suma</b></div>");
  });

  it("edits the right cell when several cells are identical", () => {
    const updated = applyTableEdits(EMPTY_CELLS_TABLE, 0, [{ row: 1, column: 2, value: "x" }]);
    expect(parseTable(updated).rows[1]).toEqual(["", "", "x"]);
    expect(updated).toContain(`<tr class="r">${EMPTY_CELL}${EMPTY_CELL}<td valign="top"><div>x</div></td></tr>`);
  });

  it("edits an empty <td><br></td> cell that has no div", () => {
    const html = `<object><table><tbody><tr><td valign="top"><br></td><td valign="top"><br></td></tr></tbody></table></object>`;
    const updated = applyTableEdits(html, 0, [{ row: 0, column: 1, value: "x" }]);
    expect(updated).toBe(
      `<object><table><tbody><tr><td valign="top"><br></td><td valign="top"><div>x</div></td></tr></tbody></table></object>`
    );
    expect(parseTable(updated).rows).toEqual([["", "x"]]);
  });

  it("round-trips a $& value through the Notes re-serialized form", () => {
    const updated = applyTableEdits(EMPTY_CELLS_TABLE, 0, [{ row: 1, column: 0, value: "$& cheap" }]);
    expect(updated).toContain("<div>$&amp; cheap</div>");
    const notesForm = updated.replace("$&amp; cheap", () => "$&amp cheap");
    expect(parseTable(notesForm).rows[1][0]).toBe("$& cheap");
  });

  it("edits the right table when tables are identical", () => {
    const html = `${SAMPLE_TABLE_HTML}<p>between</p>${SAMPLE_TABLE_HTML}`;
    const updated = applyTableEdits(html, 1, [{ row: 2, column: 1, value: "0 Kč" }]);
    const [first, second] = findTables(updated);
    expect(first).toBe(SAMPLE_TABLE_HTML);
    expect(parseTable(second).rows[2]).toEqual(["Zdravotní", "0 Kč"]);
    expect(updated).toContain("<p>between</p>");
  });

  it("treats $ replacement patterns in values literally", () => {
    const updated = applyTableEdits(EMPTY_CELLS_TABLE, 0, [
      { row: 1, column: 0, value: "$&" },
      { row: 1, column: 1, value: "US$$5 $1 $`" },
    ]);
    expect(parseTable(updated).rows[1]).toEqual(["$&", "US$$5 $1 $`", ""]);
  });

  it("escapes values exactly once and round-trips through parseTable", () => {
    const updated = applyTableEdits(EMPTY_CELLS_TABLE, 0, [{ row: 1, column: 0, value: `AT&T <script>"x"` }]);
    expect(updated).toContain(`<div>AT&amp;T &lt;script&gt;&quot;x&quot;</div>`);
    expect(parseTable(updated).rows[1][0]).toBe(`AT&T <script>"x"`);
  });

  it("writes multi-line values as one div per line", () => {
    const updated = applyTableEdits(EMPTY_CELLS_TABLE, 0, [{ row: 1, column: 1, value: "a\n\nb" }]);
    expect(updated).toContain(`<td valign="top"><div>a</div><div><br></div><div>b</div></td>`);
    expect(parseTable(updated).rows[1][1]).toBe("a\nb");
  });

  it("applies several edits to the same table", () => {
    const updated = applyTableEdits(SAMPLE_TABLE_HTML, 0, [
      { row: 1, column: 1, value: "1 Kč" },
      { row: 2, column: 1, value: "2 Kč" },
    ]);
    expect(parseTable(updated).rows).toEqual([
      ["Typ", "Částka"],
      ["Sociální", "1 Kč"],
      ["Zdravotní", "2 Kč"],
    ]);
  });

  it("preserves surrounding note HTML", () => {
    const html = `<div>before $&</div>${SAMPLE_TABLE_HTML}<div>after</div>`;
    const updated = applyTableEdits(html, 0, [{ row: 1, column: 0, value: "x" }]);
    expect(updated.startsWith(`<div>before $&</div><object>`)).toBe(true);
    expect(updated.endsWith(`</table></object><div>after</div>`)).toBe(true);
  });

  it("throws for out of bounds table", () => {
    expect(() => applyTableEdits(SAMPLE_TABLE_HTML, 1, [])).toThrow(
      "Table index 1 out of bounds (note has 1 tables)"
    );
  });

  it("throws for out of bounds row", () => {
    expect(() => applyTableEdits(SAMPLE_TABLE_HTML, 0, [{ row: 10, column: 0, value: "x" }])).toThrow(
      "Row 10 out of bounds (table has 3 rows)"
    );
  });

  it("throws for out of bounds column", () => {
    expect(() => applyTableEdits(SAMPLE_TABLE_HTML, 0, [{ row: 0, column: 10, value: "x" }])).toThrow(
      "Column 10 out of bounds (row 0 has 2 columns)"
    );
  });

  it("throws for negative indices", () => {
    expect(() => applyTableEdits(SAMPLE_TABLE_HTML, 0, [{ row: -1, column: 0, value: "x" }])).toThrow(
      "Row -1 out of bounds"
    );
  });
});

describe("findTables", () => {
  it("finds a single table", () => {
    expect(findTables(SAMPLE_TABLE_HTML)).toEqual([SAMPLE_TABLE_HTML]);
  });

  it("finds multiple tables", () => {
    const html = `<div>${SAMPLE_TABLE_HTML}</div><p>text</p>${SAMPLE_TABLE_HTML}`;
    expect(findTables(html)).toEqual([SAMPLE_TABLE_HTML, SAMPLE_TABLE_HTML]);
  });

  it("returns empty for no tables", () => {
    expect(findTables("<div>No tables here</div>")).toHaveLength(0);
  });

  it("does not swallow an attachment object preceding a table", () => {
    const html = `<object data-filename="a.pdf"></object><p>x</p>${SAMPLE_TABLE_HTML}`;
    expect(findTables(html)).toEqual([SAMPLE_TABLE_HTML]);
  });
});
