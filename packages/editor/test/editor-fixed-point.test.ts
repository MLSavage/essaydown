import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Root } from "mdast";
import type { Node as PMNode } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import { format } from "../../core/src/format.js";
import { parse } from "../../core/src/parse.js";
import { mdastToPM, pmToMdast, schema } from "../src/schema.js";

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

/**
 * A ProseMirror transaction shaped like typing: a space appended at the end of every paragraph and
 * every heading, applied back-to-front so that each insertion leaves the positions still to come
 * unmoved. `insertText` is the same call `typing.ts` makes for a typed character.
 */
function typeSpaceAtEveryBlockEnd(doc: PMNode): { doc: PMNode; blocks: number } {
  const ends: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type === schema.nodes.paragraph || node.type === schema.nodes.heading) {
      ends.push(pos + 1 + node.content.size);
    }
    return true;
  });
  let tr = EditorState.create({ doc }).tr;
  for (const pos of [...ends].reverse()) tr = tr.insertText(" ", pos);
  return { doc: tr.doc, blocks: ends.length };
}

/**
 * The letters the inside-a-block leg types. One is picked per fixture: the first that does not
 * occur in that fixture's canonical Markdown, so that "differs by exactly the inserted letters"
 * can be asserted by deleting every occurrence of it from the output and comparing. The list ends
 * in two non-ASCII letters for the fixtures (the essay) that use the whole Latin alphabet.
 */
const TYPED_LETTERS = ["Q", "Z", "X", "J", "K", "V", "W", "Y", "Ж", "Ω"];

function letterFor(canonical: string): string {
  const letter = TYPED_LETTERS.find((candidate) => !canonical.includes(candidate));
  expect(letter, "no candidate letter is absent from this fixture's canonical form").toBeDefined();
  return letter as string;
}

/** The three node types whose content is inline text; the only places a soft break can live. */
const INLINE_CONTENT = new Set([
  schema.nodes.paragraph,
  schema.nodes.heading,
  schema.nodes.table_cell,
]);

/**
 * A ProseMirror transaction shaped like typing *inside* a block, which is the shape task 1.25
 * repairs: one letter after the first character of every paragraph's first text run, and one at
 * the start of the second line of every text run that holds a soft line break. `insertText` is the
 * same call `typing.ts` makes for a typed character, and the insertions are applied back-to-front
 * so each one leaves the positions still to come unmoved.
 */
function typeInsideEveryBlock(doc: PMNode, letter: string): { doc: PMNode; typed: number } {
  const at: number[] = [];
  doc.descendants((node, pos, parent) => {
    if (node.type === schema.nodes.code_block || node.type === schema.nodes.raw) return false;
    if (node.type === schema.nodes.paragraph) {
      let first: number | null = null;
      node.descendants((child, childPos) => {
        if (first !== null) return false;
        if (child.isText) first = pos + 1 + childPos;
        return true;
      });
      // After the first character of the run, never before it: the position before it is the
      // block start, which the other leg already types at.
      if (first !== null) at.push((first as number) + 1);
    }
    if (node.isText && parent !== null && INLINE_CONTENT.has(parent.type)) {
      const text = node.text as string;
      for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1))
        at.push(pos + i + 1);
    }
    return true;
  });
  let tr = EditorState.create({ doc }).tr;
  for (const pos of [...at].sort((a, b) => b - a)) tr = tr.insertText(letter, pos);
  return { doc: tr.doc, typed: at.length };
}

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
  }

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
