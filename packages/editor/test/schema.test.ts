import type { PhrasingContent, Root } from "mdast";
import { Schema, type DOMOutputSpec, type Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { format } from "../../core/src/format.js";
import { parse } from "../../core/src/parse.js";
import {
  MDAST_TYPES,
  RAW_CLASS,
  marks,
  mdastToPM,
  nodes,
  pmToMdast,
  schema,
  type EditorDocument,
} from "../src/schema.js";

/** `format(pmToMdast(mdastToPM(parse(x))))` — the whole trip, from bytes to bytes. */
function roundTrip(markdown: string): string {
  return format(pmToMdast(mdastToPM(parse(markdown))));
}

function docOf(markdown: string): EditorDocument {
  return mdastToPM(parse(markdown));
}

/** The block/inline children of a ProseMirror node, as an array. */
function childrenOf(node: PMNode): PMNode[] {
  const out: PMNode[] = [];
  node.forEach((child) => out.push(child));
  return out;
}

function domOf(node: PMNode): DOMOutputSpec {
  const toDOM = node.type.spec.toDOM;
  expect(toDOM, `${node.type.name} has no toDOM`).toBeTypeOf("function");
  return toDOM!(node);
}

describe("the schema maps 1:1 to the node set of PRD §6.1", () => {
  // The mapping, written out once. `html` is the single mdast type with two schema nodes, because
  // ProseMirror types a node as block or inline and mdast puts `html` in both positions.
  const MAPPING: Record<(typeof MDAST_TYPES)[number], string[]> = {
    blockquote: ["blockquote"],
    break: ["hard_break"],
    code: ["code_block"],
    delete: ["delete"],
    emphasis: ["emphasis"],
    heading: ["heading"],
    html: ["raw", "raw_inline"],
    image: ["image"],
    inlineCode: ["inline_code"],
    link: ["link"],
    list: ["list"],
    listItem: ["list_item"],
    paragraph: ["paragraph"],
    strong: ["strong"],
    table: ["table"],
    tableCell: ["table_cell"],
    tableRow: ["table_row"],
    text: ["text"],
    thematicBreak: ["thematic_break"],
  };

  it("every mdast type of §6.1 that enters the doc has a mapping", () => {
    expect(Object.keys(MAPPING).sort()).toEqual([...MDAST_TYPES].sort());
  });

  it("root and yaml are the two §6.1 types that are not in the doc", () => {
    // `root` becomes `doc`; `yaml` is held beside it. Neither is a mapped node type.
    expect(MDAST_TYPES).not.toContain("root");
    expect(MDAST_TYPES).not.toContain("yaml");
    expect(schema.nodes.doc).toBeDefined();
    expect(schema.nodes.yaml).toBeUndefined();
    expect(schema.marks.yaml).toBeUndefined();
  });

  it("every schema node and mark is the image of exactly one mdast type", () => {
    const mapped = Object.values(MAPPING).flat().sort();
    const declared = [
      ...Object.keys(nodes).filter((name) => name !== "doc"),
      ...Object.keys(marks),
    ].sort();
    expect(mapped).toEqual(declared);
    expect(new Set(mapped).size).toBe(mapped.length);
  });

  it("the schema built from the specs exposes exactly those names", () => {
    expect(Object.keys(schema.nodes).sort()).toEqual(Object.keys(nodes).sort());
    expect(Object.keys(schema.marks).sort()).toEqual(Object.keys(marks).sort());
  });
});

describe("toDOM", () => {
  const cell = schema.node("table_cell", null, schema.text("c"));
  const row = schema.node("table_row", null, cell);
  const para = schema.node("paragraph", null, schema.text("x"));

  const cases: [string, PMNode, DOMOutputSpec][] = [
    ["paragraph", para, ["p", 0]],
    ["heading", schema.node("heading", { depth: 3 }, schema.text("h")), ["h3", 0]],
    ["blockquote", schema.node("blockquote", null, para), ["blockquote", 0]],
    [
      "code_block",
      schema.node("code_block", { lang: "ts", meta: "twoslash" }, schema.text("1")),
      ["pre", { "data-lang": "ts", "data-meta": "twoslash" }, ["code", 0]],
    ],
    [
      "code_block (no info string)",
      schema.node("code_block", null, schema.text("1")),
      ["pre", { "data-lang": "", "data-meta": "" }, ["code", 0]],
    ],
    ["thematic_break", schema.node("thematic_break"), ["hr"]],
    [
      "list (ordered, start 5)",
      schema.node("list", { ordered: true, start: 5 }, schema.node("list_item", null, para)),
      ["ol", { start: 5 }, 0],
    ],
    [
      "list (ordered, no start)",
      schema.node("list", { ordered: true }, schema.node("list_item", null, para)),
      ["ol", {}, 0],
    ],
    ["list (bullet)", schema.node("list", null, schema.node("list_item", null, para)), ["ul", 0]],
    ["list_item", schema.node("list_item", null, para), ["li", 0]],
    ["table", schema.node("table", null, row), ["table", ["tbody", 0]]],
    ["table_row", row, ["tr", 0]],
    ["table_cell", cell, ["td", 0]],
    [
      "image",
      schema.node("image", { url: "a.png", alt: "an alt", title: "a title" }),
      ["img", { src: "a.png", alt: "an alt", title: "a title" }],
    ],
    [
      "image (no alt, no title)",
      schema.node("image", { url: "a.png" }),
      ["img", { src: "a.png", alt: "" }],
    ],
    ["hard_break", schema.node("hard_break"), ["br"]],
  ];

  for (const [name, node, expected] of cases) {
    it(`renders ${name}`, () => {
      expect(domOf(node)).toEqual(expected);
    });
  }

  it("covers every node type that renders itself", () => {
    const rendered = new Set(cases.map(([name]) => name.replace(/ \(.*\)$/, "")));
    const renderable = Object.keys(nodes).filter(
      (name) => typeof nodes[name].toDOM === "function" && !name.startsWith("raw"),
    );
    // `raw` and `raw_inline` are asserted on their own below; `doc` and `text` have no toDOM.
    expect([...rendered].sort()).toEqual(renderable.sort());
    expect(nodes.doc.toDOM).toBeUndefined();
    expect(nodes.text.toDOM).toBeUndefined();
  });

  it("renders an html node as a non-editable grey box, showing its source", () => {
    const value = '<div class="note">\n  <p>x</p>\n</div>';
    for (const [type, tag] of [
      ["raw", "div"],
      ["raw_inline", "span"],
    ] as const) {
      const spec = domOf(schema.node(type, { value })) as [string, Record<string, string>, string];
      expect(spec[0]).toBe(tag);
      expect(spec[1].class).toBe(RAW_CLASS);
      expect(spec[1].contenteditable).toBe("false");
      expect(spec[1].style).toContain("background:#f1f1f0");
      expect(spec[2]).toBe(value); // the source text, not rendered HTML
      expect(schema.nodes[type].spec.atom).toBe(true);
    }
  });

  const markCases: [string, DOMOutputSpec][] = [
    ["strong", ["strong", 0]],
    ["emphasis", ["em", 0]],
    ["delete", ["del", 0]],
    ["inline_code", ["code", 0]],
  ];

  for (const [name, expected] of markCases) {
    it(`renders the ${name} mark`, () => {
      const mark = schema.marks[name].create();
      expect(mark.type.spec.toDOM!(mark, true)).toEqual(expected);
    });
  }

  it("renders the link mark with and without a title", () => {
    const withTitle = schema.marks.link.create({ url: "a.md", title: "t" });
    expect(withTitle.type.spec.toDOM!(withTitle, true)).toEqual([
      "a",
      { href: "a.md", title: "t" },
      0,
    ]);
    const bare = schema.marks.link.create({ url: "a.md" });
    expect(bare.type.spec.toDOM!(bare, true)).toEqual(["a", { href: "a.md" }, 0]);
  });

  it("covers every mark", () => {
    expect([...markCases.map(([name]) => name), "link"].sort()).toEqual(Object.keys(marks).sort());
  });
});

describe("yaml is held outside the PM doc and re-attached on serialize", () => {
  const source = "---\ntitle: 'Kept'  # comment\n---\n\nA paragraph.\n";

  it("the front matter is beside the doc, byte-identical, and not in it", () => {
    const { doc, frontMatter } = docOf(source);
    expect(frontMatter).toEqual({ type: "yaml", value: "title: 'Kept'  # comment" });
    expect(doc.textContent).toBe("A paragraph.");
    expect(childrenOf(doc).map((child) => child.type.name)).toEqual(["paragraph"]);
  });

  it("serialize puts it back as the root's first child", () => {
    const root = pmToMdast(docOf(source));
    expect(root.children[0].type).toBe("yaml");
    expect(root.children.map((child) => child.type)).toEqual(["yaml", "paragraph"]);
    expect(format(root)).toBe(source);
  });

  it("a document with no front matter carries none", () => {
    const { frontMatter } = docOf("A paragraph.\n");
    expect(frontMatter).toBeNull();
    expect(pmToMdast(docOf("A paragraph.\n")).children.map((child) => child.type)).toEqual([
      "paragraph",
    ]);
  });

  it("a front-matter-only file keeps its bytes through the placeholder paragraph", () => {
    const only = "---\n---\n";
    const { doc } = docOf(only);
    // ProseMirror's `block+` needs a block; an empty paragraph has no Markdown bytes, so it is
    // inserted here and dropped on the way back.
    expect(childrenOf(doc).map((child) => child.type.name)).toEqual(["paragraph"]);
    expect(doc.child(0).content.size).toBe(0);
    expect(roundTrip(only)).toBe(only);
  });

  it("an empty list item keeps its bytes through the same placeholder", () => {
    const { doc } = docOf("-\n");
    const item = doc.child(0).child(0);
    expect(item.type.name).toBe("list_item");
    expect(childrenOf(item).map((child) => child.type.name)).toEqual(["paragraph"]);
    expect(roundTrip("-\n")).toBe(format(parse("-\n")));
  });
});

describe("inline marks", () => {
  it("keeps a single mark at the first, middle and last position of a paragraph", () => {
    for (const source of ["*a* b c\n", "a *b* c\n", "a b *c*\n"]) {
      expect(roundTrip(source)).toBe(source);
    }
  });

  it("cuts one run per mark, so adjacent runs stay separate", () => {
    const root = pmToMdast(docOf("*a* **b** c\n"));
    const paragraph = root.children[0];
    expect(paragraph.type).toBe("paragraph");
    expect(
      (paragraph as { children: PhrasingContent[] }).children.map((child) => child.type),
    ).toEqual(["emphasis", "text", "strong", "text"]);
  });

  it("normalises the nesting of two marks over the same span to schema order", () => {
    // The documented price of the ProseMirror mark model: PM records which marks cover a
    // character, not how the source nested them, so `link` (declared first) is always outermost.
    expect(roundTrip("[**a**](b.md)\n")).toBe("[**a**](b.md)\n");
    expect(roundTrip("**[a](b.md)**\n")).toBe("[**a**](b.md)\n");
    expect(roundTrip("~~[a](b.md)~~\n")).toBe("[~~a~~](b.md)\n");
    // Emphasis and strong serialise to the same bytes in either nesting.
    expect(roundTrip("***a***\n")).toBe("***a***\n");
  });

  it("keeps inline code innermost, inside the marks that may contain it", () => {
    expect(roundTrip("**`a`**\n")).toBe("**`a`**\n");
    expect(roundTrip("[`a`](b.md)\n")).toBe("[`a`](b.md)\n");
  });

  it("carries marks on leaf inline nodes", () => {
    expect(roundTrip("**a\\\nb**\n")).toBe("**a\\\nb**\n");
    expect(roundTrip("*![alt](a.png)*\n")).toBe("*![alt](a.png)*\n");
  });

  it("drops inline nodes that have no text, which ProseMirror cannot hold", () => {
    const root: Root = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "" },
            { type: "text", value: "kept" },
            { type: "inlineCode", value: "" },
          ],
        },
      ],
    };
    expect(mdastToPM(root).doc.textContent).toBe("kept");
    expect(format(pmToMdast(mdastToPM(root)))).toBe("kept\n");
  });
});

describe("inline html becomes an inline raw node", () => {
  const source = 'A <span class="x">y</span> B.\n';

  it("round-trips byte-identically and holds the html bytes in the node", () => {
    const { doc } = docOf(source);
    const inline = childrenOf(doc.child(0));
    expect(inline.map((child) => child.type.name)).toEqual([
      "text",
      "raw_inline",
      "text",
      "raw_inline",
      "text",
    ]);
    expect(inline[1].attrs.value).toBe('<span class="x">');
    expect(inline[3].attrs.value).toBe("</span>");
    expect(roundTrip(source)).toBe(source);
  });
});

describe("mdast fields the parser always sets but the type makes optional", () => {
  it("fall back to the mdast defaults", () => {
    const root: Root = {
      type: "root",
      children: [
        { type: "code", value: "" },
        {
          type: "list",
          children: [
            {
              type: "listItem",
              children: [{ type: "paragraph", children: [{ type: "text", value: "a" }] }],
            },
          ],
        },
        {
          type: "paragraph",
          children: [
            { type: "link", url: "b.md", children: [{ type: "text", value: "l" }] },
            { type: "image", url: "c.png" },
          ],
        },
        {
          type: "table",
          children: [{ type: "tableRow", children: [{ type: "tableCell", children: [] }] }],
        },
      ],
    };
    const { doc } = mdastToPM(root);
    const [code, list, , table] = childrenOf(doc);
    expect(code.textContent).toBe("");
    expect([code.attrs.lang, code.attrs.meta]).toEqual([null, null]);
    expect([list.attrs.ordered, list.attrs.start, list.attrs.spread]).toEqual([false, null, false]);
    expect(list.child(0).attrs.spread).toBe(false);
    expect(table.attrs.align).toBeNull();
    expect(format(pmToMdast({ doc, frontMatter: null }))).toBe(
      "```\n```\n\n- a\n\n[l](b.md)![](c.png)\n\n|   |\n| - |\n",
    );
  });
});

describe("a node the model does not admit is refused, not silently mangled", () => {
  const foreign = new Schema({
    nodes: {
      doc: { content: "block+" },
      widget: { group: "block" },
      thing: { group: "inline", inline: true },
      text: { group: "inline" },
    },
  });

  it("an unsupported mdast block", () => {
    const root = { type: "root", children: [{ type: "definition" }] } as unknown as Root;
    expect(() => mdastToPM(root)).toThrow(/unsupported mdast node type "definition"/);
  });

  it("an unsupported mdast inline", () => {
    const root = {
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "footnoteReference", identifier: "1" }] }],
    } as unknown as Root;
    expect(() => mdastToPM(root)).toThrow(/unsupported mdast node type "footnoteReference"/);
  });

  it("a block node from another schema", () => {
    const doc = foreign.node("doc", null, foreign.node("widget"));
    expect(() => pmToMdast({ doc, frontMatter: null })).toThrow(
      /unsupported mdast node type "widget"/,
    );
  });

  it("an inline node from another schema", () => {
    const paragraph = schema.nodes.paragraph.create(null, foreign.node("thing"));
    const doc = schema.nodes.doc.create(null, paragraph);
    expect(() => pmToMdast({ doc, frontMatter: null })).toThrow(
      /unsupported mdast node type "thing"/,
    );
  });

  it("names the admitted set in the message", () => {
    const root = { type: "root", children: [{ type: "definition" }] } as unknown as Root;
    expect(() => mdastToPM(root)).toThrow(/paragraph/);
  });
});

describe("block attributes survive the trip", () => {
  it("carries the mdast fields the formatter reads", () => {
    const source =
      "1. one\n2. two\n\n" +
      "```ts meta\ncode\n```\n\n" +
      "| a  |  b |\n| :- | -: |\n| c  |  d |\n";
    const { doc } = docOf(source);
    const [list, code, table] = childrenOf(doc);
    expect(list.attrs).toEqual({ ordered: true, start: 1, spread: false });
    expect(code.attrs).toEqual({ lang: "ts", meta: "meta" });
    expect(table.attrs).toEqual({ align: ["left", "right"] });
    expect(roundTrip(source)).toBe(source);
  });

  it("keeps a heading's depth", () => {
    const { doc } = docOf("### three\n");
    expect(doc.child(0).attrs.depth).toBe(3);
  });

  it("keeps an ordered list's start number", () => {
    const { doc } = docOf("5. five\n6. six\n");
    expect(doc.child(0).attrs.start).toBe(5);
  });

  it("keeps list and item spread, so loose lists stay loose", () => {
    const source = "- one\n\n- two\n";
    const { doc } = docOf(source);
    expect(doc.child(0).attrs.spread).toBe(true);
    expect(roundTrip(source)).toBe(source);
  });
});
