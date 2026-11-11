import { describe, it, expect } from "vitest";
import { marked } from "marked";
import { htmlToMarkdown } from "./conversion.js";

const SAMPLE_TABLE_HTML = `<object><table cellspacing="0" cellpadding="0" style="border-collapse: collapse">
<tbody>
<tr><td valign="top" style="border-style: solid"><div><b>Typ</b></div></td><td valign="top" style="border-style: solid"><div><b>Částka</b></div></td></tr>
<tr><td valign="top" style="border-style: solid"><div>Sociální</div></td><td valign="top" style="border-style: solid"><div>9 154 Kč</div></td></tr>
<tr><td valign="top" style="border-style: solid"><div>Zdravotní</div></td><td valign="top" style="border-style: solid"><div>3 848 Kč</div></td></tr>
</tbody>
</table></object>`;

const SAMPLE_TABLE_MD = ["| Typ | Částka |", "|---|---|", "| Sociální | 9 154 Kč |", "| Zdravotní | 3 848 Kč |"].join(
  "\n"
);

describe("htmlToMarkdown", () => {
  describe("table conversion", () => {
    it("converts a table to a multi-line Markdown table", () => {
      expect(htmlToMarkdown(SAMPLE_TABLE_HTML)).toBe(SAMPLE_TABLE_MD);
    });

    it("keeps text, table and image attachment as separate blocks", () => {
      const html =
        '<div>Intro</div><object><table><tbody><tr><td><div>A</div></td><td><div>B</div></td></tr><tr><td><div>1</div></td><td><div>2</div></td></tr></tbody></table></object><img alt="screenshot" src="x.png">';
      expect(htmlToMarkdown(html)).toBe(
        "Intro\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n[Attachment: screenshot]"
      );
    });

    it("handles multiple tables", () => {
      const html = `<div>Some text</div>${SAMPLE_TABLE_HTML}<p>More text</p>${SAMPLE_TABLE_HTML}`;
      expect(htmlToMarkdown(html)).toBe(`Some text\n\n${SAMPLE_TABLE_MD}\n\nMore text\n\n${SAMPLE_TABLE_MD}`);
    });

    it("handles a header-only table", () => {
      const html = `<object><table><tbody>
        <tr><td><div>Col1</div></td><td><div>Col2</div></td></tr>
      </tbody></table></object>`;
      expect(htmlToMarkdown(html)).toBe("| Col1 | Col2 |\n|---|---|");
    });

    it("renders multi-line cells with <br> and decodes entities", () => {
      const html = `<object><table><tbody>
        <tr><td><div>H</div></td></tr>
        <tr><td><div>AT&amp;T</div><div>line 2</div></td></tr>
      </tbody></table></object>`;
      expect(htmlToMarkdown(html)).toBe("| H |\n|---|\n| AT&T<br>line 2 |");
    });

    it("keeps a table after an attachment object separate from the text between them", () => {
      const html = `<object data-filename="a.pdf"></object><p>between</p>${SAMPLE_TABLE_HTML}`;
      expect(htmlToMarkdown(html)).toBe(`[Attachment: a.pdf]\n\nbetween\n\n${SAMPLE_TABLE_MD}`);
    });

    it("keeps a table before an attachment object", () => {
      const html = `${SAMPLE_TABLE_HTML}<object data-filename="file.pdf"></object>`;
      expect(htmlToMarkdown(html)).toBe(`${SAMPLE_TABLE_MD}\n\n[Attachment: file.pdf]`);
    });
  });

  describe("attachment handling", () => {
    it("converts an attachment object to an unescaped placeholder", () => {
      expect(htmlToMarkdown(`<object data-filename="document.pdf">content</object>`)).toBe(
        "[Attachment: document.pdf]"
      );
    });

    it("uses the image alt text", () => {
      expect(htmlToMarkdown(`<img alt="screenshot" src="file.png">`)).toBe("[Attachment: screenshot]");
    });

    it("falls back to the image file name", () => {
      expect(htmlToMarkdown(`<img src="https://example.com/a/pic.png">`)).toBe("[Attachment: pic.png]");
    });

    it("does not use data: URIs as file names", () => {
      expect(htmlToMarkdown(`<img src="data:image/png;base64,iVBORw0KGgo/AAAA">`)).toBe("[Attachment: image]");
    });
  });

  describe("graph syntax survives escaping", () => {
    it("keeps [[wiki links]] unescaped", () => {
      expect(htmlToMarkdown("<div>See [[My Note]] and [[Other_Note]]</div>")).toBe(
        "See [[My Note]] and [[Other_Note]]"
      );
    });

    it("keeps tags with underscores and non-ASCII letters", () => {
      expect(htmlToMarkdown("<div>#my_tag #práce snake_case</div>")).toBe("#my_tag #práce snake_case");
    });

    it("still escapes Markdown-significant brackets and emphasis", () => {
      expect(htmlToMarkdown("<div>[x] _emph_ *bold*</div>")).toBe("\\[x\\] \\_emph\\_ \\*bold\\*");
    });
  });

  describe("edge cases", () => {
    it("returns empty string for empty input", () => {
      expect(htmlToMarkdown("")).toBe("");
    });

    it("handles null-like input", () => {
      expect(htmlToMarkdown(null as unknown as string)).toBe("");
    });

    it("handles plain text", () => {
      expect(htmlToMarkdown("<p>Hello world</p>")).toBe("Hello world");
    });
  });

  describe("pipe character escaping", () => {
    it("escapes pipe characters in cell content once", () => {
      const html = `<object><table><tbody>
        <tr><td><div>Name</div></td><td><div>Value</div></td></tr>
        <tr><td><div>Price | Tax</div></td><td><div>A | B | C</div></td></tr>
      </tbody></table></object>`;
      expect(htmlToMarkdown(html)).toBe("| Name | Value |\n|---|---|\n| Price \\| Tax | A \\| B \\| C |");
    });
  });

  describe("cell escaping", () => {
    it("escapes Markdown in cells so it stays literal after rendering", () => {
      const html = `<object><table><tbody>
        <tr><td><div>H</div></td></tr>
        <tr><td><div>2*3*4</div></td></tr>
        <tr><td><div>__init__.py</div></td></tr>
        <tr><td><div>\`code\`</div></td></tr>
        <tr><td><div>[docs](http://x)</div></td></tr>
      </tbody></table></object>`;
      const markdown = htmlToMarkdown(html);

      expect(markdown).toBe(
        [
          "| H |",
          "|---|",
          "| 2\\*3\\*4 |",
          "| \\_\\_init\\_\\_.py |",
          "| \\`code\\` |",
          "| \\[docs\\](http://x) |",
        ].join("\n")
      );

      // GFM autolinks the bare URL (as in body text); only the [docs](…) link must not form.
      const rendered = marked.parse(markdown, { async: false });
      for (const literal of ["2*3*4", "__init__.py", "`code`"]) {
        expect(rendered).toContain(`<td>${literal}</td>`);
      }
      expect(rendered).toContain("<td>[docs](");
      expect(rendered).not.toMatch(/<a [^>]*>docs<\/a>/);
      expect(rendered).not.toMatch(/<(em|strong|code)\b/);
    });
  });

  describe("wiki link followed by (", () => {
    it("escapes [[x]](u) so it is not left as a raw wiki link", () => {
      expect(htmlToMarkdown("<div>[[x]](u)</div>")).toBe("\\[\\[x\\]\\](u)");
    });
  });
});
