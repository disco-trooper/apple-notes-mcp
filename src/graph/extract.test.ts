// src/graph/extract.test.ts
import { describe, it, expect } from "vitest";
import { extractTags, extractOutlinks, extractMetadata } from "./extract.js";
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

  it("ignores hex colors that contain a digit", () => {
    const content = "Color #000 and #a1b2c3 and #ff0000cc are not tags";
    expect(extractTags(content)).toEqual([]);
  });

  it("keeps words made of hex letters", () => {
    expect(extractTags("#bad #cafe #fade #fff")).toEqual(["bad", "cafe", "fade", "fff"]);
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

  it("resolves aliases and heading anchors to the note title", () => {
    expect(extractOutlinks("[[Title|alias]] [[Other#Heading]] [[Title]]")).toEqual(["Title", "Other"]);
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
      "<div>[[Meeting Notes]] #my_tag #práce #bad</div><div>[[Plan|the plan]] https://x.com/p#sec</div>"
    );
    expect(extractMetadata(markdown)).toEqual({
      tags: ["my_tag", "práce", "bad"],
      outlinks: ["Meeting Notes", "Plan"],
    });
  });
});
