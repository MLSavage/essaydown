import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Nodes, Root } from "mdast";
import type { Mark as PMMark, Node as PMNode } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import { format } from "../../core/src/format.js";
import { parse } from "../../core/src/parse.js";
import { insertHardBreak } from "../src/input.js";
import { mdastToPM, pmToMdast, schema } from "../src/schema.js";

/**
 * Task 3.23 (DECISIONS #review-3-r0 C1, C6): an inline-code run swallowed a hard break and a link
 * on save.
 *
 * - **C1.** Shift+Enter at a code span's closing edge inserted a `hard_break` carrying
 *   `inline_code` (`replaceSelectionWith`'s default `inheritMarks`), and `pmToMdast` folded it into
 *   the code run as its empty `textContent`: `` `alpha`beta `` saved with no break. Fixed twice
 *   over: `insertHardBreak` never gives the break `inline_code`, and `runEnd` / `outermostMark`
 *   never fold a `hard_break` into a code run, so a hand-built or pasted one is written as a break.
 * - **C6.** One character typed at the start of `` [`cd`](v) `` took `inline_code` but not `link`
 *   (`link` is not inclusive), and `runEnd` grew the code run while `inline_code` was in the next
 *   node's set rather than while the whole set agreed: `` `Xcd` tail `` saved with the link gone.
 *   An `inline_code` run now spans only nodes of one markup.
 *
 * The installed `mdast-util-to-markdown` handlers both halves answer to: `break` writes `\` + a line
 * ending (a space in a construct that cannot hold one), and `inlineCode` writes its `value` between
 * fences with no escaping — so a code span cannot hold a break, and anything folded into one is
 * literal text or nothing.
 */

const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));
const index = JSON.parse(readFileSync(`${FIXTURES}/index.json`, "utf8")) as Record<string, unknown>;
const names = Object.keys(index).sort();

const MARK_NAMES = ["emphasis", "strong", "delete", "link", "inline_code"] as const;
type MarkName = (typeof MARK_NAMES)[number];

function markFor(name: MarkName, url = "u.md"): PMMark {
  return name === "link" ? schema.marks.link.create({ url }) : schema.marks[name].create();
}

function paragraph(content: PMNode[]): PMNode {
  return schema.node("doc", null, [schema.node("paragraph", null, content)]);
}

function save(doc: PMNode): string {
  return format(pmToMdast({ doc, frontMatter: null }));
}

function count(node: Nodes, type?: string): number {
  const children = "children" in node ? node.children : [];
  const own = type === undefined || node.type === type ? 1 : 0;
  return own + children.reduce((sum, child) => sum + count(child as Nodes, type), 0);
}

/** The bytes are a fixed point of `parse ∘ format`. */
function expectFixedPoint(bytes: string, label: string): void {
  expect(format(parse(bytes)), `${label}: a fixed point of parse ∘ format`).toBe(bytes);
}

/** Shift+Enter with the caret at `pos`, as the keymap runs it. */
function shiftEnter(doc: PMNode, pos: number): EditorState {
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, pos) });
  const handled = insertHardBreak(state, (tr) => {
    state = state.apply(tr);
  });
  expect(handled).toBe(true);
  return state;
}

/** One character typed at `pos`, with the marks the view's own insertion gives it. */
function typeAt(doc: PMNode, pos: number, character: string): PMNode {
  return EditorState.create({ doc }).tr.insertText(character, pos).doc;
}

/** The marks of the one `hard_break` in `doc`. */
function breakMarks(doc: PMNode): string[] {
  const found: string[][] = [];
  doc.descendants((node) => {
    if (node.type === schema.nodes.hard_break) found.push(node.marks.map((m) => m.type.name));
    return true;
  });
  expect(found).toHaveLength(1);
  return found[0];
}

/* ------------------------------------------------------------- (1) and (2): Shift+Enter ---- */

/** The run's own text: ASCII, and the astral member (a non-BMP letter at both of its edges). */
const RUN_TEXTS = [
  { key: "ascii", text: "alpha" },
  { key: "astral", text: "\u{10330}lph\u{10330}" },
] as const;

/** What sits outside the edge the caret is at: text with a space between, text flush, nothing. */
const OUTSIDES = ["spaced", "unspaced", "block edge"] as const;
type Outside = (typeof OUTSIDES)[number];

const EDGES = ["closing", "opening"] as const;

interface BreakCase {
  kind: MarkName;
  edge: (typeof EDGES)[number];
  outside: Outside;
  run: (typeof RUN_TEXTS)[number];
}

const BREAK_CASES: BreakCase[] = MARK_NAMES.flatMap((kind) =>
  EDGES.flatMap((edge) =>
    OUTSIDES.flatMap((outside) => RUN_TEXTS.map((run) => ({ kind, edge, outside, run }))),
  ),
);

/**
 * One paragraph holding `pre`, the marked run and `post`, and the caret at the run's edge. The
 * outside text sits on the edge's side; at the block edge the *other* side keeps a word, so the
 * break always has content on one side of it and the run has the block's edge on the other.
 */
function breakCase({ kind, edge, outside, run }: BreakCase): { doc: PMNode; caret: number } {
  const neighbour = outside === "block edge" ? "" : outside === "spaced" ? " beta" : "beta";
  const before = edge === "opening" ? [...neighbour].reverse().join("") : "";
  const after = edge === "closing" ? neighbour : "";
  const content = [
    ...(before === "" ? [] : [schema.text(before)]),
    schema.text(run.text, [markFor(kind)]),
    ...(after === "" ? [] : [schema.text(after)]),
  ];
  const caret = 1 + before.length + (edge === "closing" ? run.text.length : 0);
  return { doc: paragraph(content), caret };
}

/**
 * The marks `replaceSelectionWith`'s default inheritance would have given the break before this
 * task — `$from.marks()` at the caret — which guard (2) asserts the command keeps but for
 * `inline_code`.
 */
function inheritedAt(doc: PMNode, pos: number): string[] {
  return doc
    .resolve(pos)
    .marks()
    .map((m) => m.type.name);
}

describe("guard (1): Shift+Enter at either edge of each mark kind keeps the break, and the bytes are a fixed point", () => {
  it("the enumeration is exactly the product of its axes", () => {
    expect(BREAK_CASES).toHaveLength(
      MARK_NAMES.length * EDGES.length * OUTSIDES.length * RUN_TEXTS.length,
    );
  });

  for (const c of BREAK_CASES) {
    it(`${c.kind}, ${c.edge} edge, ${c.outside}, ${c.run.key}: the break is in the saved bytes`, () => {
      const { doc, caret } = breakCase(c);
      const after = shiftEnter(doc, caret).doc;
      const bytes = save(after);
      const label = `${c.kind} ${c.edge} ${c.outside} ${c.run.key} → ${JSON.stringify(bytes)}`;
      if (c.edge === "closing" && c.outside === "block edge") {
        // A hard break is not Markdown at a paragraph's end (CommonMark §6.7: "neither syntax for
        // hard line breaks works at the end of a paragraph"), so the converter writes the block
        // as it was, for every mark kind alike: the bounded class, asserted as what it is.
        expect(count(parse(bytes), "break"), `${label}: no break at the block's end`).toBe(0);
        expect(bytes, `${label}: the block as it was`).toBe(save(doc));
      } else {
        expect(count(parse(bytes), "break"), `${label}: the break survives`).toBe(1);
      }
      expect(count(parse(bytes), c.kind === "inline_code" ? "inlineCode" : c.kind), label).toBe(1);
      expectFixedPoint(bytes, label);
    });
  }
});

describe("guard (2): the inserted break's marks are today's inheritance minus inline_code", () => {
  for (const c of BREAK_CASES) {
    it(`${c.kind}, ${c.edge} edge, ${c.outside}, ${c.run.key}: the break carries every inherited mark but inline_code`, () => {
      const { doc, caret } = breakCase(c);
      const inherited = inheritedAt(doc, caret);
      const marks = breakMarks(shiftEnter(doc, caret).doc);
      expect(marks).toEqual(inherited.filter((name) => name !== "inline_code"));
      expect(marks).not.toContain("inline_code");
    });
  }

  it("presence: inside each of the four other marks the break carries it", () => {
    for (const kind of MARK_NAMES.filter((k) => k !== "inline_code")) {
      const doc = paragraph([schema.text("alpha", [markFor(kind)])]);
      expect(breakMarks(shiftEnter(doc, 3).doc), kind).toEqual([kind]);
    }
  });

  it("absence: inside a code span the break carries nothing, and it sits between two code spans", () => {
    const doc = paragraph([schema.text("alpha", [markFor("inline_code")])]);
    const after = shiftEnter(doc, 3).doc;
    expect(breakMarks(after)).toEqual([]);
    expect(save(after)).toBe("`al`\\\n`pha`\n");
  });

  it("stored marks win as they did, minus inline_code", () => {
    const doc = paragraph([schema.text("alpha")]);
    let state = EditorState.create({ doc, selection: TextSelection.create(doc, 3) });
    state = state.apply(
      state.tr.setStoredMarks([markFor("strong"), markFor("inline_code")]),
    );
    insertHardBreak(state, (tr) => {
      state = state.apply(tr);
    });
    expect(breakMarks(state.doc)).toEqual(["strong"]);
  });

  it("a non-empty selection inherits the marks across it, minus inline_code", () => {
    const doc = paragraph([schema.text("alpha", [markFor("emphasis"), markFor("inline_code")])]);
    let state = EditorState.create({ doc, selection: TextSelection.create(doc, 2, 4) });
    insertHardBreak(state, (tr) => {
      state = state.apply(tr);
    });
    expect(breakMarks(state.doc)).toEqual(["emphasis"]);
  });
});

describe("the review's probes, each saved", () => {
  it("`` `alpha`beta `` with Shift+Enter after `alpha` keeps the break", () => {
    const doc = mdastToPM(parse("`alpha`beta\n")).doc;
    const bytes = save(shiftEnter(doc, 1 + "alpha".length).doc);
    expect(bytes).toBe("`alpha`\\\nbeta\n");
    expectFixedPoint(bytes, "alpha beta");
  });

  it("`` `alpha` beta `` with Shift+Enter after `alpha` keeps the break", () => {
    const doc = mdastToPM(parse("`alpha` beta\n")).doc;
    const bytes = save(shiftEnter(doc, 1 + "alpha".length).doc);
    // The space after the break starts the next line, where CommonMark strips it on reading; the
    // converter drops it on writing for the same reason (it is not the code run's to lose).
    expect(bytes).toBe("`alpha`\\\nbeta\n");
    expectFixedPoint(bytes, "alpha, space, beta");
  });

  it("`` [`cd`](v) tail `` with `X` typed at the start keeps the link", () => {
    const doc = mdastToPM(parse("[`cd`](v) tail\n")).doc;
    const bytes = save(typeAt(doc, 1, "X"));
    expect(bytes).toBe("`X`[`cd`](v) tail\n");
    expectFixedPoint(bytes, "X before the link");
  });
});

/* ------------------------------------------------- (3): a hard_break that carries inline_code ---- */

describe("guard (3): a hand-built hard_break carrying inline_code is written as a break", () => {
  const code = markFor("inline_code");

  it("between two code runs: the run is split at the break", () => {
    const doc = paragraph([
      schema.text("alpha", [code]),
      schema.nodes.hard_break.create(null, null, [code]),
      schema.text("beta", [code]),
    ]);
    const bytes = save(doc);
    expect(bytes).toBe("`alpha`\\\n`beta`\n");
    expect(count(parse(bytes), "break")).toBe(1);
    expect(count(parse(bytes), "inlineCode")).toBe(2);
    expectFixedPoint(bytes, "code, break, code");
  });

  it("after a code run, before plain text", () => {
    const doc = paragraph([
      schema.text("alpha", [code]),
      schema.nodes.hard_break.create(null, null, [code]),
      schema.text("beta"),
    ]);
    const bytes = save(doc);
    expect(bytes).toBe("`alpha`\\\nbeta\n");
    expectFixedPoint(bytes, "code, break, text");
  });

  it("under an enclosing emphasis, the break keeps the emphasis and drops out of the code", () => {
    const em = markFor("emphasis");
    const doc = paragraph([
      schema.text("alpha", [em, code]),
      schema.nodes.hard_break.create(null, null, [em, code]),
      schema.text("beta", [em, code]),
    ]);
    const bytes = save(doc);
    expect(count(parse(bytes), "break")).toBe(1);
    expect(count(parse(bytes), "emphasis")).toBe(1);
    expect(count(parse(bytes), "inlineCode")).toBe(2);
    expectFixedPoint(bytes, "emphasis around code, break, code");
  });
});

/* ------------------------------------------------- (4): one character at a link-wrapped code ---- */

const LINKED_CODE = [
  { key: "bare", source: "[`cd`](v) tail\n" },
  { key: "inside an emphasis", source: "*[`cd`](v) tail*\n" },
] as const;

/** The position of the start and of the end of the first node carrying both `link` and `inline_code`. */
function linkedCodeEdges(doc: PMNode): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  doc.descendants((node, pos) => {
    const linked =
      node.isText &&
      schema.marks.link.isInSet(node.marks) !== undefined &&
      schema.marks.inline_code.isInSet(node.marks) !== undefined;
    if (linked) out.push({ start: pos, end: pos + node.nodeSize });
    return true;
  });
  return out;
}

describe("guard (4): one character at either edge of a link-wrapped code span keeps the link (M2: node count)", () => {
  for (const { key, source } of LINKED_CODE) {
    for (const edge of ["start", "end"] as const) {
      it(`${key}, \`X\` typed at the ${edge}: the link is present and parse(format(·)) has the tree's node count`, () => {
        const doc = mdastToPM(parse(source)).doc;
        const [span] = linkedCodeEdges(doc);
        const typed = typeAt(doc, span[edge], "X");
        const root: Root = pmToMdast({ doc: typed, frontMatter: null });
        const bytes = format(root);
        expect(count(parse(bytes), "link"), JSON.stringify(bytes)).toBe(1);
        expect(count(parse(bytes)), JSON.stringify(bytes)).toBe(count(root));
        expect(bytes).toContain("X");
        expectFixedPoint(bytes, `${key} ${edge}`);
      });
    }
  }
});

/* ----------------------------------------------- (5): the corpus leg, seeded from the surface ---- */

/**
 * Every link-wrapped code span of `doc`, and — the writing surface's own route to one — every code
 * span the corpus holds bare, wrapped in a link by the `addMark` a link command makes.
 */
function linkEveryCodeSpan(doc: PMNode): PMNode {
  const spans: { from: number; to: number }[] = [];
  doc.descendants((node, pos) => {
    if (node.isText && schema.marks.inline_code.isInSet(node.marks) !== undefined) {
      if (schema.marks.link.isInSet(node.marks) === undefined) {
        spans.push({ from: pos, to: pos + node.nodeSize });
      }
    }
    return true;
  });
  let tr = EditorState.create({ doc }).tr;
  for (const { from, to } of spans) {
    tr = tr.addMark(from, to, schema.marks.link.create({ url: "linked.md" }));
  }
  return tr.doc;
}

describe("guard (5): the corpus leg — one character typed at each edge of every link-wrapped code span", () => {
  const native = new Map<string, number>();
  const linked = new Map<string, number>();

  for (const name of names) {
    it(`${name}: every link-wrapped code span, X typed at each edge, keeps its links and is a fixed point`, () => {
      const parsed = mdastToPM(parse(readFileSync(`${FIXTURES}/${name}`, "utf8"))).doc;
      native.set(name, linkedCodeEdges(parsed).length);
      const doc = linkEveryCodeSpan(parsed);
      const edges = linkedCodeEdges(doc);
      linked.set(name, edges.length);
      const links = count(parse(save(doc)), "link");
      for (const { start, end } of edges) {
        for (const pos of [start, end]) {
          const bytes = save(typeAt(doc, pos, "X"));
          const label = `${name} at ${pos}`;
          expectFixedPoint(bytes, label);
          expect(count(parse(bytes), "link"), `${label}: the link count`).toBe(links);
        }
      }
    });
  }

  it("the leg ran over the whole index and reached link-wrapped code spans", () => {
    expect(linked.size).toBe(names.length);
    // The corpus holds no link-wrapped code span of its own at this index (read from the run, not
    // pinned), so the members are the corpus's code spans linked by the writing surface's own mark
    // step; a fixture that adds one is driven as it stands.
    const nativeTotal = [...native.values()].reduce((sum, n) => sum + n, 0);
    const total = [...linked.values()].reduce((sum, n) => sum + n, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeGreaterThanOrEqual(nativeTotal);
    console.info(`[3.23] guard (5): ${nativeTotal} native, ${total} linked code spans`);
  });
});

/* ------------------------------------------- (6): task 1.67's sweep with a composite first run ---- */

const TAILS = [
  { key: "ascii punctuation", character: ")" },
  { key: "ascii letter", character: "b" },
  { key: "astral symbol", character: "\u{1F600}" },
  { key: "astral letter", character: "\u{10330}" },
] as const;

interface Shape {
  type: string;
  value?: string;
  children?: Shape[];
}

function shape(node: Nodes): Shape {
  const out: Shape = { type: node.type };
  if ("value" in node && typeof node.value === "string") out.value = node.value;
  if ("children" in node) out.children = node.children.map((child) => shape(child as Nodes));
  return out;
}

const COMPOSITE = (): PMMark[] => [markFor("link", "u1.md"), markFor("inline_code")];

/** The two runs, `between` (nothing or one space) separating them; `compositeFirst` orders them. */
function pairOf(second: MarkName, tail: string, between: string, compositeFirst: boolean): PMNode {
  const composite = schema.text(compositeFirst ? `a${tail}` : "z", COMPOSITE());
  const other = schema.text(compositeFirst ? "z" : `a${tail}`, [markFor(second, "u2.md")]);
  const middle = between === "" ? [] : [schema.text(between)];
  return paragraph(compositeFirst ? [composite, ...middle, other] : [other, ...middle, composite]);
}

describe("guard (6): task 1.67's ordered-pair sweep with inline_code+link as a composite run", () => {
  for (const compositeFirst of [true, false]) {
    for (const second of MARK_NAMES) {
      for (const tail of TAILS) {
        const order = compositeFirst
          ? `inline_code+link ending in ${tail.key} then ${second}`
          : `${second} ending in ${tail.key} then inline_code+link`;
        it(`${order}: the bytes hold both runs, by both routes`, () => {
          const adjacent = pairOf(second, tail.character, "", compositeFirst);
          const root = pmToMdast({ doc: adjacent, frontMatter: null });
          const bytes = format(root);
          expectFixedPoint(bytes, order);
          expect(shape(parse(bytes)), `${order}: the bytes parse to the editor's tree`).toEqual(
            shape(root),
          );
          expect(count(parse(bytes), "link"), order).toBe(second === "link" ? 2 : 1);

          const spaced = pairOf(second, tail.character, " ", compositeFirst);
          // The first run is `a` + tail in both orders, so the space sits directly after it.
          const space = 1 + `a${tail.character}`.length;
          const deleted = EditorState.create({ doc: spaced }).tr.delete(space, space + 1).doc;
          expect(save(deleted), `${order}: the Delete route writes the same bytes`).toBe(bytes);
        });
      }
    }
  }
});
