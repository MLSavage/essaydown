import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "@essaydown/core";
import type { Mark, Node as PMNode } from "prosemirror-model";
import { EditorState, NodeSelection, TextSelection } from "prosemirror-state";
import { Decoration } from "prosemirror-view";
import { editorPlugins } from "../src/input.js";
import {
  DELIMITER_CLASS,
  activeBlock,
  delimiterDOM,
  markDelimiters,
  revealDecorations,
  revealDelimiters,
  revealPlugin,
  type Delimiter,
} from "../src/reveal.js";
import { mdastToPM, schema } from "../src/schema.js";

/**
 * The headless half of task 1.4. `e2e/web/editor-reveal.spec.ts` is the acceptance — it asserts
 * the literal delimiters in a real browser's DOM — and this file is where the plugin logic is
 * covered, where the shapes the acceptance does not type are pinned, and where the guards
 * enumerated from the diff each get a test.
 */

/** The shape the browser acceptance types: a heading and a paragraph with one strong span. */
const { doc: SIMPLE } = mdastToPM(parse("# Title\n\nHello **world**.\n"));

/** One block carrying every revealed mark at once, for the ordering and range-selection cases. */
const { doc: RICH } = mdastToPM(parse("# Title\n\nHello **world**, [a *b*](u.md 'T') and `c`.\n"));

/**
 * The position just after `needle` in the first textblock whose text contains it. Text offsets
 * and document offsets coincide inside a textblock made only of text nodes, which every document
 * here is up to the point being addressed.
 */
function cursorAt(doc: PMNode, needle: string): number {
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (!node.isTextblock) return true;
    const index = node.textContent.indexOf(needle);
    if (index >= 0) found = pos + 1 + index + needle.length;
    return false;
  });
  if (found === null) throw new Error(`no textblock contains "${needle}"`);
  return found;
}

function stateAt(doc: PMNode, pos: number): EditorState {
  return EditorState.create({ doc, selection: TextSelection.create(doc, pos) });
}

/** The delimiters revealed with the cursor just after `needle`. */
function revealedAt(doc: PMNode, needle: string): Delimiter[] {
  return revealDelimiters(stateAt(doc, cursorAt(doc, needle)).selection);
}

/** Just the literal Markdown, in drawing order — what the reader of a block would see. */
function texts(delimiters: readonly Delimiter[]): string[] {
  return delimiters.map((delimiter) => delimiter.text);
}

function paragraph(...content: PMNode[]): PMNode {
  return schema.node("doc", null, [schema.node("paragraph", null, content)]);
}

function marked(text: string, ...marks: Mark[]): PMNode {
  return schema.text(text, marks);
}

const strong = schema.marks.strong.create();
const emphasis = schema.marks.emphasis.create();
const code = schema.marks.inline_code.create();
const struck = schema.marks.delete.create();
const link = (url: string): Mark => schema.marks.link.create({ url });

describe("the block containing the cursor", () => {
  it("reveals the delimiters of a strong span the cursor is inside", () => {
    expect(revealedAt(SIMPLE, "wor")).toEqual([
      { pos: 14, side: 2, text: "**", kind: "strong" },
      { pos: 19, side: -2, text: "**", kind: "strong" },
    ]);
  });

  it("reveals every revealed mark of the block at once", () => {
    expect(texts(revealedAt(RICH, "wor"))).toEqual([
      "**",
      "**",
      "[",
      "*",
      "*",
      '](u.md "T")',
      "`",
      "`",
    ]);
  });

  it("reveals the same delimiters from anywhere else in the same block", () => {
    // The unit of reveal is the block, not the span: the cursor is in the plain text before the
    // strong span here, and the delimiters are the same ones.
    expect(revealedAt(SIMPLE, "Hell")).toEqual(revealedAt(SIMPLE, "wor"));
  });

  it("hides them when the cursor moves to another block", () => {
    // The heading is the other block; its own marker is revealed instead, and none of the
    // paragraph's delimiters are.
    const heading = revealedAt(SIMPLE, "Titl");
    expect(heading).toEqual([{ pos: 1, side: -1000, text: "# ", kind: "heading" }]);
  });

  it("reveals nothing at all when the selection is in no textblock", () => {
    const doc = schema.node("doc", null, [
      schema.node("raw", { value: "<div>x</div>" }),
      schema.node("paragraph", null, [marked("a", strong)]),
    ]);
    const selection = NodeSelection.create(doc, 0);
    expect(activeBlock(selection)).toBeNull();
    expect(revealDelimiters(selection)).toEqual([]);
  });

  it("reveals the block the head of a range selection is in", () => {
    const from = cursorAt(RICH, "Titl");
    const to = cursorAt(RICH, "wor");
    // Head in the paragraph: the paragraph's delimiters, not the heading's marker.
    expect(texts(revealDelimiters(TextSelection.create(RICH, from, to)))).toEqual([
      "**",
      "**",
      "[",
      "*",
      "*",
      '](u.md "T")',
      "`",
      "`",
    ]);
    // Head in the heading: the heading's marker, and nothing from the paragraph.
    expect(texts(revealDelimiters(TextSelection.create(RICH, to, from)))).toEqual(["# "]);
  });

  it("reveals a run selected within one block", () => {
    const doc = paragraph(marked("a", strong));
    const inside = TextSelection.create(doc, 1, 2);
    expect(texts(revealDelimiters(inside))).toEqual(["**", "**"]);
  });
});

describe("the delimiters of each revealed mark", () => {
  it("is `**` for strong, `*` for emphasis and a backtick for inline code", () => {
    expect(markDelimiters(strong)).toEqual({ open: "**", close: "**" });
    expect(markDelimiters(emphasis)).toEqual({ open: "*", close: "*" });
    expect(markDelimiters(code)).toEqual({ open: "`", close: "`" });
  });

  it("carries the link's destination in its closing delimiter", () => {
    expect(markDelimiters(link("u.md"))).toEqual({ open: "[", close: "](u.md)" });
  });

  it("carries the link's title too when it has one", () => {
    expect(markDelimiters(schema.marks.link.create({ url: "u.md", title: "T" }))).toEqual({
      open: "[",
      close: '](u.md "T")',
    });
  });

  it("is nothing for `delete`, which the task text does not name", () => {
    // The absence case, beside the four presence cases above: `~~` is never revealed, and a
    // struck span in the active block contributes no delimiter at all.
    expect(markDelimiters(struck)).toBeNull();
    expect(revealDelimiters(stateAt(paragraph(marked("a", struck)), 2).selection)).toEqual([]);
  });

  it("is the heading's own hashes, one per depth", () => {
    for (let depth = 1; depth <= 6; depth++) {
      const doc = schema.node("doc", null, [schema.node("heading", { depth }, [schema.text("T")])]);
      expect(revealDelimiters(stateAt(doc, 2).selection)).toEqual([
        { pos: 1, side: -1000, text: `${"#".repeat(depth)} `, kind: "heading" },
      ]);
    }
  });

  it("is nothing for a code block, whose fences are not in the task text", () => {
    const doc = schema.node("doc", null, [
      schema.node("code_block", { lang: "ts" }, [schema.text("const a = 1;")]),
    ]);
    expect(revealDelimiters(stateAt(doc, 2).selection)).toEqual([]);
  });
});

describe("a mark run", () => {
  it("is revealed at the first, middle and last position of a paragraph", () => {
    const first = paragraph(marked("a", strong), schema.text("bc"));
    const middle = paragraph(schema.text("a"), marked("b", strong), schema.text("c"));
    const last = paragraph(schema.text("ab"), marked("c", strong));
    expect(revealDelimiters(stateAt(first, 1).selection)).toEqual([
      { pos: 1, side: 2, text: "**", kind: "strong" },
      { pos: 2, side: -2, text: "**", kind: "strong" },
    ]);
    expect(revealDelimiters(stateAt(middle, 1).selection)).toEqual([
      { pos: 2, side: 2, text: "**", kind: "strong" },
      { pos: 3, side: -2, text: "**", kind: "strong" },
    ]);
    expect(revealDelimiters(stateAt(last, 1).selection)).toEqual([
      { pos: 3, side: 2, text: "**", kind: "strong" },
      { pos: 4, side: -2, text: "**", kind: "strong" },
    ]);
  });

  it("spans every adjacent child that carries the same mark", () => {
    // Two text nodes, same strong mark, one run: one opening and one closing delimiter, not two
    // of each.
    const doc = paragraph(marked("a", strong), marked("b", strong, emphasis));
    expect(revealDelimiters(stateAt(doc, 1).selection)).toEqual([
      { pos: 1, side: 2, text: "**", kind: "strong" },
      { pos: 2, side: 3, text: "*", kind: "emphasis" },
      { pos: 3, side: -3, text: "*", kind: "emphasis" },
      { pos: 3, side: -2, text: "**", kind: "strong" },
    ]);
  });

  it("ends where the mark ends, and a later run of the same mark is a second run", () => {
    const doc = paragraph(marked("a", strong), schema.text("b"), marked("c", strong));
    expect(revealDelimiters(stateAt(doc, 1).selection)).toEqual([
      { pos: 1, side: 2, text: "**", kind: "strong" },
      { pos: 2, side: -2, text: "**", kind: "strong" },
      { pos: 3, side: 2, text: "**", kind: "strong" },
      { pos: 4, side: -2, text: "**", kind: "strong" },
    ]);
  });

  it("is two runs when two adjacent links differ, one when they are equal", () => {
    // `Mark.eq`, not the mark type: the two links below are adjacent and the same type.
    const two = paragraph(marked("a", link("one.md")), marked("b", link("two.md")));
    expect(texts(revealDelimiters(stateAt(two, 1).selection))).toEqual([
      "[",
      "](one.md)",
      "[",
      "](two.md)",
    ]);
    const one = paragraph(marked("a", link("one.md")), marked("b", link("one.md")));
    expect(texts(revealDelimiters(stateAt(one, 1).selection))).toEqual(["[", "](one.md)"]);
  });

  it("meets the next run at one position, closing before the next opens", () => {
    const doc = paragraph(marked("a", strong), marked("b", emphasis));
    expect(revealDelimiters(stateAt(doc, 1).selection)).toEqual([
      { pos: 1, side: 2, text: "**", kind: "strong" },
      { pos: 2, side: -2, text: "**", kind: "strong" },
      { pos: 2, side: 3, text: "*", kind: "emphasis" },
      { pos: 3, side: -3, text: "*", kind: "emphasis" },
    ]);
  });

  it("nests in the schema's mark order, outermost first", () => {
    // `link` is declared before `strong` in the schema, so `[**a**](u.md)`: the link opens first
    // and closes last, whichever order the marks happen to be in on the node.
    const doc = paragraph(marked("a", strong, link("u.md")));
    expect(texts(revealDelimiters(stateAt(doc, 1).selection))).toEqual([
      "[",
      "**",
      "**",
      "](u.md)",
    ]);
  });

  it("closes at the end of the block when it runs to the end", () => {
    const doc = paragraph(schema.text("a"), marked("bc", strong));
    expect(revealDelimiters(stateAt(doc, 1).selection)).toEqual([
      { pos: 2, side: 2, text: "**", kind: "strong" },
      { pos: 4, side: -2, text: "**", kind: "strong" },
    ]);
  });

  it("survives an inline atom carrying the mark", () => {
    const doc = paragraph(
      schema.node("image", { url: "i.png", alt: "x" }, undefined, [strong]),
      marked("a", strong),
    );
    expect(revealDelimiters(stateAt(doc, 1).selection)).toEqual([
      { pos: 1, side: 2, text: "**", kind: "strong" },
      { pos: 3, side: -2, text: "**", kind: "strong" },
    ]);
  });

  it("is nothing in an empty block", () => {
    const doc = schema.node("doc", null, [schema.node("paragraph")]);
    expect(revealDelimiters(stateAt(doc, 1).selection)).toEqual([]);
  });

  it("is scoped to the table cell the cursor is in", () => {
    const cell = (content: PMNode[]): PMNode => schema.node("table_cell", null, content);
    const doc = schema.node("doc", null, [
      schema.node("table", { align: null }, [
        schema.node("table_row", null, [
          cell([marked("a", strong)]),
          cell([marked("b", emphasis)]),
        ]),
      ]),
    ]);
    // Inside the first cell: only its own run.
    expect(texts(revealDelimiters(stateAt(doc, 4).selection))).toEqual(["**", "**"]);
    // Inside the second: only that one.
    expect(texts(revealDelimiters(stateAt(doc, 7).selection))).toEqual(["*", "*"]);
  });

  it("is scoped to the paragraph the cursor is in inside a blockquote", () => {
    const para = (content: PMNode[]): PMNode => schema.node("paragraph", null, content);
    const doc = schema.node("doc", null, [
      schema.node("blockquote", null, [para([marked("a", strong)]), para([marked("b", code)])]),
    ]);
    expect(texts(revealDelimiters(stateAt(doc, 3).selection))).toEqual(["**", "**"]);
    expect(texts(revealDelimiters(stateAt(doc, 6).selection))).toEqual(["`", "`"]);
  });
});

describe("purity", () => {
  it("returns the same delimiters for the same selection and mutates nothing", () => {
    const before = JSON.stringify(RICH.toJSON());
    const selection = stateAt(RICH, cursorAt(RICH, "wor")).selection;
    expect(revealDelimiters(selection)).toEqual(revealDelimiters(selection));
    expect(JSON.stringify(RICH.toJSON())).toBe(before);
  });
});

describe("the decorations", () => {
  it("is one widget per delimiter, at the delimiter's position", () => {
    const state = stateAt(SIMPLE, cursorAt(SIMPLE, "wor"));
    const found = revealDecorations(state).find();
    expect(found.map((decoration) => [decoration.from, decoration.to])).toEqual([
      [14, 14],
      [19, 19],
    ]);
    expect(found.every((decoration) => decoration.spec.marks.length === 0)).toBe(true);
  });

  it("keys each widget by what it draws, so a redraw can reuse it", () => {
    const state = stateAt(SIMPLE, cursorAt(SIMPLE, "wor"));
    expect(
      revealDecorations(state)
        .find()
        .map((decoration) => decoration.spec.key),
    ).toEqual(["strong:2:**", "strong:-2:**"]);
  });

  it("is empty for a block with nothing to reveal", () => {
    const doc = paragraph(schema.text("plain"));
    expect(revealDecorations(stateAt(doc, 2)).find()).toEqual([]);
  });

  it("is what the plugin's `decorations` prop returns", () => {
    const plugin = revealPlugin();
    const state = stateAt(SIMPLE, cursorAt(SIMPLE, "wor"));
    const fromProp = plugin.props.decorations?.call(plugin, state);
    expect(fromProp).toBeInstanceOf(Object);
    expect((fromProp as ReturnType<typeof revealDecorations>).find()).toHaveLength(2);
  });

  it("is installed by `editorPlugins`, which now installs four plugins", () => {
    const plugins = editorPlugins();
    expect(plugins).toHaveLength(4);
    expect(plugins.filter((plugin) => plugin.props.decorations !== undefined)).toHaveLength(1);
  });
});

describe("the widget element", () => {
  /** A recording stand-in for the one DOM call {@link delimiterDOM} makes. */
  function fakeView(): { view: { dom: { ownerDocument: Document } }; created: FakeElement[] } {
    const created: FakeElement[] = [];
    const ownerDocument = {
      createElement(tagName: string): FakeElement {
        const element: FakeElement = {
          tagName,
          className: "",
          textContent: null,
          attributes: {},
          setAttribute(name: string, value: string): void {
            element.attributes[name] = value;
          },
        };
        created.push(element);
        return element;
      },
    };
    return { view: { dom: { ownerDocument: ownerDocument as unknown as Document } }, created };
  }

  interface FakeElement {
    tagName: string;
    className: string;
    textContent: string | null;
    attributes: Record<string, string>;
    setAttribute(name: string, value: string): void;
  }

  it("is a non-editable span holding the literal delimiter", () => {
    const { view, created } = fakeView();
    const element = delimiterDOM("**")(view) as unknown as FakeElement;
    expect(created).toHaveLength(1);
    expect(element.tagName).toBe("span");
    expect(element.className).toBe(DELIMITER_CLASS);
    expect(element.textContent).toBe("**");
    expect(element.attributes.contenteditable).toBe("false");
    expect(element.attributes["data-delimiter"]).toBe("**");
    expect(element.attributes.style).toContain("color:");
  });

  it("builds one element per call, from the view's own document", () => {
    const { view, created } = fakeView();
    const make = delimiterDOM("`");
    make(view);
    make(view);
    expect(created).toHaveLength(2);
    expect(created.map((element) => element.textContent)).toEqual(["`", "`"]);
  });

  it("is what the decorations draw with", () => {
    const { view, created } = fakeView();
    const decoration = revealDecorations(stateAt(SIMPLE, cursorAt(SIMPLE, "wor"))).find()[0];
    // `Decoration.widget`'s DOM factory is reached through the decoration's own `type`, which is
    // how prosemirror-view reaches it when it draws. `type` is not in the published types — this
    // is the one place the test steps behind them, so that the wiring between the decorations and
    // {@link delimiterDOM} is proved headlessly as well as in the browser (A6 of the acceptance
    // reads the `data-delimiter` attribute, which nothing else sets).
    const widget = decoration as unknown as { type: { toDOM: (view: unknown) => unknown } };
    widget.type.toDOM(view);
    expect(created.map((element) => element.textContent)).toEqual(["**"]);
    expect(decoration).toBeInstanceOf(Decoration);
  });
});

interface FixtureIndex {
  [name: string]: unknown;
}

const INDEX = JSON.parse(
  readFileSync(new URL("../../../fixtures/markdown/index.json", import.meta.url), "utf8"),
) as FixtureIndex;

interface Sweep {
  blocks: number;
  /** One entry per textblock: the block's own bounds and what revealing it produced. */
  revealed: { start: number; end: number; delimiters: Delimiter[] }[];
}

/** Put the cursor at the start of every textblock of a fixture in turn and record what it reveals. */
function sweep(name: string): Sweep {
  const source = readFileSync(
    new URL(`../../../fixtures/markdown/${name}`, import.meta.url),
    "utf8",
  );
  const { doc } = mdastToPM(parse(source));
  const revealed: Sweep["revealed"] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const start = pos + 1;
    revealed.push({
      start,
      end: start + node.content.size,
      delimiters: revealDelimiters(TextSelection.create(doc, start)),
    });
    return false;
  });
  return { blocks: revealed.length, revealed };
}

/**
 * The corpus is not the acceptance here — the acceptance is the browser — but it is the only
 * place the plugin meets every node shape the model admits. For every fixture, the cursor is put
 * at the start of every textblock in turn and every delimiter is required to lie inside that
 * block. The presence partner asserts the sweep actually finds delimiters of every revealed kind,
 * so a plugin that returned nothing anywhere could not pass; each `it` does its own sweep, so no
 * assertion here depends on the order the others ran in.
 */
describe("over the fixture corpus", () => {
  for (const name of Object.keys(INDEX)) {
    it(`keeps every delimiter inside the active block of ${name}`, () => {
      for (const block of sweep(name).revealed) {
        for (const delimiter of block.delimiters) {
          expect(delimiter.pos).toBeGreaterThanOrEqual(block.start);
          expect(delimiter.pos).toBeLessThanOrEqual(block.end);
        }
      }
    });
  }

  it("finds every revealed kind somewhere in the corpus, and no other", () => {
    const kinds = new Set<string>();
    let blocks = 0;
    for (const name of Object.keys(INDEX)) {
      const swept = sweep(name);
      blocks += swept.blocks;
      for (const block of swept.revealed) {
        for (const delimiter of block.delimiters) kinds.add(delimiter.kind);
      }
    }
    expect(blocks).toBeGreaterThan(Object.keys(INDEX).length);
    expect([...kinds].sort()).toEqual(["emphasis", "heading", "inline_code", "link", "strong"]);
  });

  it("lists exactly the fixtures on disk, so the index does not certify its own coverage", () => {
    const sources = readdirSync(new URL("../../../fixtures/markdown/", import.meta.url))
      .filter((entry) => entry.endsWith(".md") && !entry.endsWith(".canonical.md"))
      .sort();
    expect(Object.keys(INDEX).sort()).toEqual(sources);
  });
});
