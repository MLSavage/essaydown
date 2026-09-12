import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Root } from "mdast";
import type { Mark as PMMark, Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { format } from "../../core/src/format.js";
import { parse } from "../../core/src/parse.js";
import { mdastToPM, pmToMdast, schema } from "../src/schema.js";
import {
  deleteAtEveryBlockEnd,
  deleteToEveryMarkedRunEnd,
  letterFor,
  typeInsideEveryBlock,
  typeSpaceAtEveryBlockEnd,
  typeSpaceAtEveryLinkEnd,
  typeSpaceInsideEveryMarkedRun,
} from "./typing-legs.js";

/**
 * Task 1.13 (DECISIONS #review-1-r0 F1): the editor's tree kept the whitespace micromark strips,
 * so `format` encoded a trailing space typed before Enter as a numeric character reference, and
 * the editor's Markdown was not a fixed point of `parse`∘`format`.
 *
 * Two suites. The first is one test per guard in `stripUnparsableWhitespace` (schema.ts),
 * enumerated from the diff rather than from the acceptance: the two ends it strips, the three
 * neighbours it must not touch, the run it drops, and the third block type it runs on. The second
 * is the corpus leg the review's risk 1 named — every other round-trip leg in this repo is seeded
 * from `parse(fixture)`, so the corpus is closed under the parser and a tree only the editor can
 * build is unreachable by construction. This one seeds from the editor's own output instead.
 *
 * Task 1.25 (DECISIONS #review-1-r1 G3 and G4) widened both. 1.13 closed the block's two ends
 * only, and its own doc comment justified stopping at an atom with "a hard break already
 * serialises to bytes that parse back" — true of the whitespace *before* a break and false of the
 * whitespace *after* it, and equally false on both sides of a soft line break, which typing now
 * preserves. The guards below are therefore one per **boundary micromark normalises**, enumerated
 * from CommonMark rather than from the three reproductions, and every one of them asserts the
 * serialised bytes (`format(root)`), not only the tree: a guard that asserts the tree while its
 * siblings assert `format` is the one that pins a defect as correct (lesson [1.10.r1d]).
 *
 * Task 1.29 (DECISIONS #review-1-r2 H1, H5 and H6) adds the boundary the eleven guards had all
 * asserted *whitespace* at and never an atom: a `hard_break` left as a block's last node — three
 * Backspace presses from `hard-break.md`'s shape — reached `format`, which wrote it as a bare
 * trailing `\` that `parse` reads as a literal backslash, and a heading ending that way reparsed
 * as a paragraph. The third suite is one guard per position of the new clause, each on `paragraph`
 * and on `heading`, plus the cell clause; the corpus gains a leg titled for **deletion**, because
 * both typing legs only ever `insertText` and a tree that needs a deletion to build was outside
 * every one of them (Claude's lesson 2).
 *
 * Task 1.30 (DECISIONS #review-1-r2 H8) adds the boundary the r1 backlog had deferred as
 * unreachable, and which one keystroke reaches: a space typed with the caret inside a mark, at
 * the end of an emphasised word, so that `emphasis[text("b ")]` — a tree no file parses to,
 * CommonMark §6.2's closing delimiter not being right-flanking after whitespace — reached the
 * serializer, which spelled the space as a numeric character reference (Sol's `a *b* c`). The fourth
 * suite is one guard
 * per edge the flanking rules name (leading, trailing, both, whitespace-only) for each of the
 * three flanking marks, the trailing edge in the first, middle and last positions of the block,
 * plus the nested case, the link absence case and the clauses read from the diff; the corpus
 * gains a leg titled for the **mark edge**, which types the space inside every marked run.
 *
 * Task 1.34 (DECISIONS #review-1-r3 I1) adds the member of the mark-edge boundary that 1.30's
 * guards asserted only for whitespace and its backlog line deferred as unreachable: a `hard_break`
 * left as a *run's* last node with unmarked text after it — one Backspace inside an emphasised
 * verse loaded from a file — reached `format`, which wrote the break's line ending as a numeric
 * character reference inside the delimiters and escaped the next character, a fixed point whose
 * parse holds no `break`. The fifth suite is one guard per position and mark (a break last in the
 * run before unmarked text, in a paragraph and in a setext heading; before another mark's run; as
 * the run's first node; two breaks at the edge), each asserting the bytes, the fixed point, that
 * the parsed output keeps as many `break`s as the input tree had, and that no text node of it
 * holds a numeric character reference — because a fixed point alone accepted the defect (the
 * escaped entity is literal text that reparses to itself). The deletion leg gains a second range
 * set, seeded from `hard-break-in-emphasis.md`, that deletes to the *marked run's* end after every
 * break inside a mark, where 1.29's ranges went to the block's end and so never built this tree;
 * and every leg's assertion of absence is one regex over the whole entity family
 * ({@link ENTITY}) rather than the one literal each finding produced.
 *
 * Task 1.35 (DECISIONS #review-1-r3 I3, I4) adds the boundary at which link-marked text is not
 * the strip's to move: the link's own edge. 1.30's clause split a link-marked run at a flanking
 * mark's edge and the split-off space kept the `link`, so `*a [b ](u)* c` came back with a
 * second, whitespace-only link (I3, a regression), and the block's two trims dropped a link's
 * edge whitespace where the link was the block's first or last node (I4, since 1.13). The sixth
 * suite is one guard per position and mark for a link with edge whitespace at a flanking run's
 * edge (alone in the run; the run first, middle and last in the block; in a cell), the bare link
 * first and last in a paragraph, a heading and a cell, and the clauses read from the diff — the
 * link that continues past the run (whose space still moves, within the link), the break at the
 * link's edge, the block-start stop's absence case after a break, and the nesting `pmToMdast`
 * now decides from the runs' extents, because `*[b ](u)*` is its own bytes only with the
 * emphasis written outside the link. Each asserts the bytes, the fixed point, and that the parsed
 * output holds exactly one `link` (the defect's held two). The corpus gains a leg titled for the
 * **link edge**, which types a space inside every link, at the end of its text.
 */

const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));

const index = JSON.parse(readFileSync(`${FIXTURES}/index.json`, "utf8")) as Record<string, unknown>;
const names = Object.keys(index).sort();

/**
 * A numeric character reference, decimal or hexadecimal — the whole family the serializer spells
 * unparsable whitespace and the character after a break as (a space, a line ending, a letter, a
 * no-break space have each appeared), matched as a pattern so that a grep for any one member
 * across the test tree turns up only assertions of absence.
 */
const ENTITY = /&#x?[0-9a-fA-F]+;/;

function read(name: string): string {
  return readFileSync(`${FIXTURES}/${name}`, "utf8");
}

function paragraph(...content: PMNode[]): PMNode {
  return schema.node("doc", null, [schema.node("paragraph", null, content)]);
}

function mdastOf(doc: PMNode): Root {
  return pmToMdast({ doc, frontMatter: null });
}

/**
 * A paragraph wrapped over four source lines, so that its three soft line breaks are a first, a
 * middle and a last one — the three positions CLAUDE.md's slice rule asks for. `WRAPPED` is what
 * every one of the six typed variants below has to serialise back to.
 */
const WRAPPED = "one\ntwo\nthree\nfour\n";

/** A space typed at the end of the first, the middle and the last wrapped line. */
const SOFT_BREAK_POSITIONS_BEFORE: readonly (readonly [string, string])[] = [
  ["first break", "one \ntwo\nthree\nfour"],
  ["middle break", "one\ntwo \nthree\nfour"],
  ["last break", "one\ntwo\nthree \nfour"],
];

/** A space typed at the start of the line after the first, the middle and the last break. */
const SOFT_BREAK_POSITIONS_AFTER: readonly (readonly [string, string])[] = [
  ["first break", "one\n two\nthree\nfour"],
  ["middle break", "one\ntwo\n three\nfour"],
  ["last break", "one\ntwo\nthree\n four"],
];

describe("the whitespace boundaries micromark normalises, one guard per boundary", () => {
  it("boundary 1 (block start): the leading whitespace of a block's first text run is dropped", () => {
    const root = mdastOf(paragraph(schema.text("  \they")));
    expect(root.children).toEqual([
      { type: "paragraph", children: [{ type: "text", value: "hey" }] },
    ]);
    expect(format(root)).toBe("hey\n");
  });

  it("boundary 2 (block end): the trailing whitespace of a block's last text run is dropped", () => {
    const root = mdastOf(paragraph(schema.text("hey \t")));
    expect(root.children).toEqual([
      { type: "paragraph", children: [{ type: "text", value: "hey" }] },
    ]);
    expect(format(root)).toBe("hey\n");
    expect(format(root)).not.toMatch(ENTITY);
  });

  it("boundary 3 (before a hard break): the whitespace a hard break does not own is kept", () => {
    // The half of 1.13's "a hard break already serialises to bytes that parse back" that is true:
    // `foo \` is how the serializer spells a break after a text run ending in a space, and
    // `parse` gives that space back. This is the absence case of boundary 4 — the same tree, the
    // same function, the other side of the same atom — so it is asserted on the bytes too.
    const root = mdastOf(
      paragraph(schema.text("one "), schema.node("hard_break"), schema.text("two")),
    );
    expect(root.children).toEqual([
      {
        type: "paragraph",
        children: [
          { type: "text", value: "one " },
          { type: "break" },
          { type: "text", value: "two" },
        ],
      },
    ]);
    expect(format(root)).toBe("one \\\ntwo\n");
    expect(format(root)).not.toMatch(ENTITY);
    expect(format(parse(format(root)))).toBe(format(root));
  });

  it("boundary 4 (after a hard break): the leading whitespace of the continuation line is dropped", () => {
    // CommonMark §6.7: "leading spaces at the beginning of the next line are ignored". Before this
    // task the same tree serialised to a character reference (DECISIONS #review-1-r1 G4, Claude
    // finding 2: hard-break.md with one space typed at the start of its second line).
    const root = mdastOf(
      paragraph(schema.text("one "), schema.node("hard_break"), schema.text(" two ")),
    );
    expect(root.children).toEqual([
      {
        type: "paragraph",
        children: [
          { type: "text", value: "one " },
          { type: "break" },
          { type: "text", value: "two" },
        ],
      },
    ]);
    expect(format(root)).toBe("one \\\ntwo\n");
    expect(format(root)).not.toMatch(ENTITY);
  });

  it("boundary 5 (before a soft line break): the space at the end of a wrapped line is dropped, first, middle and last", () => {
    // CommonMark §6.8: a soft line break removes the spaces at the end of the line and at the
    // beginning of the next. The three positions are the ownership rule's own edge cases: the
    // paragraph below wraps over four lines, so its first, middle and last breaks are distinct.
    for (const [label, typed] of SOFT_BREAK_POSITIONS_BEFORE) {
      const root = mdastOf(paragraph(schema.text(typed)));
      expect(format(root), label).toBe(WRAPPED);
      expect(format(root), label).not.toMatch(ENTITY);
      expect(format(parse(format(root))), label).toBe(WRAPPED);
    }
  });

  it("boundary 6 (after a soft line break): the space at the start of a wrapped line is dropped, first, middle and last", () => {
    for (const [label, typed] of SOFT_BREAK_POSITIONS_AFTER) {
      const root = mdastOf(paragraph(schema.text(typed)));
      expect(format(root), label).toBe(WRAPPED);
      expect(format(root), label).not.toMatch(ENTITY);
      expect(format(parse(format(root))), label).toBe(WRAPPED);
    }
  });

  it("boundary 7 (a whitespace-only line between two soft breaks): the run collapses to one break", () => {
    // The decision the ownership rule states, made by the fixed point: those bytes spell a blank
    // line, a paragraph node cannot hold one, and splitting the block would mean this function
    // inventing block structure. Collapsing keeps one paragraph in and one paragraph out.
    const root = mdastOf(paragraph(schema.text("one\n \t \ntwo")));
    expect(root.children).toEqual([
      { type: "paragraph", children: [{ type: "text", value: "one\ntwo" }] },
    ]);
    expect(format(root)).toBe("one\ntwo\n");
    expect(format(root)).not.toMatch(ENTITY);
    // The block was not split: one paragraph before, one paragraph after the round trip.
    expect(parse(format(root)).children).toHaveLength(1);
    expect(format(parse(format(root)))).toBe(format(root));
  });

  it("boundary 8 (inline code is opaque): an inline-code run at a block end keeps its literal bytes", () => {
    const code = schema.marks.inline_code.create();
    const root = mdastOf(paragraph(schema.text(" x ", [code])));
    expect(root.children).toEqual([
      { type: "paragraph", children: [{ type: "inlineCode", value: " x " }] },
    ]);
  });

  it("boundary 9 (a raw atom is opaque): a raw_inline at a block end keeps its bytes and stops the strip", () => {
    const raw = schema.node("raw_inline", { value: "<i> " });
    const inline = mdastOf(paragraph(schema.text("a "), raw));
    expect(inline.children).toEqual([
      {
        type: "paragraph",
        children: [
          { type: "text", value: "a " },
          { type: "html", value: "<i> " },
        ],
      },
    ]);
    // The block-level opaque node never reaches the strip at all.
    const block = mdastOf(schema.node("doc", null, [schema.node("raw", { value: "<div> \n" })]));
    expect(block.children).toEqual([{ type: "html", value: "<div> \n" }]);
  });

  it("boundary 10 (a run trimmed to nothing): a run trimmed to nothing is dropped, not kept as an empty node", () => {
    const strong = schema.marks.strong.create();
    const root = mdastOf(paragraph(schema.text("  ", [strong]), schema.text("x")));
    expect(root.children).toEqual([
      { type: "paragraph", children: [{ type: "text", value: "x" }] },
    ]);
    expect(format(root)).toBe("x\n");
  });

  it("boundary 11 (a table cell's own two ends): a table cell's own two ends are stripped like a paragraph's", () => {
    const cell = (text: string): PMNode => schema.node("table_cell", null, [schema.text(text)]);
    const root = mdastOf(
      schema.node("doc", null, [
        schema.node("table", { align: null }, [
          schema.node("table_row", null, [cell(" a "), cell("b")]),
          schema.node("table_row", null, [cell("c"), cell(" d ")]),
        ]),
      ]),
    );
    const cells = (row: number): unknown =>
      // @ts-expect-error -- the shape is asserted by the equality below, not by the type
      root.children[0].children[row].children.map((c) => c.children);
    expect(cells(0)).toEqual([[{ type: "text", value: "a" }], [{ type: "text", value: "b" }]]);
    expect(cells(1)).toEqual([[{ type: "text", value: "c" }], [{ type: "text", value: "d" }]]);
    expect(format(root)).not.toMatch(ENTITY);
  });

  it("a heading's ends are stripped too (the third block the strip runs on)", () => {
    const root = mdastOf(
      schema.node("doc", null, [schema.node("heading", { depth: 2 }, [schema.text(" H ")])]),
    );
    expect(format(root)).toBe("## H\n");
  });
});

function heading(...content: PMNode[]): PMNode {
  return schema.node("doc", null, [schema.node("heading", { depth: 2 }, content)]);
}

function cell(...content: PMNode[]): PMNode {
  return schema.node("doc", null, [
    schema.node("table", { align: null }, [
      schema.node("table_row", null, [schema.node("table_cell", null, content)]),
    ]),
  ]);
}

/** Every `break` node under `root`, wherever it is. */
function breaksIn(root: Root): number {
  const walk = (node: { type: string; children?: unknown[] }): number =>
    (node.type === "break" ? 1 : 0) +
    ((node.children ?? []) as (typeof node)[]).reduce((sum, child) => sum + walk(child), 0);
  return walk(root);
}

/**
 * The hard breaks of `doc` that are not among a block's trailing breaks — the ones the block's-end
 * clause keeps, and so the number of `break`s the tree leaving the editor has to hold.
 */
function breaksNotLastInBlock(doc: PMNode): number {
  let count = 0;
  doc.descendants((node) => {
    if (!node.isTextblock) return true;
    const children: PMNode[] = [];
    node.forEach((child) => children.push(child));
    while (children.length > 0 && children[children.length - 1].type === schema.nodes.hard_break)
      children.pop();
    count += children.filter((child) => child.type === schema.nodes.hard_break).length;
    return false;
  });
  return count;
}

/** Every hard break in the editor's own tree, wherever it is. */
function hardBreaksIn(doc: PMNode): number {
  let count = 0;
  doc.descendants((node) => {
    if (node.type === schema.nodes.hard_break) count += 1;
    return true;
  });
  return count;
}

/** The value of every `text` node under `root`, wherever it is. */
function textValues(root: Root): string[] {
  const out: string[] = [];
  const walk = (node: { type: string; value?: string; children?: unknown[] }): void => {
    if (node.type === "text") out.push(node.value as string);
    for (const child of (node.children ?? []) as (typeof node)[]) walk(child);
  };
  walk(root);
  return out;
}

/**
 * The two assertions every guard below makes: the bytes `format` writes, and that those bytes are
 * a fixed point of `parse`∘`format` — the second is the round trip the finding is about, and the
 * first is what stops a guard from pinning any fixed point at all as the right one.
 */
function expectBytes(root: Root, bytes: string, label?: string): void {
  expect(format(root), label).toBe(bytes);
  expect(format(parse(format(root))), label).toBe(format(root));
  expect(format(root), label).not.toMatch(ENTITY);
}

describe("the block's end and an atom (task 1.29): one guard per position, on paragraph and on heading", () => {
  it("position 1 (a break as the block's last node): the break is dropped and the block's bytes end at the text", () => {
    // Before this task: `one\\\n`, which `parse` reads as the text `one\\` — the break gone and
    // a backslash the user never typed in its place (DECISIONS #review-1-r2 H1).
    const p = mdastOf(paragraph(schema.text("one"), schema.node("hard_break")));
    expect(p.children).toEqual([{ type: "paragraph", children: [{ type: "text", value: "one" }] }]);
    expectBytes(p, "one\n", "paragraph");

    const h = mdastOf(heading(schema.text("H"), schema.node("hard_break")));
    expect(h.children).toEqual([
      { type: "heading", depth: 2, children: [{ type: "text", value: "H" }] },
    ]);
    expectBytes(h, "## H\n", "heading");
    // H5: the block type survives the trip. Before this task `## H\\\n\n` came back as a paragraph.
    expect(parse(format(h)).children[0]).toMatchObject({ type: "heading", depth: 2 });
  });

  it("position 2 (a block that is only a break): the block becomes an empty block, at its existing fixed point", () => {
    // An empty paragraph has no bytes and is dropped, exactly as one ProseMirror holds empty is;
    // an empty heading is its marker alone. Both stated in the strip's doc comment.
    const p = mdastOf(paragraph(schema.node("hard_break")));
    expect(p.children).toEqual([]);
    expectBytes(p, "", "paragraph");
    // …and between two other blocks, where a kept-but-empty paragraph would have serialised as an
    // extra blank line that `parse` reads as nothing.
    const between = mdastOf(
      schema.node("doc", null, [
        schema.node("paragraph", null, [schema.text("a")]),
        schema.node("paragraph", null, [schema.node("hard_break")]),
        schema.node("paragraph", null, [schema.text("b")]),
      ]),
    );
    expect(between.children).toHaveLength(2);
    expectBytes(between, "a\n\nb\n", "paragraph between two");

    const h = mdastOf(heading(schema.node("hard_break")));
    expect(h.children).toEqual([{ type: "heading", depth: 2, children: [] }]);
    expectBytes(h, "##\n", "heading");
    expect(parse(format(h)).children[0]).toMatchObject({ type: "heading", depth: 2 });
  });

  it("position 3 (a break followed only by whitespace): the run and the break are both dropped", () => {
    // The whitespace after the break is boundary 4's (dropped at the line start), which leaves the
    // break last: the two clauses compose, and the block ends at the text either way.
    const p = mdastOf(paragraph(schema.text("one"), schema.node("hard_break"), schema.text(" \t")));
    expect(p.children).toEqual([{ type: "paragraph", children: [{ type: "text", value: "one" }] }]);
    expectBytes(p, "one\n", "paragraph");

    const h = mdastOf(heading(schema.text("H"), schema.node("hard_break"), schema.text(" \t")));
    expect(h.children).toEqual([
      { type: "heading", depth: 2, children: [{ type: "text", value: "H" }] },
    ]);
    expectBytes(h, "## H\n", "heading");
    expect(parse(format(h)).children[0]).toMatchObject({ type: "heading", depth: 2 });
  });

  it("clause: two breaks in a row at the block's end are both dropped (the rule's \"repeatedly\")", () => {
    const p = mdastOf(
      paragraph(schema.text("one"), schema.node("hard_break"), schema.node("hard_break")),
    );
    expect(breaksIn(p)).toBe(0);
    expectBytes(p, "one\n", "paragraph");
    const h = mdastOf(
      heading(schema.text("H"), schema.node("hard_break"), schema.node("hard_break")),
    );
    expect(breaksIn(h)).toBe(0);
    expectBytes(h, "## H\n", "heading");
  });

  it("clause: once the break is dropped, the block's end takes the whitespace the break did not own", () => {
    // Boundary 3 keeps `one ` before a break that stays (`one \\` parses back to the same run);
    // with the break gone the run is the block's last node, and the block's end takes its space.
    const p = mdastOf(paragraph(schema.text("one "), schema.node("hard_break")));
    expect(p.children).toEqual([{ type: "paragraph", children: [{ type: "text", value: "one" }] }]);
    expectBytes(p, "one\n", "paragraph");
    const h = mdastOf(heading(schema.text("H "), schema.node("hard_break")));
    expectBytes(h, "## H\n", "heading");
  });

  it("clause: a break in the middle of the block is untouched (the absence case of the drop)", () => {
    const p = mdastOf(paragraph(schema.text("one"), schema.node("hard_break"), schema.text("two")));
    expect(breaksIn(p)).toBe(1);
    expectBytes(p, "one\\\ntwo\n", "paragraph");
    const h = mdastOf(heading(schema.text("H"), schema.node("hard_break"), schema.text("two")));
    expect(breaksIn(h)).toBe(1);
    expect(format(h)).toContain("\\\n");
    expect(parse(format(h)).children[0]).toMatchObject({ type: "heading", depth: 2 });
    expect(format(parse(format(h)))).toBe(format(h));
  });

  it("clause: the end-of-block loop stops at an opaque node — an image or an inline-code run before the dropped break keeps its bytes", () => {
    const image = schema.node("image", { url: "a.png", alt: "", title: null });
    const withImage = mdastOf(paragraph(image, schema.node("hard_break")));
    expect(withImage.children).toEqual([
      { type: "paragraph", children: [{ type: "image", url: "a.png", alt: "", title: null }] },
    ]);
    expectBytes(withImage, "![](a.png)\n", "image");

    const code = schema.marks.inline_code.create();
    const withCode = mdastOf(paragraph(schema.text(" x ", [code]), schema.node("hard_break")));
    expect(withCode.children).toEqual([
      { type: "paragraph", children: [{ type: "inlineCode", value: " x " }] },
    ]);
    expect(format(parse(format(withCode)))).toBe(format(withCode));
  });

  it("clause: a whitespace-only run at the block's end promotes its neighbour to the block's end", () => {
    // The sentence the rule used to state the other way ("does not promote its neighbour"): a
    // strong-marked run of spaces after `x ` used to leave `x ` last and untrimmed, and `format`
    // wrote the space as a character reference. The end is now the last node that survives.
    const strong = schema.marks.strong.create();
    const p = mdastOf(paragraph(schema.text("x "), schema.text("  ", [strong])));
    expect(p.children).toEqual([{ type: "paragraph", children: [{ type: "text", value: "x" }] }]);
    expectBytes(p, "x\n", "paragraph");
    const h = mdastOf(heading(schema.text("H "), schema.text("  ", [strong])));
    expectBytes(h, "## H\n", "heading");
  });

  it("clause (H6): a line ending inside a table cell collapses to one space and serialises without an entity", () => {
    // A GFM row ends at its line ending, so a cell cannot hold one; the serializer spells the
    // `\n` a cell's text carried as a numeric character reference for the line feed, bytes no
    // cell a Markdown file parses to ever held (the entity is asserted absent, never spelled).
    const root = mdastOf(cell(schema.text("a \n  b")));
    expect(root.children).toEqual([
      {
        type: "table",
        align: null,
        children: [
          {
            type: "tableRow",
            children: [{ type: "tableCell", children: [{ type: "text", value: "a b" }] }],
          },
        ],
      },
    ]);
    expect(format(root)).toBe("| a b |\n| --- |\n");
    expect(format(root)).not.toMatch(ENTITY);
    expect(format(parse(format(root)))).toBe(format(root));
    // Two line endings in one run are still one space: the run collapses, whatever it holds.
    expect(format(mdastOf(cell(schema.text("a\n\nb"))))).toBe("| a b |\n| --- |\n");
  });

  it("clause (H6, the cell's own two ends): a line ending at a cell's start or end is boundary 11's, dropped", () => {
    const root = mdastOf(cell(schema.text("\n a \n")));
    expect(root.children).toEqual([
      {
        type: "table",
        align: null,
        children: [
          {
            type: "tableRow",
            children: [{ type: "tableCell", children: [{ type: "text", value: "a" }] }],
          },
        ],
      },
    ]);
    expect(format(root)).toBe("| a |\n| - |\n");
    expect(format(root)).not.toMatch(ENTITY);
    expect(format(parse(format(root)))).toBe(format(root));
    // …and a break last in a cell is dropped like any block's (position 1 on the third block).
    const withBreak = mdastOf(cell(schema.text("a"), schema.node("hard_break")));
    expect(breaksIn(withBreak)).toBe(0);
    expect(format(withBreak)).toBe("| a |\n| - |\n");
    expect(format(parse(format(withBreak)))).toBe(format(withBreak));
  });

  it("clause (H6, the absence case): a line ending in a paragraph still collapses to a line break, not a space", () => {
    const root = mdastOf(paragraph(schema.text("a \n  b")));
    expect(root.children).toEqual([
      { type: "paragraph", children: [{ type: "text", value: "a\nb" }] },
    ]);
    expectBytes(root, "a\nb\n");
  });
});

/** The three flanking marks, named as the guards name them, with the delimiter each is written with. */
const FLANKING: readonly (readonly [string, PMMark, string])[] = [
  ["emphasis", schema.marks.emphasis.create(), "*"],
  ["strong", schema.marks.strong.create(), "**"],
  ["strikethrough", schema.marks.delete.create(), "~~"],
];

/** The mdast wrapper each flanking mark becomes, for the tree assertions. */
function wrapped(
  name: string,
  value: string,
): { type: string; children: { type: string; value: string }[] } {
  const type = name === "strikethrough" ? "delete" : name;
  return { type, children: [{ type: "text", value }] };
}

describe("the mark edge (task 1.30): one guard per edge of CommonMark §6.2's flanking rules, per flanking mark", () => {
  for (const [name, mark, d] of FLANKING) {
    it(`${name}, leading edge: the whitespace after the opening delimiter moves before the mark`, () => {
      // §6.2: an opening delimiter run is left-flanking only if not followed by whitespace, so
      // `${d} b${d}` never parses to a mark holding " b"; the space is the neighbour's.
      const root = mdastOf(
        paragraph(schema.text("a"), schema.text(" b", [mark]), schema.text(" c")),
      );
      expect(root.children).toEqual([
        {
          type: "paragraph",
          children: [
            { type: "text", value: "a " },
            wrapped(name, "b"),
            { type: "text", value: " c" },
          ],
        },
      ]);
      expectBytes(root, `a ${d}b${d} c\n`);
    });

    it(`${name}, trailing edge: the whitespace before the closing delimiter moves after the mark — first, middle and last in the block`, () => {
      // §6.2: a closing delimiter run is right-flanking only if not preceded by whitespace. The
      // marked run first in the block, in the middle of it, and last in it — where the moved
      // space is the block's end's, and dropped.
      const first = mdastOf(paragraph(schema.text("b ", [mark]), schema.text("c")));
      expect(first.children).toEqual([
        { type: "paragraph", children: [wrapped(name, "b"), { type: "text", value: " c" }] },
      ]);
      expectBytes(first, `${d}b${d} c\n`, "first");

      const middle = mdastOf(
        paragraph(schema.text("a "), schema.text("b ", [mark]), schema.text("c")),
      );
      expect(middle.children).toEqual([
        {
          type: "paragraph",
          children: [
            { type: "text", value: "a " },
            wrapped(name, "b"),
            { type: "text", value: " c" },
          ],
        },
      ]);
      expectBytes(middle, `a ${d}b${d} c\n`, "middle");

      const last = mdastOf(paragraph(schema.text("a "), schema.text("b ", [mark])));
      expect(last.children).toEqual([
        { type: "paragraph", children: [{ type: "text", value: "a " }, wrapped(name, "b")] },
      ]);
      expectBytes(last, `a ${d}b${d}\n`, "last");
    });

    it(`${name}, both edges: each side's whitespace goes to its own neighbour`, () => {
      const root = mdastOf(
        paragraph(schema.text("a"), schema.text(" b ", [mark]), schema.text("c")),
      );
      expect(root.children).toEqual([
        {
          type: "paragraph",
          children: [
            { type: "text", value: "a " },
            wrapped(name, "b"),
            { type: "text", value: " c" },
          ],
        },
      ]);
      expectBytes(root, `a ${d}b${d} c\n`);
    });

    it(`${name}, whitespace-only: a marked run that is only whitespace loses the mark and merges with its neighbours`, () => {
      const root = mdastOf(paragraph(schema.text("a"), schema.text(" ", [mark]), schema.text("c")));
      expect(root.children).toEqual([
        { type: "paragraph", children: [{ type: "text", value: "a c" }] },
      ]);
      expectBytes(root, "a c\n");
      // …and at the block's start it is then boundary 1's, dropped.
      const start = mdastOf(paragraph(schema.text(" ", [mark]), schema.text("c")));
      expect(start.children).toEqual([
        { type: "paragraph", children: [{ type: "text", value: "c" }] },
      ]);
      expectBytes(start, "c\n");
    });
  }

  it("nested (strong inside emphasis), whitespace at the shared edge: the space leaves every mark whose edge it touches", () => {
    const em = schema.marks.emphasis.create();
    const strong = schema.marks.strong.create();
    // Both runs end at the same node: the space is outside both.
    const shared = mdastOf(
      paragraph(schema.text("a "), schema.text("b ", [em, strong]), schema.text("c")),
    );
    expect(shared.children).toEqual([
      {
        type: "paragraph",
        children: [
          { type: "text", value: "a " },
          {
            type: "strong",
            children: [{ type: "emphasis", children: [{ type: "text", value: "b" }] }],
          },
          { type: "text", value: " c" },
        ],
      },
    ]);
    expectBytes(shared, "a ***b*** c\n", "shared edge");
    // Only the inner run ends there: the space leaves `strong` and stays inside `emphasis`.
    const inner = mdastOf(
      paragraph(
        schema.text("x ", [em]),
        schema.text("b ", [em, strong]),
        schema.text("y", [em]),
        schema.text(" c"),
      ),
    );
    expect(inner.children).toEqual([
      {
        type: "paragraph",
        children: [
          {
            type: "emphasis",
            children: [
              { type: "text", value: "x " },
              { type: "strong", children: [{ type: "text", value: "b" }] },
              { type: "text", value: " y" },
            ],
          },
          { type: "text", value: " c" },
        ],
      },
    ]);
    expectBytes(inner, "*x **b** y* c\n", "inner edge");
  });

  it("link (the absence case): a link's text keeps its edge whitespace, because `[b ](u)` is a link", () => {
    const link = schema.marks.link.create({ url: "u", title: null });
    const root = mdastOf(
      paragraph(schema.text("a "), schema.text(" b ", [link]), schema.text("c")),
    );
    expect(root.children).toEqual([
      {
        type: "paragraph",
        children: [
          { type: "text", value: "a " },
          { type: "link", url: "u", title: null, children: [{ type: "text", value: " b " }] },
          { type: "text", value: "c" },
        ],
      },
    ]);
    expectBytes(root, "a [ b ](u)c\n");
  });

  it("clause: the moved whitespace keeps every mark other than the one whose edge it left — emphasis inside a link", () => {
    const link = schema.marks.link.create({ url: "u", title: null });
    const em = schema.marks.emphasis.create();
    const root = mdastOf(paragraph(schema.text("b ", [link, em]), schema.text("c", [link])));
    expect(root.children).toEqual([
      {
        type: "paragraph",
        children: [
          {
            type: "link",
            url: "u",
            title: null,
            children: [
              { type: "emphasis", children: [{ type: "text", value: "b" }] },
              { type: "text", value: " c" },
            ],
          },
        ],
      },
    ]);
    expectBytes(root, "[*b* c](u)\n");
  });

  it("clause: the edge scan stops at an opaque node — an inline-code run or an atom at the run's edge keeps what is inside it", () => {
    const em = schema.marks.emphasis.create();
    const code = schema.marks.inline_code.create();
    // Inline code first in the run: its own spaces are its own, and the scan does not pass it to
    // reach `b`'s leading space; the trailing edge is still the run's last node.
    const withCode = mdastOf(
      paragraph(schema.text(" x ", [code, em]), schema.text("b ", [em]), schema.text("c")),
    );
    expect(withCode.children).toEqual([
      {
        type: "paragraph",
        children: [
          {
            type: "emphasis",
            children: [
              { type: "inlineCode", value: " x " },
              { type: "text", value: "b" },
            ],
          },
          { type: "text", value: " c" },
        ],
      },
    ]);
    expect(format(parse(format(withCode)))).toBe(format(withCode));
    expect(format(withCode)).not.toMatch(ENTITY);
    // An image first in the run: the space after it is inside the run, not at its edge.
    const image = schema.node("image", { url: "a.png", alt: "", title: null }, undefined, [em]);
    const withImage = mdastOf(paragraph(image, schema.text(" b", [em]), schema.text(" c")));
    expect(withImage.children).toEqual([
      {
        type: "paragraph",
        children: [
          {
            type: "emphasis",
            children: [
              { type: "image", url: "a.png", alt: "", title: null },
              { type: "text", value: " b" },
            ],
          },
          { type: "text", value: " c" },
        ],
      },
    ]);
    expectBytes(withImage, "*![](a.png) b* c\n");
  });

  it("clause: the class is ASCII whitespace — a tab moves like a space, and the moved whitespace then falls under the line rules", () => {
    const em = schema.marks.emphasis.create();
    const tab = mdastOf(paragraph(schema.text("a "), schema.text("b\t", [em]), schema.text("c")));
    expect(tab.children).toEqual([
      {
        type: "paragraph",
        children: [
          { type: "text", value: "a " },
          { type: "emphasis", children: [{ type: "text", value: "b" }] },
          { type: "text", value: "\tc" },
        ],
      },
    ]);
    expectBytes(tab, "a *b*\tc\n", "tab");
    // A space moved to sit before a soft line break is boundary 5's, dropped with the run.
    const soft = mdastOf(paragraph(schema.text("b ", [em]), schema.text("\nc")));
    expect(soft.children).toEqual([
      {
        type: "paragraph",
        children: [
          { type: "emphasis", children: [{ type: "text", value: "b" }] },
          { type: "text", value: "\nc" },
        ],
      },
    ]);
    expectBytes(soft, "*b*\nc\n", "before a soft break");
  });

  it("clause: the rule runs on a heading and on a table cell as it does on a paragraph", () => {
    const em = schema.marks.emphasis.create();
    expectBytes(
      mdastOf(heading(schema.text("a "), schema.text("b ", [em]), schema.text("c"))),
      "## a *b* c\n",
      "heading",
    );
    expectBytes(
      mdastOf(cell(schema.text("a "), schema.text("b ", [em]), schema.text("c"))),
      "| a *b* c |\n| ------- |\n",
      "cell",
    );
  });

  it("the leg's seed is Sol's shape: a space typed at the end of `b` in `a *b* c` lands inside the mark", () => {
    // The corpus leg below types with `insertText` at the end of every marked text node; this
    // pins what that produces on the reproduction itself (the tree, before the strip), so the
    // leg is known to build the shape the finding is about and not a space after the mark.
    const { doc } = mdastToPM(parse("a *b* c\n"));
    const typed = typeSpaceInsideEveryMarkedRun(doc);
    expect(typed.runs).toBe(1);
    expect(typed.doc.toJSON()).toEqual(
      paragraph(
        schema.text("a "),
        schema.text("b ", [schema.marks.emphasis.create()]),
        schema.text(" c"),
      ).toJSON(),
    );
    const out = format(pmToMdast({ doc: typed.doc, frontMatter: null }));
    expect(out).toBe("a *b*  c\n");
    expect(out).not.toMatch(ENTITY);
  });
});

/**
 * The four assertions every guard of the atom-at-the-mark-edge suite makes (task 1.34): the bytes
 * `format` writes, that they are a fixed point of `parse`∘`format`, that the parsed output holds
 * exactly as many `break`s as the editor's tree had (the defect's fixed point held none), and that
 * no text node of it is a numeric character reference (the defect's text was one).
 */
function expectBreakSurvives(doc: PMNode, bytes: string, label?: string): void {
  const out = format(mdastOf(doc));
  expect(out, label).toBe(bytes);
  expect(format(parse(out)), label).toBe(out);
  expect(breaksIn(parse(out)), label).toBe(hardBreaksIn(doc));
  expect(hardBreaksIn(doc), label).toBeGreaterThan(0);
  for (const value of textValues(parse(out))) expect(value, label).not.toMatch(ENTITY);
}

/** A depth-1 heading: the serializer writes one that holds a break in setext form. */
function setext(...content: PMNode[]): PMNode {
  return schema.node("doc", null, [schema.node("heading", { depth: 1 }, content)]);
}

describe("the atom at the mark edge (task 1.34): one guard per position of a hard break at a flanking run's edge, per flanking mark", () => {
  for (const [name, mark, d] of FLANKING) {
    const br = (): PMNode => schema.node("hard_break", null, undefined, [mark]);
    // The run of another flanking mark, for the "before another mark's run" position.
    const [otherName, other, od] = FLANKING.find(([n]) => n !== name) as (typeof FLANKING)[number];

    it(`${name}, trailing edge in a paragraph: a break last in the run before unmarked text leaves the mark, and the break survives`, () => {
      // Before this task: the break stayed inside the delimiters, the serializer spelled its line
      // ending as a character reference and escaped the `c`, and the parse of that held no break.
      const doc = paragraph(schema.text("a", [mark]), br(), schema.text(" c"));
      expect(mdastOf(doc).children).toEqual([
        {
          type: "paragraph",
          children: [wrapped(name, "a"), { type: "break" }, { type: "text", value: "c" }],
        },
      ]);
      expectBreakSurvives(doc, `${d}a${d}\\\nc\n`);
    });

    it(`${name}, trailing edge in a setext heading: the same tree in a heading keeps its block type and its break`, () => {
      // Before this task this member was not even a fixed point.
      const doc = setext(schema.text("a", [mark]), br(), schema.text(" c"));
      expect(mdastOf(doc).children).toEqual([
        {
          type: "heading",
          depth: 1,
          children: [wrapped(name, "a"), { type: "break" }, { type: "text", value: "c" }],
        },
      ]);
      expectBreakSurvives(doc, `${d}a${d}\\\nc\n=\n`);
    });

    it(`${name}, trailing edge before another mark's run (${otherName}): the break leaves the first mark and does not join the second`, () => {
      const doc = paragraph(schema.text("a", [mark]), br(), schema.text("b", [other]));
      expect(mdastOf(doc).children).toEqual([
        {
          type: "paragraph",
          children: [wrapped(name, "a"), { type: "break" }, wrapped(otherName, "b")],
        },
      ]);
      expectBreakSurvives(doc, `${d}a${d}\\\n${od}b${od}\n`);
    });

    it(`${name}, leading edge: a break as the run's first node leaves the mark, and the text after it keeps it`, () => {
      // The symmetric case: an opening delimiter before a break would close a line, not open a run.
      const doc = paragraph(schema.text("x "), br(), schema.text("b", [mark]));
      expect(mdastOf(doc).children).toEqual([
        {
          type: "paragraph",
          children: [{ type: "text", value: "x " }, { type: "break" }, wrapped(name, "b")],
        },
      ]);
      expectBreakSurvives(doc, `x \\\n${d}b${d}\n`);
    });

    it(`${name}, two breaks at the edge: both leave the mark, trailing and leading (the scan's "continues")`, () => {
      const trailing = paragraph(schema.text("a", [mark]), br(), br(), schema.text(" c"));
      expect(mdastOf(trailing).children).toEqual([
        {
          type: "paragraph",
          children: [
            wrapped(name, "a"),
            { type: "break" },
            { type: "break" },
            { type: "text", value: "c" },
          ],
        },
      ]);
      expectBreakSurvives(trailing, `${d}a${d}\\\n\\\nc\n`, "trailing");

      const leading = paragraph(schema.text("x "), br(), br(), schema.text("b", [mark]));
      expect(mdastOf(leading).children).toEqual([
        {
          type: "paragraph",
          children: [
            { type: "text", value: "x " },
            { type: "break" },
            { type: "break" },
            wrapped(name, "b"),
          ],
        },
      ]);
      expectBreakSurvives(leading, `x \\\n\\\n${d}b${d}\n`, "leading");
    });

    it(`${name}, clause: a break in the middle of the run is untouched (the absence case), and one left last in the block falls to the block's-end clause`, () => {
      // Inside the run a break is legal — `${d}a\` newline `b${d}` parses to a break inside the
      // mark — so the scan, which only visits the edges, never reaches it.
      const middle = paragraph(schema.text("a", [mark]), br(), schema.text("b", [mark]));
      expect(mdastOf(middle).children).toEqual([
        {
          type: "paragraph",
          children: [
            {
              type: name === "strikethrough" ? "delete" : name,
              children: [
                { type: "text", value: "a" },
                { type: "break" },
                { type: "text", value: "b" },
              ],
            },
          ],
        },
      ]);
      expectBreakSurvives(middle, `${d}a\\\nb${d}\n`, "middle");
      // With nothing after the run, the break the edge scan unmarked is the block's last node:
      // 1.29's clause drops it, as it drops any trailing break.
      const last = mdastOf(paragraph(schema.text("a", [mark]), br()));
      expect(last.children).toEqual([{ type: "paragraph", children: [wrapped(name, "a")] }]);
      expectBytes(last, `${d}a${d}\n`, "last");
    });
  }

  it("nested (emphasis inside strong), a break at the shared edge: the break leaves every mark whose edge it touches", () => {
    const em = schema.marks.emphasis.create();
    const strong = schema.marks.strong.create();
    const doc = paragraph(
      schema.text("a", [em, strong]),
      schema.node("hard_break", null, undefined, [em, strong]),
      schema.text(" c"),
    );
    expect(mdastOf(doc).children).toEqual([
      {
        type: "paragraph",
        children: [
          {
            type: "strong",
            children: [{ type: "emphasis", children: [{ type: "text", value: "a" }] }],
          },
          { type: "break" },
          { type: "text", value: "c" },
        ],
      },
    ]);
    expectBreakSurvives(doc, "***a***\\\nc\n");
  });

  it("the leg's seed is Claude's shape: one Backspace after the break of `hard-break-in-emphasis.md`'s first verse leaves the break last in its run", () => {
    // The corpus leg below deletes to every marked run's end after every break inside a mark; this
    // pins what that produces on the reproduction's own shape (the tree, before the strip), so the
    // leg is known to build the break-last-in-run tree and not the break-last-in-block one.
    const { doc } = mdastToPM(parse("*a\\\nb* c\n"));
    const deleted = deleteToEveryMarkedRunEnd(doc);
    expect(deleted.afterBreaksInRuns).toBe(1);
    expect(deleted.toBlockEnd).toBe(0);
    const em = schema.marks.emphasis.create();
    expect(deleted.doc.toJSON()).toEqual(
      paragraph(
        schema.text("a", [em]),
        schema.node("hard_break", null, undefined, [em]),
        schema.text(" c"),
      ).toJSON(),
    );
    expectBreakSurvives(deleted.doc, "*a*\\\nc\n");
  });
});

/** Every `link` node under `root`, wherever it is. */
function linksIn(root: Root): number {
  const walk = (node: { type: string; children?: unknown[] }): number =>
    (node.type === "link" ? 1 : 0) +
    ((node.children ?? []) as (typeof node)[]).reduce((sum, child) => sum + walk(child), 0);
  return walk(root);
}

/**
 * The assertions every guard of the link-edge suite makes (task 1.35): {@link expectBytes}'s
 * three, and that the parsed output holds exactly one `link` — the defect's output held two, the
 * second whitespace-only, and a fixed point alone accepted it.
 */
function expectOneLink(root: Root, bytes: string, label?: string): void {
  expectBytes(root, bytes, label);
  expect(linksIn(parse(format(root))), label).toBe(1);
}

describe("the link edge (task 1.35): one guard per position of a link's edge whitespace at a flanking run's edge or a block's, per flanking mark", () => {
  const link = schema.marks.link.create({ url: "u", title: null });
  for (const [name, mark, d] of FLANKING) {
    it(`${name}, the link alone in the run, its trailing space at the run's trailing edge: \`${d}[b ](u)${d}\` is its own bytes, one link`, () => {
      // The delimiter's neighbour is the link's `)`, which is right-flanking whatever the link's
      // text ends in; before this task the space left the mark and kept the link, and the
      // serializer wrote a second link around it.
      const root = mdastOf(paragraph(schema.text("b ", [link, mark])));
      expect(root.children).toEqual([
        {
          type: "paragraph",
          children: [
            {
              type: name === "strikethrough" ? "delete" : name,
              children: [
                { type: "link", url: "u", title: null, children: [{ type: "text", value: "b " }] },
              ],
            },
          ],
        },
      ]);
      expectOneLink(root, `${d}[b ](u)${d}\n`);
    });

    it(`${name}, the link alone in the run, its leading space at the run's leading edge: \`${d}[ b](u)${d}\` is its own bytes, one link`, () => {
      const root = mdastOf(paragraph(schema.text(" b", [link, mark])));
      expectOneLink(root, `${d}[ b](u)${d}\n`);
    });

    it(`${name}, a link with a trailing space last in the run, the run first, middle and last in the block: \`${d}a [b ](u)${d} c\``, () => {
      const first = mdastOf(
        paragraph(schema.text("a ", [mark]), schema.text("b ", [link, mark]), schema.text(" c")),
      );
      expectOneLink(first, `${d}a [b ](u)${d} c\n`, "first");

      const middle = mdastOf(
        paragraph(
          schema.text("x "),
          schema.text("a ", [mark]),
          schema.text("b ", [link, mark]),
          schema.text(" c"),
        ),
      );
      expectOneLink(middle, `x ${d}a [b ](u)${d} c\n`, "middle");

      const last = mdastOf(
        paragraph(schema.text("x "), schema.text("a ", [mark]), schema.text("b ", [link, mark])),
      );
      expectOneLink(last, `x ${d}a [b ](u)${d}\n`, "last");
    });

    it(`${name}, in a table cell: \`| ${d}[b ](u)${d} |\` keeps the link's space at the cell's end too`, () => {
      const root = mdastOf(cell(schema.text("b ", [link, mark])));
      expectOneLink(root, `| ${d}[b ](u)${d} |\n| ${"-".repeat(d.length * 2 + 7)} |\n`);
    });
  }

  it("a bare link with a trailing space last in a paragraph, a heading and a cell keeps it: the block's end is the link's `)`", () => {
    expectOneLink(
      mdastOf(paragraph(schema.text("see "), schema.text("b ", [link]))),
      "see [b ](u)\n",
      "paragraph",
    );
    expectOneLink(
      mdastOf(heading(schema.text("see "), schema.text("b ", [link]))),
      "## see [b ](u)\n",
      "heading",
    );
    expectOneLink(
      mdastOf(cell(schema.text("see "), schema.text("b ", [link]))),
      "| see [b ](u) |\n| ----------- |\n",
      "cell",
    );
  });

  it("a bare link with a leading space first in a paragraph, a heading and a cell keeps it: the block's first byte is the link's `[`", () => {
    expectOneLink(
      mdastOf(paragraph(schema.text(" b", [link]), schema.text(" c"))),
      "[ b](u) c\n",
      "paragraph",
    );
    expectOneLink(
      mdastOf(heading(schema.text(" b", [link]), schema.text(" c"))),
      "## [ b](u) c\n",
      "heading",
    );
    expectOneLink(
      mdastOf(cell(schema.text(" b", [link]), schema.text(" c"))),
      "| [ b](u) c |\n| --------- |\n",
      "cell",
    );
  });

  it("clause: a link that continues past the run on the far side is the outer mark, and the flanking mark's edge space still moves — within the link", () => {
    // `[*b* c](u)` (the near side, 1.30's guard above) is unchanged; these are the other side:
    // the link starts before the run and ends with it, so the run's closing delimiter is inside
    // the link and its neighbour has to be `b`, not the space.
    const em = schema.marks.emphasis.create();
    const trailing = mdastOf(paragraph(schema.text("a ", [link]), schema.text("b ", [link, em])));
    expect(trailing.children).toEqual([
      {
        type: "paragraph",
        children: [
          {
            type: "link",
            url: "u",
            title: null,
            children: [
              { type: "text", value: "a " },
              { type: "emphasis", children: [{ type: "text", value: "b" }] },
              { type: "text", value: " " },
            ],
          },
        ],
      },
    ]);
    expectOneLink(trailing, "[a *b* ](u)\n", "trailing");

    const leading = mdastOf(paragraph(schema.text(" b", [link, em]), schema.text(" a", [link])));
    expectOneLink(leading, "[ *b* a](u)\n", "leading");
  });

  it("clause: the block's end pops an unlinked whitespace-only run and then stops at the link", () => {
    expectOneLink(mdastOf(paragraph(schema.text("b ", [link]), schema.text(" "))), "[b ](u)\n");
  });

  it("clause: the block-start stop is the block's start only — after a hard break inside a link the continuation line's leading whitespace is still dropped (the absence case)", () => {
    // CommonMark strips a continuation line's leading whitespace at the block level, before
    // inline parsing sees the link, so `[a\` newline `  b](u)` is `[a\` newline `b](u)` and a
    // link that kept the spaces would not be a fixed point.
    const root = mdastOf(
      paragraph(
        schema.text("a", [link]),
        schema.node("hard_break", null, undefined, [link]),
        schema.text("  b", [link]),
      ),
    );
    expectOneLink(root, "[a\\\nb](u)\n");
    expect(breaksIn(parse(format(root)))).toBe(1);
  });

  it("clause: a hard break at the link's edge inside the run stays with the link (the predicate runs before the atom clause)", () => {
    // 1.34's clause moves a break at a flanking run's edge out of the mark; a break that is the
    // link's first node stays, because `*[\` newline `b](u)*` is a link inside emphasis and its
    // own bytes, whereas the break moved out would nest the link inside the emphasis's line.
    const em = schema.marks.emphasis.create();
    const root = mdastOf(
      paragraph(
        schema.node("hard_break", null, undefined, [link, em]),
        schema.text("b", [link, em]),
      ),
    );
    expectOneLink(root, "*[\\\nb](u)*\n");
    expect(breaksIn(parse(format(root)))).toBe(1);
  });

  it("clause: a whitespace-only link at the run's edge keeps its mark and its space: `*[ ](u)b*`", () => {
    // 1.30's whitespace-only case strips the mark from a run that is only whitespace; a link
    // that is only whitespace is still a link, and the trim used to drop it whole.
    const em = schema.marks.emphasis.create();
    const root = mdastOf(paragraph(schema.text(" ", [link, em]), schema.text("b", [em])));
    expectOneLink(root, "*[ ](u)b*\n");
  });

  it("clause (nesting): the mark whose run reaches furthest is outermost, and a coinciding span without edge whitespace keeps the rank order (the absence case)", () => {
    const em = schema.marks.emphasis.create();
    // Emphasis around the link: the emphasis run goes on past the link's.
    expectOneLink(
      mdastOf(paragraph(schema.text("b", [link, em]), schema.text(" c", [em]))),
      "*[b](u) c*\n",
      "emphasis outer",
    );
    // The link around emphasis: the link's run goes on past the emphasis's.
    expectOneLink(
      mdastOf(paragraph(schema.text("b", [link, em]), schema.text(" c", [link]))),
      "[*b* c](u)\n",
      "link outer",
    );
    // The same span, no edge whitespace: the rank order's normalisation (`marks`'s doc comment).
    expectOneLink(mdastOf(paragraph(schema.text("b", [link, em]))), "[*b*](u)\n", "tie");
  });

  it("clause (nesting): inline code is never the outer mark while another mark is on the node", () => {
    const code = schema.marks.inline_code.create();
    const root = mdastOf(paragraph(schema.text("a", [link, code]), schema.text("b", [code])));
    expectOneLink(root, "[`a`](u)`b`\n");
  });

  it("the leg's seed is Claude's shape: a space typed at the end of `b` in `*a [b](u)* c` with the link's marks lands inside the link", () => {
    // The corpus leg below types with the link's own marks stored; this pins what that produces
    // on the reproduction itself (the tree, before the strip), so the leg is known to build the
    // link-edge tree and not a space after the link.
    const { doc } = mdastToPM(parse("*a [b](u)* c\n"));
    const typed = typeSpaceAtEveryLinkEnd(doc);
    expect(typed.links).toBe(1);
    const em = schema.marks.emphasis.create();
    expect(typed.doc.toJSON()).toEqual(
      paragraph(schema.text("a ", [em]), schema.text("b ", [link, em]), schema.text(" c")).toJSON(),
    );
    expectOneLink(pmToMdast({ doc: typed.doc, frontMatter: null }), "*a [b ](u)* c\n");
  });
});

describe("editor fixed point over the corpus", () => {
  it("asserts one editor fixed point per fixture listed in the index", () => {
    // The count is the index's own length, never a literal (see schema-roundtrip.test.ts).
    expect(names.length).toBeGreaterThan(0);
  });

  for (const name of names) {
    it(`${name} is an editor fixed point after a space is typed at every block end`, () => {
      const canonical = format(parse(read(name)));
      const { doc, frontMatter } = mdastToPM(parse(read(name)));
      const typed = typeSpaceAtEveryBlockEnd(doc);

      // Presence: the transaction really changed this document, wherever it has a block to change.
      expect(typed.doc.eq(doc)).toBe(typed.blocks === 0);

      const out = format(pmToMdast({ doc: typed.doc, frontMatter }));
      expect(out).toBe(canonical);
      expect(format(parse(out))).toBe(out);
      expect(out).not.toMatch(ENTITY);
    });

    it(`${name} is an editor fixed point after a letter is typed inside every block`, () => {
      const canonical = format(parse(read(name)));
      const letter = letterFor(canonical);
      const { doc, frontMatter } = mdastToPM(parse(read(name)));
      const typed = typeInsideEveryBlock(doc, letter);

      // Presence: the transaction really changed this document, wherever it has a run to change.
      expect(typed.doc.eq(doc)).toBe(typed.typed === 0);

      const out = format(pmToMdast({ doc: typed.doc, frontMatter }));
      // Exactly the inserted letters: the letter is absent from `canonical` by construction, so
      // every occurrence of it in `out` is one of them, and deleting them all has to give the
      // canonical bytes back. A soft break rewritten to a space, or whitespace eaten at a
      // boundary that does not own it, shows up here as a mismatch.
      expect(out.split(letter).join("")).toBe(canonical);
      expect(out.length - canonical.length).toBe(typed.typed);
      expect(format(parse(out))).toBe(out);
      expect(out).not.toMatch(ENTITY);
    });

    it(`${name} is an editor fixed point unchanged (the absence case)`, () => {
      const canonical = format(parse(read(name)));
      const out = format(pmToMdast(mdastToPM(parse(read(name)))));
      expect(out).toBe(canonical);
      expect(format(parse(out))).toBe(out);
      expect(out).not.toMatch(ENTITY);
    });

    it(`${name} is an editor fixed point after deletion: the continuation after every hard break, then the last character of every block's last run`, () => {
      const { doc, frontMatter } = mdastToPM(parse(read(name)));
      const deleted = deleteAtEveryBlockEnd(doc);

      // Presence: the transaction really changed this document, wherever it had something to
      // delete. Both counts are per range deleted, and the test after the loop says which
      // fixtures each deletion reached.
      expect(deleted.doc.eq(doc)).toBe(deleted.afterBreaks + deleted.lastChars === 0);

      const root = pmToMdast({ doc: deleted.doc, frontMatter });
      // Every break the first deletion left last in its block is gone from the tree.
      expect(breaksIn(root)).toBe(0);
      const out = format(root);
      // Before this task, a block the deletion left ending in a break serialised to a bare
      // trailing backslash that `parse` read as a literal one, and this was not a fixed point.
      expect(format(parse(out))).toBe(out);
      expect(out).not.toMatch(ENTITY);
    });

    it(`${name} is an editor fixed point after deletion to the end of every marked run that holds a hard break (the atom at the mark edge)`, () => {
      const { doc, frontMatter } = mdastToPM(parse(read(name)));
      const deleted = deleteToEveryMarkedRunEnd(doc);

      // Presence: the transaction really changed this document, wherever it had a break inside a
      // marked run; the test after the loop says which fixtures the ranges reached.
      expect(deleted.doc.eq(doc)).toBe(deleted.afterBreaksInRuns === 0);

      const root = pmToMdast({ doc: deleted.doc, frontMatter });
      // Every break the deletion left last in its *run* survives the trip; only the ones it left
      // last in their *block* are the block's-end clause's, and dropped (1.29), so the count is
      // the tree's own, never a literal.
      expect(breaksIn(root)).toBe(breaksNotLastInBlock(deleted.doc));
      const out = format(root);
      // Before this task, a break left last in an emphasis, strong or strikethrough run with text
      // after it serialised to a character reference inside the delimiters — for two of the three
      // marks a fixed point whose parse held no break at all.
      expect(format(parse(out))).toBe(out);
      expect(breaksIn(parse(out))).toBe(breaksIn(root));
      expect(out).not.toMatch(ENTITY);
    });

    it(`${name} is an editor fixed point after a space is typed inside every marked run, at its end (the mark edge)`, () => {
      const canonical = format(parse(read(name)));
      const { doc, frontMatter } = mdastToPM(parse(read(name)));
      const typed = typeSpaceInsideEveryMarkedRun(doc);

      // Presence: the transaction really changed this document, wherever it has a marked run.
      expect(typed.doc.eq(doc)).toBe(typed.runs === 0);

      const out = format(pmToMdast({ doc: typed.doc, frontMatter }));
      // Before this task, every space typed inside a mark was written as a character reference
      // (and, for strikethrough, the tildes stopped being a delimiter at all).
      expect(format(parse(out))).toBe(out);
      expect(out).not.toMatch(ENTITY);
      // Only spaces differ: the moved space is now after (or before) the mark, or dropped at a
      // boundary that does not keep one, and nothing else about the bytes — the delimiters, the
      // escapes, the mark's own text — has moved.
      expect(out.split(" ").join("")).toBe(canonical.split(" ").join(""));
      expect(out.length).toBeGreaterThanOrEqual(canonical.length);
      expect(out.length - canonical.length).toBeLessThanOrEqual(typed.runs);
    });

    it(`${name} is an editor fixed point after a space is typed at the end of every link's text, inside the link (the link edge)`, () => {
      const { doc, frontMatter } = mdastToPM(parse(read(name)));
      const typed = typeSpaceAtEveryLinkEnd(doc);

      // Presence: the transaction really changed this document, wherever it has a link.
      expect(typed.doc.eq(doc)).toBe(typed.links === 0);

      const out = format(pmToMdast({ doc: typed.doc, frontMatter }));
      // Before this task, a link whose edge was a flanking run's edge came back split in two
      // (the space's own link invented after the mark), and one whose edge was the block's lost
      // the space. The fixed point alone accepts both, so the link count and the entity family
      // are asserted beside it.
      expect(format(parse(out))).toBe(out);
      expect(linksIn(parse(out))).toBe(linksIn(parse(read(name))));
      expect(out).not.toMatch(ENTITY);
      for (const value of textValues(parse(out))) expect(value).not.toMatch(ENTITY);
    });
  }

  it("at least one fixture in the index holds a link the link-edge leg types into", () => {
    // Without this, the link-edge leg could be green because no fixture in the corpus carries a
    // link for it to type inside — the reason `link-in-emphasis.md` carries the claim.
    const reached = names.filter(
      (name) => typeSpaceAtEveryLinkEnd(mdastToPM(parse(read(name))).doc).links > 0,
    );
    expect(reached.length).toBeGreaterThan(0);
    expect(reached).toContain("link-in-emphasis.md");
  });

  it("at least one fixture in the index holds a marked run the mark-edge leg types into", () => {
    // Without this, the mark-edge leg could be green because no fixture in the corpus carries
    // emphasis, strong or strikethrough for it to type inside.
    const reached = names.filter(
      (name) => typeSpaceInsideEveryMarkedRun(mdastToPM(parse(read(name))).doc).runs > 0,
    );
    expect(reached.length).toBeGreaterThan(0);
  });

  it("at least one fixture in the index holds a hard break the deletion leg leaves last in its block", () => {
    // Without this, the deletion leg could be green because no fixture in the corpus has a hard
    // break for it to delete after — the reason `hard-break.md` carries the claim.
    const reached = names.filter(
      (name) => deleteAtEveryBlockEnd(mdastToPM(parse(read(name))).doc).afterBreaks > 0,
    );
    expect(reached.length).toBeGreaterThan(0);
    expect(reached).toContain("hard-break.md");
  });

  it("at least one fixture in the index holds a hard break inside a marked run the second deletion set deletes after, both with text left after the run and with the run reaching the block's end", () => {
    // Without this, the marked-run leg could be green because no fixture in the corpus has a
    // break inside emphasis, strong or strikethrough — the reason `hard-break-in-emphasis.md`
    // carries the claim, on all three marks. Both shapes the ranges can leave are reached: the
    // break last in its run with text after it (the finding), and the break last in its block
    // (the block's-end clause's, the absence case of the new clause).
    const legs = names.map(
      (name) => [name, deleteToEveryMarkedRunEnd(mdastToPM(parse(read(name))).doc)] as const,
    );
    const reached = legs.filter(([, leg]) => leg.afterBreaksInRuns > 0).map(([name]) => name);
    expect(reached.length).toBeGreaterThan(0);
    expect(reached).toContain("hard-break-in-emphasis.md");
    const withText = legs
      .filter(([, leg]) => leg.afterBreaksInRuns - leg.toBlockEnd > 0)
      .map(([name]) => name);
    expect(withText).toContain("hard-break-in-emphasis.md");
    const toBlockEnd = legs.filter(([, leg]) => leg.toBlockEnd > 0).map(([name]) => name);
    expect(toBlockEnd).toContain("hard-break-in-emphasis.md");
  });

  it("at least one fixture in the index has a block whose last run the deletion leg deletes from", () => {
    const reached = names.filter(
      (name) => deleteAtEveryBlockEnd(mdastToPM(parse(read(name))).doc).lastChars > 0,
    );
    expect(reached.length).toBeGreaterThan(0);
  });

  it("at least one fixture in the index holds a soft line break the inside-a-block leg types into", () => {
    // Without this, the leg above could be green because no fixture in the corpus wraps a
    // paragraph — the reason `soft-line-breaks.md` was added by this task (1.15's pattern).
    const wrapped = names.filter((name) => {
      const root = parse(read(name)) as unknown as { type: string; children?: unknown[] };
      const walk = (node: { type: string; value?: string; children?: unknown[] }): boolean =>
        (node.type === "text" && (node.value as string).includes("\n")) ||
        ((node.children ?? []) as (typeof node)[]).some(walk);
      return walk(root as never);
    });
    expect(wrapped.length).toBeGreaterThan(0);
    expect(wrapped).toContain("soft-line-breaks.md");
  });

  it("at least one fixture in the index has a block the typing transaction can reach", () => {
    const reached = names.filter(
      (name) => typeSpaceAtEveryBlockEnd(mdastToPM(parse(read(name))).doc).blocks > 0,
    );
    expect(reached.length).toBeGreaterThan(0);
  });

  it("the leg can fail: the same tree without the strip serialises to a character reference", () => {
    // The tree `pmToMdast` used to hand the serializer for a paragraph typed as `hello `. The
    // entity is matched as a pattern rather than spelled, so that a grep for it across the test
    // tree turns up only assertions of its absence.
    const untrimmed: Root = {
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "text", value: "hello " }] }],
    };
    const serialised = format(untrimmed);
    expect(serialised).not.toBe("hello\n");
    expect(serialised).toMatch(/^hello&#x[0-9a-f]+;\n$/i);
    // …and that is what the corpus leg above compares against `format(parse(x))`, so removing the
    // strip turns every fixture with a paragraph or heading red.
    expect(format(parse("hello\n"))).toBe("hello\n");
  });
});
