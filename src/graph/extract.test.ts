// src/graph/extract.test.ts
import { describe, it, expect } from "vitest";
import { extractTags, extractOutlinks, extractMetadata, resolveLink } from "./extract.js";
import { htmlToMarkdown } from "../notes/conversion.js";

describe("extractTags", () => {
  it("extracts simple hashtags", () => {
    const content = "This is a #project about #coding";
    expect(extractTags(content)).toEqual(["project", "coding"]);
  });

  it("handles hyphenated tags", () => {
    const content = "Working on #my-project and #some-idea";
    expect(extractTags(content)).toEqual(["my-project", "some-idea"]);
  });

  it("normalizes to lowercase", () => {
    const content = "#Project #IDEA #Mixed";
    expect(extractTags(content)).toEqual(["project", "idea", "mixed"]);
  });

  it("deduplicates tags", () => {
    const content = "#project #idea #project";
    expect(extractTags(content)).toEqual(["project", "idea"]);
  });

  it("returns empty array for no tags", () => {
    expect(extractTags("No tags here")).toEqual([]);
  });

  it("ignores tags in code blocks", () => {
    const content = "Real #tag\n```\n#not-a-tag\n```\nAnother #real";
    expect(extractTags(content)).toEqual(["tag", "real"]);
  });

  it("ignores tags in inline code", () => {
    const content = "Real #tag and `#code-tag` should ignore inline";
    expect(extractTags(content)).toEqual(["tag"]);
  });

  it("ignores hex colors, including all-letter ones", () => {
    const content = "Color #000 #ddd #ffffff #a1b2c3 #ff0000cc #bad #cafe are not tags";
    expect(extractTags(content)).toEqual([]);
  });

  it("ignores single-character tags", () => {
    expect(extractTags("#a #x and #ok")).toEqual(["ok"]);
  });

  it("keeps real words that are not hex", () => {
    expect(extractTags("#workoutlog #my_tag #idea")).toEqual(["workoutlog", "my_tag", "idea"]);
  });

  it("keeps Unicode letters", () => {
    expect(extractTags("#práce #škola #Žluťoučký")).toEqual(["práce", "škola", "žluťoučký"]);
  });

  it("ignores URL fragments, mid-word hashes and HTML entities", () => {
    const content = "See https://a.b/c#frag and foo#bar and &#123; but #real";
    expect(extractTags(content)).toEqual(["real"]);
  });

  it("ignores purely numeric references", () => {
    expect(extractTags("issue #42 and #2024")).toEqual([]);
  });

  it("drops trailing hyphens", () => {
    expect(extractTags("#todo- next")).toEqual(["todo"]);
  });

  it("reads tags inside Turndown italics", () => {
    expect(extractTags("_#idea_")).toEqual(["idea"]);
    expect(extractTags("_about #idea_")).toEqual(["idea"]);
    expect(extractTags(htmlToMarkdown("<div><i>#idea</i></div>"))).toEqual(["idea"]);
  });

  it("still ignores a hash after an intraword underscore", () => {
    expect(extractTags("foo_#bar")).toEqual([]);
  });

  it("keeps tags that contain letters mixed with numbers", () => {
    const content = "#project1 #2024goals #abc123xyz";
    expect(extractTags(content)).toEqual(["project1", "2024goals", "abc123xyz"]);
  });

  it("extracts tag at string boundaries", () => {
    expect(extractTags("#start of content")).toEqual(["start"]);
    expect(extractTags("end of #content")).toEqual(["content"]);
  });
});

describe("extractOutlinks", () => {
  it("extracts wiki-style links", () => {
    const content = "See [[Meeting Notes]] and [[Project Plan]]";
    expect(extractOutlinks(content)).toEqual(["Meeting Notes", "Project Plan"]);
  });

  it("handles links with special characters", () => {
    const content = "Check [[Note with / slash]] and [[Note: with colon]]";
    expect(extractOutlinks(content)).toEqual(["Note with / slash", "Note: with colon"]);
  });

  it("deduplicates links", () => {
    const content = "[[Note]] and [[Other]] and [[Note]]";
    expect(extractOutlinks(content)).toEqual(["Note", "Other"]);
  });

  it("returns empty array for no links", () => {
    expect(extractOutlinks("No links here")).toEqual([]);
  });

  it("ignores links in code blocks", () => {
    const content = "Real [[Link]]\n```\n[[not-a-link]]\n```";
    expect(extractOutlinks(content)).toEqual(["Link"]);
  });

  it("strips aliases but keeps # targets for lookup", () => {
    expect(extractOutlinks("[[Title|alias]] [[Other#Heading]] [[C# cheatsheet]] [[Title]]")).toEqual([
      "Title",
      "Other#Heading",
      "C# cheatsheet",
    ]);
  });
});

describe("resolveLink", () => {
  const byTitle = new Map([
    ["c# cheatsheet", "cs"],
    ["c", "c-note"],
    ["note", "n"],
  ]);

  it("prefers the full title over the part before #", () => {
    expect(resolveLink("C# cheatsheet", byTitle)).toBe("cs");
  });

  it("falls back to the title before # for heading anchors", () => {
    expect(resolveLink("Note#h", byTitle)).toBe("n");
  });

  it("returns undefined when neither form matches", () => {
    expect(resolveLink("Missing#h", byTitle)).toBeUndefined();
  });
});

describe("extractMetadata", () => {
  it("extracts both tags and outlinks", () => {
    const content = "A #project note linking to [[Other Note]]";
    expect(extractMetadata(content)).toEqual({
      tags: ["project"],
      outlinks: ["Other Note"],
    });
  });
});

describe("extractMetadata on htmlToMarkdown output", () => {
  it("finds tags and links that Turndown backslash-escapes", () => {
    const markdown = htmlToMarkdown(
      "<div>[[Meeting Notes]] #my_tag #práce #ffffff</div><div>[[Plan|the plan]] https://x.com/p#sec</div>"
    );
    expect(extractMetadata(markdown)).toEqual({
      tags: ["my_tag", "práce"],
      outlinks: ["Meeting Notes", "Plan"],
    });
  });

  it("keeps a wiki link followed by ( escaped, so it is not an outlink", () => {
    const markdown = htmlToMarkdown("<div>[[x]](u) and [[y]]</div>");
    expect(markdown).toBe("\\[\\[x\\]\\](u) and [[y]]");
    expect(extractOutlinks(markdown)).toEqual(["y"]);
  });
});
