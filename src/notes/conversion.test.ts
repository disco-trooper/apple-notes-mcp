import { describe, it, expect } from "vitest";
import { htmlToMarkdown } from "./conversion.js";

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
});
