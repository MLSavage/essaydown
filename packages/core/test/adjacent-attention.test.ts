import type { Emphasis, Paragraph, Text } from "mdast";
import { describe, expect, it } from "vitest";
import { opensBesideAttentionRun } from "../src/format.js";

/**
 * Task 1.67 (DECISIONS #review-1-r9 O1): one guard per clause of `opensBesideAttentionRun`, the
 * predicate `handleEmphasis` and `handleStrong` take the other marker on, enumerated from the diff
 * rather than from the acceptance. Three of the four clauses are reached by
 * `packages/editor/test/adjacent-runs.test.ts` through the editor's own trees; the fourth — the
 * parent `mdast-util-to-markdown` types as possibly `undefined`, which only `root` is ever
 * dispatched with — is not reachable from a phrasing node at all, which is why it is asserted
 * here on the function directly.
 */

const text = (value: string): Text => ({ type: "text", value });
const emphasis = (value: string): Emphasis => ({ type: "emphasis", children: [text(value)] });

function paragraph(...children: Paragraph["children"]): Paragraph {
  return { type: "paragraph", children };
}

describe("opensBesideAttentionRun: the four clauses of the marker rule", () => {
  it("is false when the bytes before the run do not end in `*`, whatever the previous sibling is", () => {
    const first = emphasis("a");
    const second = emphasis("z");
    expect(opensBesideAttentionRun(second, paragraph(first, second), "*a*")).toBe(true);
    expect(opensBesideAttentionRun(second, paragraph(first, second), "_a_")).toBe(false);
  });

  it("is false when the previous sibling is not an attention run, though the bytes end in `*`", () => {
    const before = text("*");
    const run = emphasis("z");
    expect(opensBesideAttentionRun(run, paragraph(before, run), "\\*")).toBe(false);
  });

  it("is false for the first child, whose `*` is its parent's opening delimiter", () => {
    const inner = emphasis("a");
    expect(opensBesideAttentionRun(inner, { type: "strong", children: [inner] }, "**")).toBe(false);
  });

  it("is false without a parent, the one node `mdast-util-to-markdown` types as parentless", () => {
    expect(opensBesideAttentionRun(emphasis("z"), undefined, "*")).toBe(false);
  });
});
