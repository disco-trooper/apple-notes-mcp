// src/graph/extract.test.ts
import { describe, it, expect } from "vitest";
import { extractTags, extractOutlinks, extractMetadata } from "./extract.js";

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

  it("ignores hex colors", () => {
    const content = "Color #fff and #000000 and #a1b2c3 are not tags";
    expect(extractTags(content)).toEqual([]);
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
