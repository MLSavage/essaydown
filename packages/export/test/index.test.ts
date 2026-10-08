import { describe, expect, it } from "vitest";
import {
  buildPandocArgs,
  isMissingResourceWarning,
  isValidPandocFormat,
  outputPathFor,
  resourceDirFor,
} from "../src/index.js";

describe("isValidPandocFormat", () => {
  it("accepts lowercase writer names", () => {
    expect(isValidPandocFormat("docx")).toBe(true);
    expect(isValidPandocFormat("html")).toBe(true);
    expect(isValidPandocFormat("commonmark_x")).toBe(true);
  });

  it("rejects a format carrying pandoc extension syntax or empty input", () => {
    expect(isValidPandocFormat("markdown+hard_line_breaks")).toBe(false);
    expect(isValidPandocFormat("DOCX")).toBe(false);
    expect(isValidPandocFormat("")).toBe(false);
    expect(isValidPandocFormat("1html")).toBe(false);
  });
});

describe("resourceDirFor", () => {
  it("is '.' for a document at the workspace root", () => {
    expect(resourceDirFor("essay.md")).toBe(".");
  });

  it("is the document's own directory, with no trailing slash, when nested", () => {
    expect(resourceDirFor("notes/essay.md")).toBe("notes");
    expect(resourceDirFor("a/b/essay.md")).toBe("a/b");
  });
});

describe("outputPathFor", () => {
  it("replaces the extension in the document's own directory for a known format", () => {
    expect(outputPathFor("essay.md", "docx")).toBe("essay.docx");
    expect(outputPathFor("notes/essay.md", "html")).toBe("notes/essay.html");
  });

  it("uses the format string itself as the extension for an 'Other' format", () => {
    expect(outputPathFor("essay.md", "odt")).toBe("essay.odt");
  });

  it("keeps a dotted stem (a leading dot is not an extension separator)", () => {
    expect(outputPathFor(".essay.md", "docx")).toBe(".essay.docx");
  });

  it("keeps the whole basename as the stem when there is no extension to replace", () => {
    expect(outputPathFor("README", "docx")).toBe("README.docx");
  });
});

describe("buildPandocArgs", () => {
  it("builds the fixed 9-token invocation with no positional input argument", () => {
    const args = buildPandocArgs({ resourceDir: ".", outPath: "essay.docx", format: "docx" });
    expect(args).toEqual([
      "-f",
      "gfm",
      "--standalone",
      "--resource-path=.",
      "-o",
      "essay.docx",
      "--pdf-engine=typst",
      "-t",
      "docx",
    ]);
  });

  it("rejects an invalid format before returning any arguments", () => {
    expect(() => buildPandocArgs({ resourceDir: ".", outPath: "essay.docx", format: "DOCX" })).toThrow(RangeError);
  });
});

describe("isMissingResourceWarning", () => {
  it("is true for pandoc's missing-image stderr line", () => {
    expect(
      isMissingResourceWarning("[WARNING] Could not fetch resource assets/essay/missing.png: replacing image with description"),
    ).toBe(true);
  });

  it("is false for empty stderr and for an unrelated warning", () => {
    expect(isMissingResourceWarning("")).toBe(false);
    expect(isMissingResourceWarning("[WARNING] Duplicate link reference")).toBe(false);
  });
});
