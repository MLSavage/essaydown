import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BlockContent, List, ListItem, Root, RootContent } from "mdast";
import type { Node as PMNode } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import { format } from "../../core/src/format.js";
import { parse } from "../../core/src/parse.js";
import { mdastToPM, pmToMdast, schema } from "../src/schema.js";
import {
  pasteIntoEveryListItemParagraph,
  splitEveryListItemParagraph,
  twoLinePasteSlice,
} from "./typing-legs.js";

/**
 * Task 1.36 (DECISIONS #review-1-r3 I2, Sol's blocker): a `list_item` kept its parsed `spread`
 * after a two-line plain-text paste gave it a second paragraph, and the enclosing `list` kept its
 * own, so `format` wrote the item as tight — one line ending before the nested list — while the
 * blank line two paragraphs need made `parse` read the item as loose and write a blank line
 * before the nested list too. Copy Markdown put bytes on the clipboard that were not a
 * `parse`∘`format` fixed point and reported "Copied Markdown". A parse-time structural attribute
 * outlived the structure it described — a block-level class no inline leg could reach.
 *
 * Three suites. The first records the two `parse(format(·))` confirmations the rule is built on
 * as tests, never as comments: every pair of block kinds a list item can hold, written tight and
 * written loose, and the list that holds a spread item. The second is one guard per case the
 * task names (Sol's shape at the top level and nested; a tight item whose second child is a
 * nested list; a loose and a tight list unchanged; the fuzz shape, `tr.split`; the blank line
 * before the nested list present and absent) plus one per clause read from the diff. The third
 * is the seed guard for the corpus leg in `editor-fixed-point.test.ts`, which is titled for the
 * list split. Every guard asserts the bytes and the fixed point.
 */

const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));

function read(name: string): string {
  return readFileSync(`${FIXTURES}/${name}`, "utf8");
}

/** `pmToMdast` of the editor's tree for `root`, with no transaction between the two trips. */
function through(root: Root): Root {
  return pmToMdast(mdastToPM(root));
}

/** `format` of the editor's tree for the document `doc`, with no front matter. */
function bytesOf(doc: PMNode): string {
  return format(pmToMdast({ doc, frontMatter: null }));
}

/**
 * The tree written as a nested shape with every `spread` flag shown, so that "the parse of the
 * bytes is the tree they were written from" compares structure and the flags at once.
 */
function shape(node: RootContent | Root): string {
  if (node.type === "list" || node.type === "listItem") {
    return `${node.type}(${String(node.spread)})[${node.children.map(shape).join(",")}]`;
  }
  if ("children" in node) return `${node.type}[${node.children.map(shape).join(",")}]`;
  return node.type;
}

function text(value: string): { type: "text"; value: string } {
  return { type: "text", value };
}

function paragraph(value: string): BlockContent {
  return { type: "paragraph", children: [text(value)] };
}

function item(spread: boolean, ...children: BlockContent[]): ListItem {
  return { type: "listItem", spread, checked: null, children };
}

function list(
  items: ListItem[],
  ordered = false,
  start: number | null = null,
  spread = false,
): List {
  return { type: "list", ordered, start, spread, children: items };
}

const fence: BlockContent = { type: "code", lang: null, meta: null, value: "c" };

const table: BlockContent = {
  type: "table",
  align: [null],
  children: [
    { type: "tableRow", children: [{ type: "tableCell", children: [text("t")] }] },
    { type: "tableRow", children: [{ type: "tableCell", children: [text("u")] }] },
  ],
};

/**
 * Every kind of block a list item can hold, with the variants the rule reads: a container's last
 * leaf (a paragraph or a fence, directly or through a nested list) and a list's ability to
 * interrupt a paragraph (its start, its first item). `html` is the one kind not here: a raw block
 * is the parser's own bytes, and its guard is separate.
 */
const KINDS: Record<string, () => BlockContent> = {
  paragraph: () => paragraph("p"),
  heading: () => ({ type: "heading", depth: 2, children: [text("h")] }),
  "blockquote ending in a paragraph": () => ({ type: "blockquote", children: [paragraph("q")] }),
  "blockquote ending in a fence": () => ({ type: "blockquote", children: [fence] }),
  "blockquote ending in a list": () => ({
    type: "blockquote",
    children: [list([item(false, paragraph("q"))])],
  }),
  fence: () => fence,
  "thematic break": () => ({ type: "thematicBreak" }),
  "bullet list ending in a paragraph": () => list([item(false, paragraph("i"))]),
  "bullet list ending in a fence": () => list([item(false, paragraph("i"), fence)]),
  "bullet list ending in a nested list's paragraph": () =>
    list([item(false, paragraph("i"), list([item(false, paragraph("j"))]))]),
  "ordered list starting at 1": () => list([item(false, paragraph("i"))], true, 1),
  "ordered list with no start": () => list([item(false, paragraph("i"))], true, null),
  "ordered list starting at 2": () => list([item(false, paragraph("i"))], true, 2),
  "list whose first item is empty": () => list([item(false), item(false, paragraph("i"))]),
  table: () => table,
};

/** A one-item bullet list holding `children` in an item parsed as tight. */
function tightItem(...children: BlockContent[]): Root {
  return { type: "root", children: [list([item(false, ...children)])] };
}

/** The blank line before `- Second level one` in `nested-lists.md`'s first item. */
const BLANK_BEFORE_NESTED = "\n\n  - Second level one\n";
const TIGHT_BEFORE_NESTED = "\n  - Second level one\n";

const NESTED_LISTS = "nested-lists.md";

/** Sol's two strings, as the reconciliation recorded them (DECISIONS #review-1-r3 I2). */
const SOL_COPIED =
  "- Top level oneX\n\n  Y\n  - Second level one\n    - Third level one\n  - Second level two\n- Top level two\n";
const SOL_REPARSED =
  "- Top level oneX\n\n  Y\n\n  - Second level one\n    - Third level one\n  - Second level two\n- Top level two\n";

/** The editor's tree for `nested-lists.md`, and the end position of the paragraph `${text}`. */
function nestedLists(): { doc: PMNode; endOf: (text: string) => number } {
  const { doc } = mdastToPM(parse(read(NESTED_LISTS)));
  return {
    doc,
    endOf: (wanted) => {
      let end = -1;
      doc.descendants((node, pos) => {
        if (node.type === schema.nodes.paragraph && node.textContent === wanted)
          end = pos + 1 + node.content.size;
        return end === -1;
      });
      expect(end).toBeGreaterThan(-1);
      return end;
    },
  };
}

/** Sol's route: the two-paragraph slice of a two-line plain-text paste, at `pos`. */
function pasteAt(doc: PMNode, pos: number, first: string, second: string): PMNode {
  const tr = EditorState.create({ doc }).tr;
  return tr
    .setSelection(TextSelection.create(tr.doc, pos))
    .replaceSelection(twoLinePasteSlice(first, second)).doc;
}

/** The fixed point of `parse`∘`format`, the finding's own property, asserted on every guard. */
function expectFixedPoint(out: string): void {
  expect(format(parse(out))).toBe(out);
}

describe("the two parse(format(·)) confirmations the derivation is built on (task 1.36)", () => {
  const names = Object.keys(KINDS);

  it("enumerates every pair of block kinds", () => {
    expect(names.length).toBeGreaterThan(1);
  });

  for (const leftName of names) {
    for (const rightName of names) {
      it(`confirmation 1, ${leftName} then ${rightName}: the item is spread exactly when the tight bytes do not reparse to the tight pair, and the bytes are the tree`, () => {
        const root = tightItem(KINDS[leftName](), KINDS[rightName]());
        const derived = through(root);
        const out = format(derived);
        // The derivation is what parse reads back: the bytes reparse to the tree they were
        // written from, spread flags included, and are a fixed point.
        expect(shape(parse(out))).toBe(shape(derived));
        expectFixedPoint(out);

        // An item parse would read as tight stays tight (the derivation adds nothing the parser
        // would not need): the item is spread exactly when the same pair written tight — the
        // parsed flag alone, before this task — comes back as something other than itself.
        const tight = format(root);
        const [derivedItem] = (derived.children[0] as List).children;
        expect(derivedItem.spread).toBe(shape(parse(tight)) !== shape(root));
        if (!derivedItem.spread) expect(out).toBe(tight);
      });
    }
  }

  it("confirmation 1, the certain case: paragraph then paragraph is written with a blank line whatever the flag says, and parse reads that as spread", () => {
    const tight = format(tightItem(paragraph("a"), paragraph("b")));
    expect(tight).toBe("- a\n\n  b\n");
    const [parsedItem] = (parse(tight).children[0] as List).children;
    expect(parsedItem.spread).toBe(true);
    expect(format(through(tightItem(paragraph("a"), paragraph("b"))))).toBe(tight);
  });

  it("confirmation 2 (the reconciliation's two strings): the reparse of Sol's bytes keeps `- Second level two` and `- Top level two` without a blank line, so the list does not flip", () => {
    expect(format(parse(SOL_COPIED))).toBe(SOL_REPARSED);
    const [outer] = parse(SOL_REPARSED).children as List[];
    expect(outer.spread).toBe(false);
    expect(outer.children.map((child) => child.spread)).toEqual([true, false]);
    expectFixedPoint(SOL_REPARSED);
  });

  it("confirmation 2: a tight list holding a spread item stays tight through parse(format(·)), and a loose one stays loose", () => {
    for (const spread of [false, true]) {
      const root: Root = {
        type: "root",
        children: [
          list(
            [item(true, paragraph("a"), paragraph("b")), item(false, paragraph("c"))],
            false,
            null,
            spread,
          ),
        ],
      };
      const out = format(through(root));
      expect(out).toBe(spread ? "- a\n\n  b\n\n- c\n" : "- a\n\n  b\n- c\n");
      expect(shape(parse(out))).toBe(shape(root));
      expectFixedPoint(out);
    }
  });

  it("clause (html): a raw block and its neighbour are the parser's own — `<pre>` then a paragraph is a tight pair the parser produces, and stays one", () => {
    const source = "- <pre>x</pre>\n  p\n";
    const parsed = parse(source);
    const [parsedItem] = (parsed.children[0] as List).children;
    expect(parsedItem.children.map((child) => child.type)).toEqual(["html", "paragraph"]);
    expect(parsedItem.spread).toBe(false);
    const out = format(through(parsed));
    expect(out).toBe(source);
    expectFixedPoint(out);
  });
});

describe("the list item's spread after an edit (task 1.36): one guard per case, each asserting bytes and the fixed point", () => {
  it("Sol's shape, top level: a second paragraph pasted into a tight item is spread, and the blank line before the nested list is present", () => {
    const { doc, endOf } = nestedLists();
    const pasted = pasteAt(doc, endOf("Top level one"), "X", "Y");
    const out = bytesOf(pasted);
    // Before this task: SOL_COPIED, whose reparse is SOL_REPARSED.
    expect(out).toBe(SOL_REPARSED);
    expect(out).toContain(BLANK_BEFORE_NESTED);
    expectFixedPoint(out);
    // The item's structure is what the paste built: two paragraphs, then the nested list.
    const [outer] = parse(out).children as List[];
    expect(outer.children[0].children.map((child) => child.type)).toEqual([
      "paragraph",
      "paragraph",
      "list",
    ]);
    expect(outer.children[0].spread).toBe(true);
    expect(outer.spread).toBe(false);
  });

  it("Sol's shape, nested: the same paste into a nested tight item spreads that item only, and its blank line is before the third level", () => {
    const { doc, endOf } = nestedLists();
    const pasted = pasteAt(doc, endOf("Second level one"), "X", "Y");
    const out = bytesOf(pasted);
    expect(out).toBe(
      "- Top level one\n  - Second level oneX\n\n    Y\n\n    - Third level one\n  - Second level two\n- Top level two\n",
    );
    expectFixedPoint(out);
    const [outer] = parse(out).children as List[];
    const inner = outer.children[0].children[1] as List;
    expect(outer.children[0].spread).toBe(false);
    expect(inner.spread).toBe(false);
    expect(inner.children.map((child) => child.spread)).toEqual([true, false]);
  });

  it("a tight item whose second child is a nested list, unchanged, is still tight: no blank line before the nested list", () => {
    const { doc } = nestedLists();
    const out = bytesOf(doc);
    expect(out).toBe(format(parse(read(NESTED_LISTS))));
    expect(out).toContain(TIGHT_BEFORE_NESTED);
    expect(out).not.toContain(BLANK_BEFORE_NESTED);
    expectFixedPoint(out);
  });

  it("a loose list unchanged stays loose, and a loose item whose second child is a nested list keeps its blank line (the parsed flag is kept)", () => {
    const source = "- a\n\n  - b\n\n- c\n";
    const out = format(through(parse(source)));
    expect(out).toBe(source);
    expectFixedPoint(out);
    const [outer] = parse(out).children as List[];
    expect(outer.spread).toBe(true);
    expect(outer.children[0].spread).toBe(true);
  });

  it("a tight list unchanged stays tight", () => {
    const source = read("list-unordered.md");
    const out = format(through(parse(source)));
    expect(out).toBe(format(parse(source)));
    expect(out).not.toContain("\n\n");
    expectFixedPoint(out);
  });

  it("the fuzz shape: `tr.split` inside an item's paragraph gives two paragraphs, the item is spread, and the blank line before the nested list is present", () => {
    const { doc, endOf } = nestedLists();
    const tr = EditorState.create({ doc }).tr;
    const split = tr.split(endOf("Top level one") - " one".length).doc;
    const out = bytesOf(split);
    expect(out).toBe(
      "- Top level\n\n  one\n\n  - Second level one\n    - Third level one\n  - Second level two\n- Top level two\n",
    );
    expect(out).toContain(BLANK_BEFORE_NESTED);
    expectFixedPoint(out);
  });

  it("the absence case: a split at the paragraph's end leaves an empty paragraph, which is dropped before the derivation, so the item stays tight", () => {
    const { doc, endOf } = nestedLists();
    const tr = EditorState.create({ doc }).tr;
    const split = tr.split(endOf("Top level one")).doc;
    // Presence: the editor's tree does hold the second, empty paragraph.
    expect(split.firstChild?.firstChild?.childCount).toBe(3);
    const out = bytesOf(split);
    expect(out).toBe(format(parse(read(NESTED_LISTS))));
    expect(out).toContain(TIGHT_BEFORE_NESTED);
    expectFixedPoint(out);
  });

  it("clause: the parsed flag is kept — a loose item that loses its second paragraph by a join still writes its blank line before the nested list", () => {
    const source = "- a\n\n  b\n\n  - c\n";
    const { doc } = mdastToPM(parse(source));
    // The join a Backspace at the start of `b` makes: the two paragraphs become one.
    const tr = EditorState.create({ doc }).tr;
    let bStart = -1;
    doc.descendants((node, pos) => {
      if (node.type === schema.nodes.paragraph && node.textContent === "b") bStart = pos;
      return bStart === -1;
    });
    const joined = tr.join(bStart).doc;
    expect(joined.firstChild?.firstChild?.childCount).toBe(2);
    const out = bytesOf(joined);
    expect(out).toBe("- ab\n\n  - c\n");
    expectFixedPoint(out);
  });

  it("clause: the node attrs are untouched — the derivation is in the conversion, and the editor's item still carries its parsed `spread`", () => {
    const { doc, endOf } = nestedLists();
    const pasted = pasteAt(doc, endOf("Top level one"), "X", "Y");
    const editorItem = pasted.firstChild?.firstChild as PMNode;
    expect(editorItem.type).toBe(schema.nodes.list_item);
    expect(editorItem.attrs.spread).toBe(false);
    const [outer] = pmToMdast({ doc: pasted, frontMatter: null }).children as List[];
    expect(outer.children[0].spread).toBe(true);
  });

  it("clause: a list's spread is copied — a tight list whose item the paste spreads stays tight, a loose one stays loose", () => {
    for (const source of ["- a\n- b\n", "- a\n\n- b\n"]) {
      const { doc } = mdastToPM(parse(source));
      // `list`, `list_item` and `paragraph` each open one position before `a`.
      const pasted = pasteAt(doc, 3 + "a".length, "X", "Y");
      const out = bytesOf(pasted);
      const between = source.includes("\n\n") ? "\n\n" : "\n";
      expect(out).toBe(`- aX\n\n  Y${between}- b\n`);
      expectFixedPoint(out);
      const [outer] = parse(out).children as List[];
      expect(outer.spread).toBe(source.includes("\n\n"));
    }
  });
});

describe("the list-split leg's seeds (task 1.36)", () => {
  it("the paste transaction is Sol's route: at the end of every item's first paragraph in nested-lists.md, and the bytes are its reparse", () => {
    const { doc } = nestedLists();
    const pasted = pasteIntoEveryListItemParagraph(doc);
    expect(pasted.items).toBe(5);
    const out = bytesOf(pasted.doc);
    expect(out).toBe(
      "- Top level oneX\n\n  Y\n\n  - Second level oneX\n\n    Y\n\n    - Third level oneX\n\n      Y\n  - Second level twoX\n\n    Y\n- Top level twoX\n\n  Y\n",
    );
    expectFixedPoint(out);
  });

  it("the split transaction is the fuzz shape at every item's first paragraph's end in nested-lists.md, and the bytes are the fixture's own", () => {
    const { doc } = nestedLists();
    const split = splitEveryListItemParagraph(doc);
    expect(split.items).toBe(5);
    expect(split.doc.eq(doc)).toBe(false);
    const out = bytesOf(split.doc);
    expect(out).toBe(format(parse(read(NESTED_LISTS))));
    expectFixedPoint(out);
  });

  it("neither transaction reaches a document without a list item", () => {
    const { doc } = mdastToPM(parse("a\n"));
    expect(pasteIntoEveryListItemParagraph(doc).items).toBe(0);
    expect(splitEveryListItemParagraph(doc).items).toBe(0);
    expect(pasteIntoEveryListItemParagraph(doc).doc.eq(doc)).toBe(true);
  });
});
