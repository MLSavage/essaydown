import type { Link, Nodes, PhrasingContent, Root } from "mdast";
import { describe, expect, it } from "vitest";
import { createFormatter, format } from "../src/format.js";
import { parse } from "../src/parse.js";
import { formatWithMap } from "../src/positions.js";

/**
 * URL-shaped text keeps the writer's bytes (task 3.14, DECISIONS #review-1-r6 L9). The
 * reproduction: typed in the rendered view, the sentence reached the serializer as one `text`
 * node and came out as `See https\://example.com/a\_b for details.`, and the same sentence loaded
 * from disk came out as `See <https://example.com/a_b> for details.`.
 */

const SENTENCE = "See https://example.com/a_b for details.\n";

function typed(value: string): Root {
  return { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value }] }] };
}

describe("URL-shaped text keeps the writer's bytes (task 3.14 reproduction)", () => {
  it("typed: a text node holding the sentence formats to the sentence, a fixed point of parse∘format", () => {
    const out = format(typed(SENTENCE.slice(0, -1)));
    expect(out).toBe(SENTENCE);
    expect(format(parse(out))).toBe(out);
  });

  it("loaded: the sentence saves byte-identical", () => {
    expect(format(parse(SENTENCE))).toBe(SENTENCE);
  });
});

const text = (value: string): PhrasingContent => ({ type: "text", value });
const literal = (url: string, value = url): Link => ({
  type: "link",
  url,
  title: null,
  data: { autolinkLiteral: true },
  children: [{ type: "text", value }],
});
const paragraph = (...children: PhrasingContent[]): Root => ({
  type: "root",
  children: [{ type: "paragraph", children }],
});

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

/** Bytes, the fixed point of parse∘format, and an empty `unresolved` from the position map. */
function assertSettled(root: Root, bytes: string): void {
  const out = format(root);
  expect(out).toBe(bytes);
  expect(format(parse(out)), "fixed point").toBe(out);
  const mapped = formatWithMap(root);
  expect(mapped.text, "formatWithMap writes format's bytes").toBe(out);
  expect(mapped.map.unresolved, "nothing unresolved").toEqual([]);
}

describe("parse marks the GFM autolink literal, and only it (task 3.14 guard: markAutolinkLiterals)", () => {
  it("a literal the tokenizer made (it has a position, and its first byte is the url's) is marked", () => {
    expect(linksOf(parse("See https://example.com/a_b for details.\n"))).toEqual([
      ["https://example.com/a_b", "https://example.com/a_b", true],
    ]);
  });

  it("a literal the transform made (escaped scheme: findAndReplace builds it with no position) is marked", () => {
    const root = parse("https\\://x.y/a*b*\n");
    expect(linksOf(root)).toEqual([["https://x.y/a", "https://x.y/a", true]]);
  });

  it("www and e-mail literals are marked", () => {
    expect(linksOf(parse("www.x.com/a_b and a@b.com\n"))).toEqual([
      ["http://www.x.com/a_b", "www.x.com/a_b", true],
      ["mailto:a@b.com", "a@b.com", true],
    ]);
  });

  it("the absence cases: an `<…>` autolink, a resource link whose text is its url, and a reference link are not marked", () => {
    expect(linksOf(parse("<https://a.b> [https://a.b](https://a.b) [t][r]\n\n[r]: https://a.b\n"))).toEqual([
      ["https://a.b", "https://a.b", false],
      ["https://a.b", "https://a.b", false],
    ]);
  });
});

describe("the text handler writes the parser's literals raw (task 3.14 guards: handleText, writesLiteralsRaw)", () => {
  it("the literal is raw and the plain stretches either side are escaped as before, with their real neighbours", () => {
    assertSettled(paragraph(text("a_b https://x.y/c_d e_f")), "a\\_b https://x.y/c_d e\\_f\n");
  });

  it("www and e-mail literals inside text are raw", () => {
    assertSettled(paragraph(text("see www.x.com/a_b and a@b.com.")), "see www.x.com/a_b and a@b.com.\n");
  });

  it("the trailing punctuation the literal leaves out is plain text: `https://example.com/a_b.`", () => {
    assertSettled(paragraph(text("https://example.com/a_b.")), "https://example.com/a_b.\n");
  });

  it("inside emphasis: `*https://example.com/a_b*`", () => {
    assertSettled(
      paragraph({ type: "emphasis", children: [text("https://example.com/a_b")] }),
      "*https://example.com/a_b*\n",
    );
  });

  it("in a heading and in a table cell", () => {
    assertSettled(
      { type: "root", children: [{ type: "heading", depth: 2, children: [text("https://a.b/c_d")] }] },
      "## https://a.b/c_d\n",
    );
    const cell = (value: string) => ({ type: "tableCell" as const, children: [text(value)] });
    assertSettled(
      {
        type: "root",
        children: [
          {
            type: "table",
            align: [null],
            children: [
              { type: "tableRow", children: [cell("h")] },
              { type: "tableRow", children: [cell("https://a.b/c_d")] },
            ],
          },
        ],
      },
      "| h               |\n| --------------- |\n| https://a.b/c_d |\n",
    );
  });

  it("the absence case: text inside a link's label is escaped as before, because the parser makes no literal there", () => {
    assertSettled(
      paragraph({ type: "link", url: "u", title: null, children: [text("https://a.b/c_d")] }),
      "[https://a.b/c\\_d](u)\n",
    );
  });

  it("the absence case: a letter before the scheme is no literal, so the text is escaped as before", () => {
    assertSettled(paragraph(text("xhttps://a.b/c_d")), "xhttps\\://a.b/c\\_d\n");
  });

  it("two backslashes inside a literal are written as themselves and each spelled by itself (positions.ts `raw`)", () => {
    const value = "see https://x.y/a\\\\b end";
    assertSettled(paragraph(text(value)), `${value}\n`);
    const { text: out, spellings } = formatWithMap(paragraph(text(value)));
    const table = spellings["0.0"];
    expect(table).toBeDefined();
    for (let i = 0; i < value.length; i++) {
      expect(out.slice(table.starts[i], table.ends[i]), `character ${i}`).toBe(value[i]);
    }
  });
});

describe("a marked literal link is written bare exactly when its text is its literal (task 3.14 guards: writesBare, the link wrapper)", () => {
  it("presence: a marked literal link is bare", () => {
    assertSettled(paragraph(text("See "), literal("https://a.b/c_d"), text(" end")), "See https://a.b/c_d end\n");
  });

  it("absence: the same link unmarked keeps `<…>`", () => {
    const unmarked = { ...literal("https://a.b/c_d"), data: undefined };
    assertSettled(paragraph(text("See "), unmarked, text(" end")), "See <https://a.b/c_d> end\n");
  });

  it("absence: a title is not bare", () => {
    assertSettled(paragraph({ ...literal("https://a.b"), title: "t" }), '[https://a.b](https://a.b "t")\n');
  });

  it("absence: text an edit changed (`https://a.bx` under a link to `https://a.b`) takes the resource form", () => {
    assertSettled(paragraph(literal("https://a.b", "https://a.bx")), "[https://a.bx](https://a.b)\n");
  });

  it("absence: more than one child is not bare", () => {
    const link: Link = { ...literal("https://a.b"), children: [text("https://a."), { type: "emphasis", children: [text("b")] }] };
    assertSettled(paragraph(link), "[https://a.*b*](https://a.b)\n");
  });

  it("peek answers the literal's first character, so the text before it is escaped against `h`, not `<`", () => {
    // `safe` doubles a backslash only before punctuation (`safe.js:147`): before `<` it would.
    assertSettled(paragraph(text("see \\"), literal("https://a.b")), "see \\https://a.b\n");
  });
});

describe("settleLiterals escapes only the literal the parser would misread (task 3.14 guards: literalMisread, settleLiterals)", () => {
  it("a letter flush after a literal link: that link takes `<…>`, and the other literal of the paragraph stays bare", () => {
    assertSettled(
      paragraph(literal("https://a.b"), text("X and "), literal("https://c.d")),
      "<https://a.b>X and https://c.d\n",
    );
  });

  it("a letter flush before a literal link: that link takes `<…>`", () => {
    assertSettled(paragraph(text("ee X"), literal("https://a.b"), text(" end")), "ee X<https://a.b> end\n");
  });

  it("a text literal flush against emphasis: the text is escaped, and the parse keeps the emphasis", () => {
    const root = paragraph(text("https://x.y/a"), { type: "emphasis", children: [text("b")] });
    const out = format(root);
    expect(out).toBe("https\\://x.y/a*b*\n");
    expect(format(parse(out))).toBe("<https://x.y/a>*b*\n");
  });

  it("a misread no escape of a raw node can fix (a link inside a link) falls back to every literal escaped", () => {
    const inner: Link = { type: "link", url: "v", title: null, children: [text("x")] };
    const root = paragraph(text("https://a.b "), { type: "link", url: "u", title: null, children: [inner] });
    expect(format(root)).toBe(createFormatter("all").stringify(root));
    expect(format(root)).toContain("https\\://a.b");
  });

  it("the no-op: a tree with no literal is serialised once, as before", () => {
    expect(format(paragraph(text("a_b")))).toBe("a\\_b\n");
  });
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

describe("a link holding `|` inside a table cell keeps its cell (task 3.27, DECISIONS #review-3-r1 C14)", () => {
  // Task 4.6 moved these bytes: the literal is written bare with its `|` as `\\|` (it was its text
  // escaped through `safe`, `https\\://a.b/x\\|y`), the bytes GitHub and Typora write.
  it("guard 3: a hand-built literal link with `|` in its url is written bare with its `|` as `\\|` (task 4.6), the bytes save 1 writes", () => {
    const root = inCell(literal("https://a.b/x|y"));
    const out = format(root);
    expect(bodyCell(out)).toBe("https://a.b/x\\|y");
    expect(rowWidths(parse(out))).toEqual([1, 1]);
    expect(linksOf(parse(out))).toEqual([["https://a.b/x|y", "https://a.b/x|y", true]]);
    assertSettled(root, out);
    // The bytes of the typed text (a `text` node, not a link) are the same bytes.
    expect(format(inCell(text("https://a.b/x|y")))).toBe(out);
    // The www member: its url is not its text, and the escaped text is still the same literal.
    const www = format(inCell(literal("http://www.a.b/x|y", "www.a.b/x|y")));
    expect(bodyCell(www)).toBe("www.a.b/x\\|y");
    expect(linksOf(parse(www))).toEqual([["http://www.a.b/x|y", "www.a.b/x|y", true]]);
    assertSettled(inCell(literal("http://www.a.b/x|y", "www.a.b/x|y")), www);
  });

  // Task 4.6 moved these bytes: the `<…>` form is kept with its `|` as `\\|` (it was the resource
  // form `[https://a.b/x\\|y](https://a.b/x\\|y)`), which `parse` reads back with the same url.
  it("guard 4: a hand-built link that is not a literal, its text its url with `|`, keeps the `<…>` form with `\\|` in a cell (task 4.6), saved twice", () => {
    const root = inCell({ ...literal("https://a.b/x|y"), data: undefined });
    const first = format(root);
    expect(bodyCell(first)).toBe("<https://a.b/x\\|y>");
    expect(rowWidths(parse(first))).toEqual([1, 1]);
    expect(linksOf(parse(first))).toEqual([["https://a.b/x|y", "https://a.b/x|y", false]]);
    assertSettled(root, first);
    const second = format(parse(first));
    expect(second, "save 2").toBe(first);
    expect(format(parse(second)), "save 3").toBe(first);
  });

  // Task 4.6: the member above now keeps `<…>`, so peek answers `<` for it; the resource form's `[`
  // is held by a url whose `\\|` no `<…>` form carries.
  it("guard 4: peek answers `<` for the cell's `<…>` form, so the text before the link is escaped against it", () => {
    const root = inCell(text("see \\"), { ...literal("https://a.b/x|y"), data: undefined });
    assertSettled(root, format(root));
    expect(bodyCell(format(root))).toBe("see \\\\<https://a.b/x\\|y>");
  });

  it("guard 4: peek answers `[` for the resource form, so the text before the link is escaped against it", () => {
    const root = inCell(text("see \\"), { ...literal("https://a.b/x\\|y"), data: undefined });
    assertSettled(root, format(root));
    expect(bodyCell(format(root))).toBe("see \\\\[https://a.b/x\\\\\\|y](https://a.b/x\\\\\\|y)");
  });

  it("guard 5 (absence): a literal in a cell without `|` stays bare", () => {
    assertSettled(inCell(literal("https://a.b/c_d")), "| h               |\n| --------------- |\n| https://a.b/c_d |\n");
    assertSettled(inCell(text("https://a.b/c_d")), "| h               |\n| --------------- |\n| https://a.b/c_d |\n");
  });

  it("guard 5 (absence): a `|` literal outside a cell keeps `<…>`, and `|` text outside a cell stays raw", () => {
    const unmarked = { ...literal("https://a.b/x|y"), data: undefined };
    assertSettled(paragraph(text("See "), unmarked, text(" end")), "See <https://a.b/x|y> end\n");
    assertSettled(paragraph(text("See "), literal("https://a.b/x|y"), text(" end")), "See https://a.b/x|y end\n");
    assertSettled(paragraph(text("See https://a.b/x|y end")), "See https://a.b/x|y end\n");
  });
});

/**
 * A loaded `|` the table tokenizer does not cut at keeps its bytes (task 3.28, DECISIONS
 * #review-3-r2 C15). Inside a row the tokenizer (`micromark-extension-gfm-table/lib/syntax.js`
 * `bodyRowData` → `bodyRowEscape`, head twins alike) consumes a `\` and the one `\` or `|` after
 * it as cell data, so `x\|y` (how GitHub and Typora write that url in a cell) is one cell, and
 * `x\\|y` cuts. 3.27's `cutsCell` answered true for any `|`, so the loaded cell was written
 * `https\://a.b/x\\\|y`, which every other GFM reader shows as plain text.
 */
describe("a loaded url holding an escaped `\\|` in a table cell keeps its bytes (task 3.28, DECISIONS #review-3-r2 C15)", () => {
  /** The probe `| a | b |\n| - | - |\n| c <cell> | d |\n` in the formatter's own table padding. */
  const probe = (cell: string): string => {
    const width = "c ".length + cell.length;
    return `| a${" ".repeat(width - 1)} | b |\n| ${"-".repeat(width)} | - |\n| c ${cell} | d |\n`;
  };
  const nodeCount = (node: Nodes): number =>
    1 + ("children" in node ? (node.children as Nodes[]).reduce((n, child) => n + nodeCount(child), 0) : 0);

  const LOADED: [string, string][] = [
    ["guard 1: the loaded literal `https://a.b/x\\|y`", "https://a.b/x\\|y"],
    ["guard 2: the astral member `https://a.b/x\\|𝒜`", "https://a.b/x\\|𝒜"],
  ];
  for (const [title, cell] of LOADED) {
    it(`${title}, saved three times by the core route: byte-identical to the input, two cells, node count kept`, () => {
      const input = probe(cell);
      // The unpadded probe's cell is written as it stands; only the column padding is the formatter's.
      const unpadded = `| a | b |\n| - | - |\n| c ${cell} | d |\n`;
      expect(format(parse(unpadded))).toBe(input);
      let bytes = input;
      for (let k = 1; k <= 3; k += 1) {
        const tree = parse(bytes);
        bytes = format(tree);
        expect(bytes, `save ${k} is byte-identical to the input`).toBe(input);
        expect(rowWidths(parse(bytes)), `save ${k}: two cells in every row`).toEqual([2, 2]);
        expect(nodeCount(parse(bytes)), `save ${k}: node count after parse(format(·))`).toBe(nodeCount(tree));
        // Task 4.6: `parse` reads the cell's `\\|` as `|`, as GFM §4.10 does (it kept the backslash).
        const url = cell.replace("\\|", "|");
        expect(linksOf(parse(bytes)), `save ${k}: the literal kept`).toEqual([[url, url, true]]);
      }
      const mapped = formatWithMap(parse(input));
      expect(mapped.text).toBe(input);
      expect(mapped.map.unresolved, "nothing unresolved").toEqual([]);
    });
  }

  // Task 4.6 moved these bytes: the literal is written bare, its `|` as `\\|` after the even run (it
  // was escaped through `safe`, `https\\://a.b/x\\\\\\|y`).
  it("guard 3 (absence): a hand-built literal whose url holds `x\\\\|y` (an even run, so the `|` cuts) is written bare with that `|` as `\\|` (task 4.6)", () => {
    const url = "https://a.b/x\\\\|y";
    const root = inCell(literal(url));
    const out = format(root);
    expect(bodyCell(out)).toBe("https://a.b/x\\\\\\|y");
    expect(rowWidths(parse(out))).toEqual([1, 1]);
    expect(linksOf(parse(out))).toEqual([[url, url, true]]);
    assertSettled(root, out);
  });

  it("guard 4 (presence of both): a hand-built literal whose url holds `x\\|y|z` (one escaped, one raw `|`) is written escaped", () => {
    const url = "https://a.b/x\\|y|z";
    const root = inCell(literal(url));
    const out = format(root);
    expect(bodyCell(out)).toBe("https\\://a.b/x\\\\\\|y\\|z");
    expect(rowWidths(parse(out))).toEqual([1, 1]);
    expect(linksOf(parse(out))).toEqual([[url, url, true]]);
    assertSettled(root, out);
  });

  // Task 4.6 moved these bytes: 3.27's `https\\://a.b/x\\|y` became the loaded form `https://a.b/x\\|y`.
  it("guard 5: 3.27's typed member is written as the loaded member's bytes `https://a.b/x\\|y` (task 4.6)", () => {
    const out = format(inCell(text("https://a.b/x|y")));
    expect(bodyCell(out)).toBe("https://a.b/x\\|y");
    expect(format(inCell(literal("https://a.b/x|y")))).toBe(out);
    expect(rowWidths(parse(out))).toEqual([1, 1]);
    assertSettled(inCell(text("https://a.b/x|y")), out);
  });
});
