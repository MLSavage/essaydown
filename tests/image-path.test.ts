import { describe, expect, it } from "vitest";
import { imageAbsolutePathFor } from "../apps/desktop/src/workspace/paths.js";

// apps/desktop/src/workspace/paths.ts's imageAbsolutePathFor (task 2.6): the rendered view's
// `absolutePath = resolve(docDir, relativeSrc)` (PRD §6.4), pure and filesystem-free, so this is
// unit-tested directly rather than only through e2e/shell.

describe("imageAbsolutePathFor", () => {
  it("joins a same-directory relative src onto the workspace root", () => {
    expect(imageAbsolutePathFor("/work/ws", "a.md", "assets/a/img.png")).toBe(
      "/work/ws/assets/a/img.png",
    );
  });

  it("resolves against the document's own directory for a doc in a sub-folder", () => {
    expect(imageAbsolutePathFor("/work/ws", "sub/doc.md", "assets/doc/img.png")).toBe(
      "/work/ws/sub/assets/doc/img.png",
    );
  });

  it("walks a leading `..` out of the document's directory, not out of the root", () => {
    expect(imageAbsolutePathFor("/work/ws", "sub/doc.md", "../shared/img.png")).toBe(
      "/work/ws/shared/img.png",
    );
  });

  it("drops `.` segments and collapses a `..` that only cancels one of its own segments", () => {
    expect(imageAbsolutePathFor("/work/ws", "sub/doc.md", "./nested/../img.png")).toBe(
      "/work/ws/sub/img.png",
    );
  });

  it("never negative-indexes past the resolved root on an unmatched `..`", () => {
    expect(imageAbsolutePathFor("/work/ws", "a.md", "../../img.png")).toBe("/work/ws/img.png");
  });

  it("uses backslashes throughout when the root is a Windows path", () => {
    expect(imageAbsolutePathFor("C:\\Users\\me\\ws", "sub/doc.md", "assets/doc/img.png")).toBe(
      "C:\\Users\\me\\ws\\sub\\assets\\doc\\img.png",
    );
  });

  it("does not double a separator when the root already ends with one", () => {
    expect(imageAbsolutePathFor("/work/ws/", "a.md", "x.png")).toBe("/work/ws/x.png");
  });
});
