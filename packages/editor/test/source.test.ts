import { describe, expect, it } from "vitest";
import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { highlightTree } from "@lezer/highlight";
import { TOKEN_CLASSES, sourceExtensions, tokenHighlightStyle } from "../src/source.js";

/**
 * The headless half of task 1.5. `e2e/web/editor-source.spec.ts` is the acceptance — it asserts
 * computed colors in a real browser — and this file is where the tag-to-class mapping itself is
 * covered: no DOM is needed, since `highlightTree` walks the parsed tree directly (the module
 * comment in `source.ts` explains why the stock markdown highlighting cannot be used as-is).
 */

/** The classes `highlightTree` reports for `doc`, in order, alongside the text they cover. */
function classify(doc: string): Array<{ classes: string; text: string }> {
  const state = EditorState.create({ doc, extensions: sourceExtensions() });
  const tree = syntaxTree(state);
  const found: Array<{ classes: string; text: string }> = [];
  highlightTree(tree, tokenHighlightStyle, (from, to, classes) => {
    found.push({ classes, text: doc.slice(from, to) });
  });
  return found;
}

describe("source view token classes", () => {
  it("colors an ATX heading, its depth siblings, and a setext heading alike", () => {
    const found = classify("# One\n\n###### Six\n\nTwo\n==\n");
    expect(found).toContainEqual({ classes: TOKEN_CLASSES.heading, text: "# One" });
    expect(found).toContainEqual({ classes: TOKEN_CLASSES.heading, text: "###### Six" });
    expect(found).toContainEqual({ classes: TOKEN_CLASSES.heading, text: "Two\n==" });
  });

  it("colors emphasis and strong, marks included", () => {
    const found = classify("Hello *a* and **b**.\n");
    expect(found).toContainEqual({ classes: TOKEN_CLASSES.emphasis, text: "*a*" });
    expect(found).toContainEqual({ classes: TOKEN_CLASSES.emphasis, text: "**b**" });
  });

  it("colors a link, an image, and a bare autolink the same class", () => {
    const found = classify("[a](u) ![alt](i.png) <https://example.com>\n");
    expect(found).toContainEqual({ classes: TOKEN_CLASSES.link, text: "[a](u)" });
    expect(found).toContainEqual({ classes: TOKEN_CLASSES.link, text: "![alt](i.png)" });
    expect(found).toContainEqual({
      classes: TOKEN_CLASSES.link,
      text: "<https://example.com>",
    });
  });

  it("colors inline code and a fenced code block the same class", () => {
    const found = classify("`x` and:\n\n```js\nconst x = 1;\n```\n");
    expect(found).toContainEqual({ classes: TOKEN_CLASSES.code, text: "`x`" });
    expect(found).toContainEqual({
      classes: TOKEN_CLASSES.code,
      text: "```js\nconst x = 1;\n```",
    });
  });

  it("colors a blockquote's marker", () => {
    const found = classify("> quoted\n");
    expect(found).toContainEqual({ classes: TOKEN_CLASSES.blockquote, text: "> " });
  });

  it("colors a bullet marker and an ordered marker the same class", () => {
    const found = classify("- a\n- b\n\n1. c\n2. d\n");
    expect(found).toContainEqual({ classes: TOKEN_CLASSES.listMarker, text: "-" });
    expect(found).toContainEqual({ classes: TOKEN_CLASSES.listMarker, text: "1." });
    expect(found).toContainEqual({ classes: TOKEN_CLASSES.listMarker, text: "2." });
  });

  it("colors table delimiters, header and body rows alike", () => {
    const found = classify("| a | b |\n| --- | --- |\n| 1 | 2 |\n");
    const delimiters = found.filter((f) => f.classes === TOKEN_CLASSES.tableDelimiter);
    expect(delimiters.length).toBeGreaterThan(0);
    expect(delimiters.some((f) => f.text === "| --- | --- |")).toBe(true);
  });

  it("leaves plain paragraph text with no token class", () => {
    const found = classify("Plain text, nothing special.\n");
    expect(found).toEqual([]);
  });

  it("does not give a task-list checkbox its own class — GFM's TaskList extension is not enabled", () => {
    const found = classify("- [ ] not a task, GFM disabled\n");
    expect(found).toEqual([{ classes: TOKEN_CLASSES.listMarker, text: "-" }]);
  });

  it("all 7 classes are distinct", () => {
    expect(new Set(Object.values(TOKEN_CLASSES)).size).toBe(7);
  });
});
