import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Root } from "mdast";
import type { Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { format } from "../../core/src/format.js";
import { parse } from "../../core/src/parse.js";
import { mdastToPM, pmToMdast, schema } from "../src/schema.js";
import {
  deleteAtEveryBlockEnd,
  letterFor,
  typeInsideEveryBlock,
  typeSpaceAtEveryBlockEnd,
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
 */

const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));

const index = JSON.parse(readFileSync(`${FIXTURES}/index.json`, "utf8")) as Record<string, unknown>;
const names = Object.keys(index).sort();

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
    expect(format(root)).not.toContain("&#x20;");
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
    expect(format(root)).not.toContain("&#x20;");
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
    expect(format(root)).not.toContain("&#x20;");
  });

  it("boundary 5 (before a soft line break): the space at the end of a wrapped line is dropped, first, middle and last", () => {
    // CommonMark §6.8: a soft line break removes the spaces at the end of the line and at the
    // beginning of the next. The three positions are the ownership rule's own edge cases: the
    // paragraph below wraps over four lines, so its first, middle and last breaks are distinct.
    for (const [label, typed] of SOFT_BREAK_POSITIONS_BEFORE) {
      const root = mdastOf(paragraph(schema.text(typed)));
      expect(format(root), label).toBe(WRAPPED);
      expect(format(root), label).not.toContain("&#x20;");
      expect(format(parse(format(root))), label).toBe(WRAPPED);
    }
  });

  it("boundary 6 (after a soft line break): the space at the start of a wrapped line is dropped, first, middle and last", () => {
    for (const [label, typed] of SOFT_BREAK_POSITIONS_AFTER) {
      const root = mdastOf(paragraph(schema.text(typed)));
      expect(format(root), label).toBe(WRAPPED);
      expect(format(root), label).not.toContain("&#x20;");
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
    expect(format(root)).not.toContain("&#x20;");
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
    expect(format(root)).not.toContain("&#x20;");
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
 * The two assertions every guard below makes: the bytes `format` writes, and that those bytes are
 * a fixed point of `parse`∘`format` — the second is the round trip the finding is about, and the
 * first is what stops a guard from pinning any fixed point at all as the right one.
 */
function expectBytes(root: Root, bytes: string, label?: string): void {
  expect(format(root), label).toBe(bytes);
  expect(format(parse(format(root))), label).toBe(format(root));
  expect(format(root), label).not.toContain("&#x20;");
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
    expect(format(root)).not.toContain("&#xA;");
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
    expect(format(root)).not.toContain("&#xA;");
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

describe("editor fixed point over the corpus", () => {
  it("asserts one editor fixed point per fixture listed in the index", () => {
    // The count is the index's own length, never a literal (see schema-roundtrip.test.ts).
    expect(names.length).toBe(Object.keys(index).length);
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
      expect(out).not.toContain("&#x20;");
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
      expect(out).not.toContain("&#x20;");
    });

    it(`${name} is an editor fixed point unchanged (the absence case)`, () => {
      const canonical = format(parse(read(name)));
      const out = format(pmToMdast(mdastToPM(parse(read(name)))));
      expect(out).toBe(canonical);
      expect(format(parse(out))).toBe(out);
      expect(out).not.toContain("&#x20;");
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
      expect(out).not.toContain("&#x20;");
      expect(out).not.toContain("&#xA;");
    });
  }

  it("at least one fixture in the index holds a hard break the deletion leg leaves last in its block", () => {
    // Without this, the deletion leg could be green because no fixture in the corpus has a hard
    // break for it to delete after — the reason `hard-break.md` carries the claim.
    const reached = names.filter(
      (name) => deleteAtEveryBlockEnd(mdastToPM(parse(read(name))).doc).afterBreaks > 0,
    );
    expect(reached.length).toBeGreaterThan(0);
    expect(reached).toContain("hard-break.md");
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
