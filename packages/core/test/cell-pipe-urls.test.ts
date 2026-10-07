import type { Link, Nodes, PhrasingContent, Root } from "mdast";
import { describe, expect, it } from "vitest";
import { format } from "../src/format.js";
import { parse, unescapeCellPipes } from "../src/parse.js";
import { formatWithMap } from "../src/positions.js";

/**
 * A `\|` in a table cell's link url (task 4.6, DECISIONS #059, #review-3-r2). GFM §4.10 replaces
 * a cell's pipe escape with `|` before inline parsing; micromark keeps the cell's bytes and lets
 * each inline construct decode them, so the two constructs that read their bytes raw — a `<…>`
 * autolink and a GFM autolink literal the tokenizer made — kept the backslash in the url (the
 * editor showed `x\|y` where every other reader shows `x|y`), and the loaded `<…>` member was
 * written `[https://a.b/x\\\|y](https://a.b/x\\\|y)`, which pandoc and GitHub read as another url.
 */

/** The probe `| a | b |\n| - | - |\n| c <cell> | d |\n`, unpadded, as another editor writes it. */
const probe = (cell: string): string => `| a | b |\n| - | - |\n| c ${cell} | d |\n`;

/** The body row's first cell's bytes in a formatted probe, without its padding. */
function firstBodyCell(bytes: string): string {
  return bytes.split("\n")[2].split(" | ")[0].slice(2).trimEnd();
}

/** `node` without `position`, recursively: the tree `parse` makes, as the app compares it. */
function shape(node: Nodes): unknown {
  return JSON.parse(JSON.stringify(node, (key, value: unknown) => (key === "position" ? undefined : value)));
}

/** Every table row of a parsed tree, as its cell count. */
function rowWidths(root: Root): number[] {
  const out: number[] = [];
  const walk = (node: Nodes): void => {
    if (node.type === "tableRow") out.push(node.children.length);
    if ("children" in node) for (const child of node.children as Nodes[]) walk(child);
  };
  walk(root);
  return out;
}

/** Every link of a tree, as url, text and whether `parse` marked it a literal. */
function linksOf(root: Root): [string, string, boolean][] {
  const out: [string, string, boolean][] = [];
  const textOf = (node: Nodes): string =>
    node.type === "text" ? node.value : "children" in node ? (node.children as Nodes[]).map(textOf).join("") : "";
  const walk = (node: Nodes): void => {
    if (node.type === "link") out.push([node.url, textOf(node), node.data?.autolinkLiteral === true]);
    if ("children" in node) for (const child of node.children as Nodes[]) walk(child);
  };
  walk(root);
  return out;
}

/** The path `formatWithMap` keys a node by, for the first `text` node whose value is `value`. */
function textPath(root: Root, value: string): string | undefined {
  const walk = (node: Nodes, path: string): string | undefined => {
    if (node.type === "text" && node.value === value) return path;
    if (!("children" in node)) return undefined;
    for (const [index, child] of (node.children as Nodes[]).entries()) {
      const found = walk(child, path === "" ? String(index) : `${path}.${index}`);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(root, "");
}

/** The acceptance's four loaded members: each cell's bytes, and the url the app's tree holds. */
const LOADED: [string, string, string][] = [
  ["the `<…>` member", "<https://a.b/x\\|y>", "https://a.b/x|y"],
  ["the literal member", "https://a.b/x\\|y", "https://a.b/x|y"],
  ["the `<…>` astral twin", "<https://a.b/x\\|𝒜>", "https://a.b/x|𝒜"],
  ["the literal astral twin", "https://a.b/x\\|𝒜", "https://a.b/x|𝒜"],
];

describe("a loaded `\\|` in a table cell's link url, three saves by the core route (task 4.6 acceptance)", () => {
  for (const [title, cell, url] of LOADED) {
    it(`${title} \`${cell}\`: two cells, the input's tree and its cell bytes on every save, url \`${url}\``, () => {
      const input = probe(cell);
      const tree = parse(input);
      expect(linksOf(tree).map(([linkUrl]) => linkUrl), "the url in the app's tree").toEqual([url]);
      let bytes = input;
      for (let k = 1; k <= 3; k += 1) {
        bytes = format(parse(bytes));
        const reparsed = parse(bytes);
        expect(rowWidths(reparsed), `save ${k}: two cells in every row`).toEqual([2, 2]);
        expect(shape(reparsed), `save ${k}: the tree equals the input's`).toEqual(shape(tree));
        expect(firstBodyCell(bytes), `save ${k}: the cell's bytes are the input's`).toBe(`c ${cell}`);
      }
      const mapped = formatWithMap(tree);
      expect(mapped.text).toBe(format(tree));
      expect(mapped.map.unresolved, "nothing unresolved").toEqual([]);
    });
  }
});

describe("parse reads a cell's `\\|` in a raw link as `|` (task 4.6 guards: unescapeCellLinkPipes, unescapeCellPipes)", () => {
  it("presence: a `<…>` autolink in a cell has its url and its text child unescaped", () => {
    expect(linksOf(parse(probe("<https://a.b/x\\|y>")))).toEqual([["https://a.b/x|y", "https://a.b/x|y", false]]);
  });

  it("presence: a GFM autolink literal the tokenizer made in a cell has its url and its text child unescaped", () => {
    expect(linksOf(parse(probe("https://a.b/x\\|y")))).toEqual([["https://a.b/x|y", "https://a.b/x|y", true]]);
  });

  it("presence: the walk reaches a link nested inside emphasis in a cell, in the header row as well", () => {
    const root = parse("| *<https://a.b/x\\|y>* | b |\n| - | - |\n| *https://a.b/x\\|y* | d |\n");
    expect(linksOf(root)).toEqual([
      ["https://a.b/x|y", "https://a.b/x|y", false],
      ["https://a.b/x|y", "https://a.b/x|y", true],
    ]);
  });

  it("absence: outside a table cell both raw forms keep the backslash, as micromark and GFM read them there", () => {
    expect(linksOf(parse("<https://a.b/x\\|y> and https://a.b/x\\|y\n"))).toEqual([
      ["https://a.b/x\\|y", "https://a.b/x\\|y", false],
      ["https://a.b/x\\|y", "https://a.b/x\\|y", true],
    ]);
  });

  it("absence: a resource link in a cell (starts at `[`) keeps micromark's decoding — `\\\\\\|` is `\\|`, as GFM reads it", () => {
    expect(linksOf(parse(probe("[t](https://a.b/x\\\\\\|y)")))).toEqual([["https://a.b/x\\|y", "t", false]]);
  });

  it("absence: a literal the transform made in a cell (no position, decoded text) is not unescaped a second time", () => {
    expect(linksOf(parse(probe("https\\://a.b/x\\\\\\|y")))).toEqual([
      ["https://a.b/x\\|y", "https://a.b/x\\|y", true],
    ]);
  });

  it("unescapeCellPipes pairs backslashes left to right, as exitCodeText does: `\\\\` is kept and never lends its second `\\`", () => {
    expect(unescapeCellPipes("x\\|y")).toBe("x|y");
    expect(unescapeCellPipes("x\\\\\\|y")).toBe("x\\\\|y");
    expect(unescapeCellPipes("x\\\\y")).toBe("x\\\\y");
    expect(unescapeCellPipes("x\\y|z")).toBe("x\\y|z");
  });
});

const text = (value: string): PhrasingContent => ({ type: "text", value });
const link = (url: string, literal: boolean, title: string | null = null): Link => ({
  type: "link",
  url,
  title,
  ...(literal ? { data: { autolinkLiteral: true } } : {}),
  children: [{ type: "text", value: url }],
});

/** A one-column table: a header cell `h` and one body cell holding `children`. */
function inCell(...children: PhrasingContent[]): Root {
  return {
    type: "root",
    children: [
      {
        type: "table",
        align: [null],
        children: [
          { type: "tableRow", children: [{ type: "tableCell", children: [text("h")] }] },
          { type: "tableRow", children: [{ type: "tableCell", children }] },
        ],
      },
    ],
  };
}

/** The body cell's line of a one-column table's bytes, without its padding. */
function bodyCell(bytes: string): string {
  return bytes.split("\n")[2].slice(2, -2).trimEnd();
}

describe("the serializer writes a cell link's `|` as `\\|` and nothing else (task 4.6 guards: cellLiteralSpans, asCellAutolink)", () => {
  it("cellLiteralSpans presence: a literal text span with `|` in a cell is written raw with its `|` as `\\|`", () => {
    const out = format(inCell(text("see https://a.b/x|y_z end")));
    expect(bodyCell(out)).toBe("see https://a.b/x\\|y_z end");
    expect(linksOf(parse(out))).toEqual([["https://a.b/x|y_z", "https://a.b/x|y_z", true]]);
  });

  it("cellLiteralSpans drop (CELL_CUT): a span already holding `\\|` would cut once escaped, so it is written through `safe`", () => {
    const out = format(inCell(text("https://a.b/x\\|y")));
    expect(bodyCell(out)).toBe("https\\://a.b/x\\\\\\|y");
    expect(rowWidths(parse(out))).toEqual([1, 1]);
    expect(linksOf(parse(out))).toEqual([["https://a.b/x\\|y", "https://a.b/x\\|y", true]]);
  });

  it("asCellAutolink presence: a non-literal link whose text is its url keeps `<…>` in a cell with `\\|`", () => {
    const out = format(inCell(link("https://a.b/x|y", false)));
    expect(bodyCell(out)).toBe("<https://a.b/x\\|y>");
    expect(linksOf(parse(out))).toEqual([["https://a.b/x|y", "https://a.b/x|y", false]]);
  });

  it("asCellAutolink refusal: a url holding `\\|` is not carried by the cell's `<…>` form, so the resource form is written", () => {
    const out = format(inCell(link("https://a.b/x\\|y", false)));
    expect(bodyCell(out)).toBe("[https://a.b/x\\\\\\|y](https://a.b/x\\\\\\|y)");
    expect(rowWidths(parse(out))).toEqual([1, 1]);
    expect(linksOf(parse(out))).toEqual([["https://a.b/x\\|y", "https://a.b/x\\|y", false]]);
  });

  it("asCellAutolink absence: a link the built-in writes in the resource form (a title) is not tried as `<…>`", () => {
    const out = format(inCell(link("https://a.b/x|y", false, "t")));
    expect(bodyCell(out)).toBe('[https://a.b/x\\|y](https://a.b/x\\|y "t")');
    expect(linksOf(parse(out))).toEqual([["https://a.b/x|y", "https://a.b/x|y", false]]);
  });

  it("asCellAutolink absence: outside a cell the `<…>` form keeps its raw `|`, and the text handler writes no `\\|`", () => {
    const root: Root = { type: "root", children: [{ type: "paragraph", children: [link("https://a.b/x|y", false)] }] };
    expect(format(root)).toBe("<https://a.b/x|y>\n");
  });
});

describe("the position map spells a cell link's `\\|` (task 4.6 guards: spellingOffsets `pipesEscaped`, the `<…>` text's escape; CLAUDE.md K2)", () => {
  const cases: [string, Root, string][] = [
    ["a literal text span written raw with `\\|` (pipesEscaped)", inCell(text("https://a.b/x|𝒜")), "https://a.b/x|𝒜"],
    ["a literal link written bare with `\\|` (pipesEscaped)", inCell(link("https://a.b/x|y", true)), "https://a.b/x|y"],
    ["the text of a cell's `<…>` form with `\\|` (the escape rule)", inCell(link("https://a.b/x|y", false)), "https://a.b/x|y"],
  ];
  for (const [title, root, value] of cases) {
    it(`${title}: the \`|\` is spelled by \`\\|\`, every other unit by itself, nothing unresolved`, () => {
      const { text: out, spellings, map } = formatWithMap(root);
      expect(out).toBe(format(root));
      expect(map.unresolved).toEqual([]);
      const path = textPath(root, value);
      expect(path).toBeDefined();
      const table = spellings[path as string];
      expect(table, "the text node has a spelling table").toBeDefined();
      for (let i = 0; i < value.length; i += 1) {
        expect(out.slice(table.starts[i], table.ends[i]), `unit ${i}`).toBe(value[i] === "|" ? "\\|" : value[i]);
      }
    });
  }
});
