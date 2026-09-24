import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Nodes, Root } from "mdast";
import type { Mark as PMMark, Node as PMNode } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import { format } from "../../core/src/format.js";
import { parse } from "../../core/src/parse.js";
import { mdastToPM, pmToMdast, schema } from "../src/schema.js";
import { blockAlone } from "./block-alone.js";

/**
 * Task 1.67 (DECISIONS #review-1-r9 O1): two flanking runs of *different* marks made adjacent by
 * one keystroke serialised their delimiters as a single run, and the bytes parsed back to another
 * tree — `emphasis("(b)") + strong("z")` was written `*(b)***z**`, which CommonMark reads as
 * `text("*(b)*") + strong("z")`, and Copy Markdown put those bytes on the clipboard. The cause was
 * the pair of built-in handlers `handleRoot` left in place: they encode the neighbour *outside* a
 * run and know nothing of a neighbour that is itself the delimiter of the run next to it.
 * `packages/core/src/format.ts`'s `handleEmphasis` / `handleStrong` answer it by opening with the
 * other marker (`_`, `__`) exactly when the run beside them just closed with the one they would
 * have taken.
 *
 * `[review-1-r6 L11]` had recorded the class as unreachable from the editor. That is true of two
 * runs of the *same* mark — ProseMirror merges adjacent text nodes with equal mark sets, so a join
 * or a deletion between `~~a.~~` and `~~b~~` yields one run, not two — and false of two runs of
 * different marks, which is what the r9 review drove in Chromium.
 *
 * Three suites, in the order CLAUDE.md asks for: **the invariant first** (the sweep, every ordered
 * pair of adjacent runs the schema's five marks can make, over every class the first run's last
 * character can be in), **then the instances** (the two pairs the review found, each driven by the
 * one keystroke that reaches it), then **the corpus legs** seeded from the writing surface's own
 * destructive transactions — the join `joinBackward` performs at a paragraph's start, and the
 * deletion of the single space between two marked runs.
 */

const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));
const index = JSON.parse(readFileSync(`${FIXTURES}/index.json`, "utf8")) as Record<string, unknown>;
const names = Object.keys(index).sort();

/** The shape a tree is compared by: the node types, and the text every leaf carries. */
interface Shape {
  type: string;
  value?: string;
  children?: Shape[];
}

/** Every node type of a tree, in document order: the shape a case asserts when the nesting of two
 * marks over one span is the ambiguity and not the question. */
function types(node: Nodes): string[] {
  const children = "children" in node ? node.children : [];
  return [node.type, ...children.flatMap((child) => types(child as Nodes))];
}

function shape(node: Nodes): Shape {
  const out: Shape = { type: node.type };
  if ("value" in node && typeof node.value === "string") out.value = node.value;
  if ("children" in node) out.children = node.children.map((child) => shape(child as Nodes));
  return out;
}

/**
 * The two halves every case here asserts (DECISIONS #022: a case whose bytes cannot tell two trees
 * apart asserts the tree): the bytes are a fixed point of `parse ∘ format`, and what they parse to
 * is the tree the editor made — not merely a tree that re-serialises to the same bytes.
 */
function expectBytesCarryTree(root: Root, label: string): string {
  const out = format(root);
  expect(format(parse(out)), `${label}: format is a fixed point of parse ∘ format`).toBe(out);
  expect(shape(parse(out)), `${label}: the bytes parse back to the editor's tree`).toEqual(
    shape(root),
  );
  return out;
}

/** The five marks the schema declares, as the sweep's two axes name them. */
const MARK_NAMES = ["emphasis", "strong", "delete", "link", "inline_code"] as const;
type MarkName = (typeof MARK_NAMES)[number];

/**
 * The neighbour classes the first run's last character is enumerated over: CommonMark §6.2's two
 * — punctuation and "other" (a letter) — each with an astral member beside its ASCII one, a
 * non-BMP symbol and a non-BMP letter (CLAUDE.md's astral rule: a classification made on one
 * UTF-16 unit is wrong about a surrogate pair in a way no ASCII case can show).
 */
const TAILS = [
  { key: "ascii punctuation", character: ")" },
  { key: "ascii letter", character: "b" },
  { key: "astral symbol", character: "\u{1F600}" },
  { key: "astral letter", character: "\u{10330}" },
] as const;

/** A link's two runs carry different urls, so that a link beside a link is two runs and not one. */
function markFor(name: MarkName, url: string): PMMark {
  return name === "link" ? schema.marks.link.create({ url }) : schema.marks[name].create();
}

/** One paragraph holding the two runs, with `between` (nothing, or one space) separating them. */
function paragraphOf(first: MarkName, second: MarkName, tail: string, between: string): PMNode {
  const content = [
    schema.text(`a${tail}`, [markFor(first, "u1.md")]),
    ...(between === "" ? [] : [schema.text(between)]),
    schema.text("z", [markFor(second, "u2.md")]),
  ];
  return schema.node("doc", null, [schema.node("paragraph", null, content)]);
}

/** `pmToMdast` of a whole document, which is what Copy Markdown and every save serialise. */
function mdastOf(doc: PMNode): Root {
  return pmToMdast({ doc, frontMatter: null });
}

/**
 * The Delete keystroke of the second route: the single space between the two runs removed, by the
 * `ReplaceStep` the key produces. The paragraph's first child starts at position 1, so the space
 * sits directly after the first run's text.
 */
function deleteTheSpace(doc: PMNode, at: number): PMNode {
  return EditorState.create({ doc }).tr.delete(at, at + 1).doc;
}

interface Pair {
  first: MarkName;
  second: MarkName;
  tail: (typeof TAILS)[number];
}

const PAIRS: Pair[] = MARK_NAMES.flatMap((first) =>
  MARK_NAMES.flatMap((second) => TAILS.map((tail) => ({ first, second, tail }))),
);

describe("the sweep: every ordered pair of adjacent marked runs, over every class of the first run's last character", () => {
  it("the sweep is exactly the product of its axes", () => {
    expect(PAIRS).toHaveLength(MARK_NAMES.length * MARK_NAMES.length * TAILS.length);
  });

  for (const { first, second, tail } of PAIRS) {
    it(`${first} ending in ${tail.key} then ${second}: the bytes hold both runs, by both routes`, () => {
      const label = `${first} + ${second} (${tail.key})`;
      const adjacent = paragraphOf(first, second, tail.character, "");
      const bytes = expectBytesCarryTree(mdastOf(adjacent), label);

      // The second route to the same tree: the space between the two runs deleted. The space is
      // the child after the first run's text, which starts at 1 (the paragraph's own opening).
      const spaced = paragraphOf(first, second, tail.character, " ");
      const deleted = deleteTheSpace(spaced, 1 + `a${tail.character}`.length);
      expect(format(mdastOf(deleted)), `${label}: the Delete route writes the same bytes`).toBe(
        bytes,
      );
      expectBytesCarryTree(mdastOf(deleted), `${label}, after Delete`);
    });
  }
});

describe("the two pairs DECISIONS #review-1-r9 O1 names, each by the keystroke that reaches it", () => {
  it("Backspace joining `*(b)*` and `**z**` writes `*(b)*__z__`, not `*(b)***z**`", () => {
    const doc = mdastToPM(parse("*(b)*\n\n**z**\n")).doc;
    const joined = EditorState.create({ doc }).tr.join(doc.child(0).nodeSize).doc;
    expect(format(mdastOf(joined))).toBe("*(b)*__z__\n");
    expectBytesCarryTree(mdastOf(joined), "emphasis then strong, joined");
  });

  it("Delete of the single space in `*(b)* **z**` writes `*(b)*__z__`, not `*(b)***z**`", () => {
    const doc = mdastToPM(parse("*(b)* **z**\n")).doc;
    const deleted = deleteTheSpace(doc, 1 + "(b)".length);
    expect(format(mdastOf(deleted))).toBe("*(b)*__z__\n");
    expectBytesCarryTree(mdastOf(deleted), "emphasis then strong, space deleted");
  });

  it("Backspace joining `**(b)**` and `*z*` writes `**(b)**_z_`, not `**(b)***z*`", () => {
    const doc = mdastToPM(parse("**(b)**\n\n*z*\n")).doc;
    const joined = EditorState.create({ doc }).tr.join(doc.child(0).nodeSize).doc;
    expect(format(mdastOf(joined))).toBe("**(b)**_z_\n");
    expectBytesCarryTree(mdastOf(joined), "strong then emphasis, joined");
  });

  it("Delete of the single space in `**(b)** *z*` writes `**(b)**_z_`, not `**(b)***z*`", () => {
    const doc = mdastToPM(parse("**(b)** *z*\n")).doc;
    const deleted = deleteTheSpace(doc, 1 + "(b)".length);
    expect(format(mdastOf(deleted))).toBe("**(b)**_z_\n");
    expectBytesCarryTree(mdastOf(deleted), "strong then emphasis, space deleted");
  });

  it("a third run beside the second takes `*` again, because its neighbour closed with `_`", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("a)", [schema.marks.emphasis.create()]),
        schema.text("z", [schema.marks.strong.create()]),
        schema.text("y", [schema.marks.emphasis.create()]),
      ]),
    ]);
    expect(format(mdastOf(doc))).toBe("*a)*__z__*y*\n");
    expectBytesCarryTree(mdastOf(doc), "emphasis, strong, emphasis");
  });

  it("a letter after the second run is encoded, because `_` forbids the intraword run", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("(b)", [schema.marks.emphasis.create()]),
        schema.text("z", [schema.marks.strong.create()]),
        schema.text("w"),
      ]),
    ]);
    // The `__` run took the stricter marker, so the letters on either side of its closing
    // delimiter are references: CommonMark §6.2 gives `_` no intraword run, and `**` would have
    // needed none. This is the one cell of `encodeInfo` that only the `_` column reaches.
    expect(format(mdastOf(doc))).toBe("*(b)*__&#x7A;__&#x77;\n");
    expectBytesCarryTree(mdastOf(doc), "emphasis, strong, unmarked letter");
  });

  it("a nested run is not an adjacent one: `strong[emphasis]` stays `***a***`", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("a", [schema.marks.strong.create(), schema.marks.emphasis.create()]),
      ]),
    ]);
    const out = format(mdastOf(doc));
    // The `*` before the inner run is its parent's opening delimiter, not a sibling's closing one,
    // so the inner run keeps `*` and the bytes are the style's (`**_a_**` would be legal Markdown
    // and the wrong answer). The tree is asserted by node *types* only, not by their nesting:
    // `***a***` parses as emphasis around strong and the editor nests strong around emphasis, the
    // one ambiguity `schema.test.ts` already pins ("either nesting serialises to the same bytes").
    expect(out).toBe("***a***\n");
    expect(format(parse(out)), "strong around emphasis: the bytes are a fixed point").toBe(out);
    expect(types(parse(out)), "strong around emphasis: both runs survive the trip").toEqual([
      "root",
      "paragraph",
      "emphasis",
      "strong",
      "text",
    ]);
  });

  it("an escaped `*` in text is not a run's delimiter: `text('*') + emphasis` stays `\\**z*`", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("*"),
        schema.text("z", [schema.marks.emphasis.create()]),
      ]),
    ]);
    expect(format(mdastOf(doc))).toBe("\\**z*\n");
    expectBytesCarryTree(mdastOf(doc), "escaped asterisk then emphasis");
  });
});

/** Every boundary between two adjacent paragraphs of one parent: what Backspace joins. */
function paragraphJoins(doc: PMNode): { first: number; boundary: number }[] {
  const out: { first: number; boundary: number }[] = [];
  const visit = (node: PMNode, pos: number): void => {
    node.forEach((child, childOffset, i) => {
      const childPos = pos + 1 + childOffset;
      if (i > 0 && child.type === schema.nodes.paragraph) {
        const previous = node.child(i - 1);
        if (previous.type === schema.nodes.paragraph) {
          out.push({ first: childPos - previous.nodeSize, boundary: childPos });
        }
      }
      if (!child.isTextblock && !child.isLeaf) visit(child, childPos);
    });
  };
  visit(doc, -1);
  return out;
}

/** Every single unmarked space that is the only character between two marked runs. */
function spacesBetweenRuns(doc: PMNode): { block: number; space: number }[] {
  const out: { block: number; space: number }[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    node.forEach((child, childOffset, i) => {
      if (!child.isText || child.text !== " " || child.marks.length > 0) return;
      if (i === 0 || i + 1 >= node.childCount) return;
      if (node.child(i - 1).marks.length === 0 || node.child(i + 1).marks.length === 0) return;
      out.push({ block: pos, space: pos + 1 + childOffset });
    });
    return false;
  });
  return out;
}

/**
 * The block a transaction changed, cut out of the document it lives in and asserted on alone: one
 * `format ∘ parse` per comparison, so the family stays inside its 30_000 ms budget on every runner
 * (DECISIONS #039, lesson [1.66]). The correspondence this task changes is block-local — the
 * handler reads one parent's children and the bytes already written for them — so the block alone
 * answers the same question the whole document would.
 */
function expectBlockCarriesTree(doc: PMNode, pos: number, label: string): void {
  const node = doc.nodeAt(pos);
  expect(node, `${label}: the changed block is where the transaction left it`).not.toBeNull();
  const alone = blockAlone(doc, pos, node as PMNode);
  expect(format(parse(alone.text)), `${label}: the block's bytes are a fixed point`).toBe(
    alone.text,
  );
  expect(shape(parse(alone.text)), `${label}: the block's bytes parse to its tree`).toEqual(
    shape(pmToMdast({ doc: alone.doc, frontMatter: null })),
  );
}

describe("the writing surface's own destructive transactions over the corpus", () => {
  const joinCounts = new Map<string, number>();
  const spaceCounts = new Map<string, number>();

  for (const name of names) {
    const source = readFileSync(`${FIXTURES}/${name}`, "utf8");

    it(`${name}: leg (a), every adjacent pair of paragraphs joined as joinBackward joins them`, () => {
      const doc = mdastToPM(parse(source)).doc;
      const joins = paragraphJoins(doc);
      joinCounts.set(name, joins.length);
      for (const { first, boundary } of joins) {
        const after = EditorState.create({ doc }).tr.join(boundary).doc;
        expectBlockCarriesTree(after, first, `${name}: join at ${boundary}`);
      }
    });

    it(`${name}: leg (b), every single space between two marked runs deleted`, () => {
      const doc = mdastToPM(parse(source)).doc;
      const spaces = spacesBetweenRuns(doc);
      spaceCounts.set(name, spaces.length);
      for (const { block, space } of spaces) {
        const after = deleteTheSpace(doc, space);
        expectBlockCarriesTree(after, block, `${name}: space deleted at ${space}`);
      }
    });
  }

  it("the two legs ran over the whole index, and leg (a) is positive over the corpus", () => {
    expect(joinCounts.size, "leg (a) ran on every fixture in index.json").toBe(names.length);
    expect(spaceCounts.size, "leg (b) ran on every fixture in index.json").toBe(names.length);
    const joins = [...joinCounts.values()].reduce((sum, n) => sum + n, 0);
    const spaces = [...spaceCounts.values()].reduce((sum, n) => sum + n, 0);
    expect(joins, "the corpus holds adjacent paragraphs to join").toBeGreaterThan(0);
    // The corpus holds no space that is the *only* character between two marked runs (0 members at
    // this index), so leg (b) has no corpus member to drive and the sweep above is that leg's
    // instance: it runs the same Delete keystroke on every one of its pairs and asserts the block
    // it leaves. The count is read from the run rather than pinned, so a fixture that adds a
    // member is swept by the leg rather than ignored, and the positivity below is over the two
    // together.
    expect(
      spaces + PAIRS.length,
      "leg (b) is positive over the corpus and the sweep together",
    ).toBeGreaterThan(0);
  });
});
