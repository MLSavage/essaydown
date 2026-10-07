import type { Link, Nodes, PhrasingContent, Root, Table } from "mdast";
import { describe, expect, it } from "vitest";
import { createFormatter, format, rawTrail, settleLiterals } from "../src/format.js";
import { parse } from "../src/parse.js";
import { formatWithMap } from "../src/positions.js";

/**
 * A loaded URL literal ending in `_`, `*` or `~` keeps the writer's bytes (task 4.7, DECISIONS
 * #059, #review-3-r0 C2): `https://a.b/x_` is the literal `https://a.b/x` and the text `_`, and was
 * written `<https://a.b/x>\_` — `safe`'s `\_` put a `\` the literal took into its url, so the
 * settle loop escaped the link. C13: `settleLiterals`' give-up is reported in `map.unresolved`.
 * The editor route's twin is `packages/editor/test/url-trail.test.ts`.
 */

/** `node` without `position`, recursively: the tree `parse` makes, as the app compares it. */
function shape(node: Nodes): unknown {
  return JSON.parse(JSON.stringify(node, (key, value: unknown) => (key === "position" ? undefined : value)));
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

function rowWidths(root: Root): number[] {
  const out: number[] = [];
  const walk = (node: Nodes): void => {
    if (node.type === "tableRow") out.push(node.children.length);
    if ("children" in node) for (const child of node.children as Nodes[]) walk(child);
  };
  walk(root);
  return out;
}

/** The trailing characters, and the two urls they end: an ASCII letter and its astral twin. */
const TRAILS = ["_", "*", "~"];
const URLS = ["https://a.b/x", "https://a.b/𝒜"];
/** What follows the trailing character: the neighbour classes CLAUDE.md names (J1, K1). */
const AFTER: [string, string][] = [
  ["the block's end", ""],
  ["whitespace", " y"],
  ["punctuation", "."],
  ["an astral symbol", "😀"],
  ["an astral letter", "𝒜"],
];

interface Member {
  title: string;
  /** The loaded file's bytes. */
  input: string;
  /** The bytes the case compares: the whole save in a paragraph, the body cell in a table. */
  bytesOf: (save: string) => string;
  cell: boolean;
}

/** The body row's first cell's bytes in a formatted probe, without its padding. */
function firstBodyCell(bytes: string): string {
  return bytes.split("\n")[2].split(" | ")[0].slice(2).trimEnd();
}

/** The table probe as another editor writes it, unpadded. */
const cellProbe = (cell: string): string => `| a | b |\n| - | - |\n| c ${cell} | d |\n`;

/**
 * Bytes with the formatter's column padding taken out: runs of spaces and of delimiter-row dashes
 * collapsed (lesson [3.7.r3d]: a table save is compared with the input this way, and its cell's
 * bytes on their own).
 */
function unpadded(bytes: string): string {
  return bytes.replace(/ +/g, " ").replace(/-+/g, "-");
}

/** Every member the acceptance names: trail × url × neighbour, in a paragraph and in a cell. */
function members(): Member[] {
  const out: Member[] = [];
  for (const trail of TRAILS) {
    for (const url of URLS) {
      for (const [neighbour, after] of AFTER) {
        const bytes = `${url}${trail}${after}`;
        out.push({
          title: `paragraph, \`${bytes}\` (${neighbour} after \`${trail}\`)`,
          input: `see ${bytes}\n`,
          bytesOf: (save) => save,
          cell: false,
        });
        out.push({
          title: `table cell, \`${bytes}\` (${neighbour} after \`${trail}\`; the formatter pads the column)`,
          input: cellProbe(bytes),
          bytesOf: firstBodyCell,
          cell: true,
        });
      }
    }
  }
  return out;
}

describe("a loaded URL literal ending in `_`, `*` or `~` keeps the writer's bytes, by the core route (task 4.7 acceptance, C2)", () => {
  it.each(members().map((member) => [member.title, member] as const))("%s: save 1 is the input's bytes, save 2 is save 1, the tree is kept", (_title, member) => {
    const tree = parse(member.input);
    const save1 = format(tree);
    expect(member.bytesOf(save1), "save 1: the input's bytes").toBe(member.bytesOf(member.input));
    expect(member.cell ? unpadded(save1) : save1, "save 1: the input, the formatter's column padding aside").toBe(member.input);
    const save2 = format(parse(save1));
    expect(save2, "save 2 equals save 1").toBe(save1);
    expect(shape(parse(save1)), "the tree of save 1 is the input's").toEqual(shape(tree));
    if (member.cell) expect(rowWidths(parse(save1)), "two cells in every row").toEqual([2, 2]);
    const mapped = formatWithMap(tree);
    expect(mapped.text).toBe(save1);
    expect(mapped.map.unresolved, "nothing unresolved").toEqual([]);
  });
});

const text = (value: string): PhrasingContent => ({ type: "text", value });
const literal = (url: string): Link => ({
  type: "link",
  url,
  title: null,
  data: { autolinkLiteral: true },
  children: [{ type: "text", value: url }],
});
const resource = (url: string, ...children: PhrasingContent[]): Link => ({ type: "link", url, title: null, children });
const paragraph = (...children: PhrasingContent[]): Root => ({
  type: "root",
  children: [{ type: "paragraph", children }],
});

/** `node` without `position` or `data`: `<…>` and a bare literal differ only in `data`. */
function shapeWithoutData(node: Nodes): unknown {
  return JSON.parse(
    JSON.stringify(node, (key, value: unknown) => (key === "position" || key === "data" ? undefined : value)),
  );
}

describe("rawTrail reads the tokenizer's trailing punctuation (task 4.7 guard: rawTrail, TRAIL_RUN, ATTENTION_TRAIL)", () => {
  it("presence: a run holding `*`, `_` or `~` is written raw to its end, other trail characters included", () => {
    expect(rawTrail("_")).toBe(1);
    expect(rawTrail("*")).toBe(1);
    expect(rawTrail("~")).toBe(1);
    expect(rawTrail("._!) y")).toBe(4);
    expect(rawTrail("_*~,:;?'\" z")).toBe(9);
  });

  it("absence: a run of trail characters without `*`, `_` or `~` is left to `safe`, which writes it unchanged", () => {
    expect(rawTrail(". More")).toBe(0);
    expect(rawTrail("),")).toBe(0);
    expect(rawTrail(" _")).toBe(0);
  });

  it("the run ends at the first character `trail` does not consume (`&`, `]`, a letter, `\\`)", () => {
    expect(rawTrail("_&amp;")).toBe(1);
    expect(rawTrail("_]")).toBe(1);
    expect(rawTrail("_y")).toBe(1);
    expect(rawTrail("_\\")).toBe(1);
  });
});

describe("handleText writes the trail raw only after a literal written bare (task 4.7 guard: followsBareLiteral)", () => {
  it("presence: the text after a bare literal keeps its `_`", () => {
    expect(format(paragraph(literal("https://a.b/x"), text("_ y")))).toBe("https://a.b/x_ y\n");
  });

  it("absence: after a resource link the `_` is escaped by `safe`", () => {
    expect(format(paragraph(resource("https://a.b/x", text("t")), text("_ y")))).toBe("[t](https://a.b/x)\\_ y\n");
  });

  it("absence: a first child has no previous sibling, and its `_` is escaped by `safe`", () => {
    expect(format(paragraph(text("_ y")))).toBe("\\_ y\n");
  });

  it("absence: after a text node, not a link, the `_` is escaped by `safe`", () => {
    expect(format(paragraph(text("a"), text("_ y")))).toBe("a\\_ y\n");
  });

  it("absence: after a literal the settle loop escaped (a letter flush after it), the `_` is escaped by `safe`", () => {
    const out = format(paragraph(literal("https://a.b/x"), text("_y")));
    expect(out).toBe("<https://a.b/x>\\_y\n");
    expect(shapeWithoutData(parse(out))).toEqual(shapeWithoutData(paragraph(literal("https://a.b/x"), text("_y"))));
  });
});

describe("a literal span starting inside the trail is settled by the loop (task 4.7: handleText's no-bound comment)", () => {
  it("an e-mail literal owning the `_` (`_a@b.cd`): the bare link is escaped, the `_` written once, and the tree reads back", () => {
    const root = paragraph(literal("https://a.b/x"), text(" "), literal("https://c.d/y"), text("_a@b.cd end"));
    const out = format(root);
    expect(out.match(/_/g), "the one `_` is written once").toHaveLength(1);
    expect(shapeWithoutData(parse(out))).toEqual(
      shapeWithoutData(
        paragraph(
          literal("https://a.b/x"),
          text(" "),
          literal("https://c.d/y"),
          { type: "link", url: "mailto:_a@b.cd", title: null, children: [text("_a@b.cd")] },
          text(" end"),
        ),
      ),
    );
  });
});

describe("settleLiterals compares the tree when a trail was written raw (task 4.7 guard: trailedLiterals, shapeOf)", () => {
  it("a raw `*` that would close the emphasis around its literal is escaped, and the link takes `<…>`", () => {
    const root = paragraph({ type: "emphasis", children: [literal("https://a.b/"), text("*. x")] });
    const out = format(root);
    expect(out).toBe("*<https://a.b/>\\*. x*\n");
    expect(shapeWithoutData(parse(out))).toEqual(shapeWithoutData(root));
  });

  it("two raw `_` runs that would pair as emphasis between two literals are escaped", () => {
    const root = paragraph(literal("https://a.b/"), text("_. "), literal("https://c.d/"), text("_."));
    const out = format(root);
    expect(out).toBe("<https://a.b/>\\_. <https://c.d/>\\_.\n");
    expect(shapeWithoutData(parse(out))).toEqual(shapeWithoutData(root));
  });

  it("absence: a raw `~` inside `~~…~~` pairs with nothing, so the literal stays bare", () => {
    const root = paragraph({ type: "delete", children: [literal("https://a.b/"), text("~. x")] });
    expect(format(root)).toBe("~~https://a.b/~. x~~\n");
    expect(shape(parse(format(root)))).toEqual(shape(root));
  });
});

describe("the `literalMisread` give-up is reported where the map reports `unresolved` (task 4.7 guard: LiteralGiveUp, C13)", () => {
  // A link inside a link: no parse holds one (the inner link wins, CommonMark §6.3), so no escape
  // of one node reads the outer link back. The loop escapes the raw literal before it, and gives
  // up on the next round, while the literal after it is still raw.
  const nested = (): { root: Root; outer: Link } => {
    const outer = resource("https://v.w", text("a "), resource("https://u.v", text("b")));
    return { root: paragraph(literal("https://c.d"), text(" "), outer, text(" "), literal("https://e.f")), outer };
  };

  it("settleLiterals hands the give-up, naming the node at the disagreement, to its caller", () => {
    const { root, outer } = nested();
    const giveUps: Nodes[] = [];
    const out = settleLiterals(
      root,
      (escaped) => createFormatter(escaped).stringify(root),
      (bytes) => bytes,
      ({ giveUp }) => giveUps.push(giveUp),
    );
    expect(out).toBe(createFormatter("all").stringify(root));
    expect(out).toBe(format(root));
    expect(giveUps).toEqual([outer]);
  });

  it("formatWithMap reports the outer link's path in `unresolved`, and writes every literal escaped", () => {
    const { root } = nested();
    const mapped = formatWithMap(root);
    expect(mapped.text).toBe(format(root));
    expect(mapped.text.startsWith("<https://c.d>"), "the literal is escaped").toBe(true);
    expect(mapped.map.unresolved).toEqual(["0.2"]);
  });

  it("absence: a tree whose links read back gives nothing up", () => {
    expect(formatWithMap(paragraph(literal("https://c.d"), text(" "), resource("https://v.w", text("a")))).map.unresolved).toEqual([]);
  });
});

/** The r3 cell: `| c https://a.b/x\ | d |` loaded, `|y` typed after the link (no mark). */
const R3_INPUT = "| a | b |\n| - | - |\n| c https://a.b/x\\ | d |\n";
const R3_CELL = "c [https://a.b/x\\\\](https://a.b/x\\\\)\\|y";

describe("the r3 guard: a `\\`-terminal literal in a cell followed by a typed `|y` (task 4.7, #review-3-r3)", () => {
  it("core route: two cells, the tree, and the settled resource form's bytes", () => {
    const tree = parse(R3_INPUT);
    const cell = ((tree.children[0] as Table).children[1].children[0]).children;
    expect(linksOf(tree)).toEqual([["https://a.b/x\\", "https://a.b/x\\", true]]);
    cell.push(text("|y"));
    const save1 = format(tree);
    expect(firstBodyCell(save1)).toBe(R3_CELL);
    const reparsed = parse(save1);
    expect(rowWidths(reparsed), "two cells").toEqual([2, 2]);
    const reparsedCell = (reparsed.children[0] as Table).children[1].children[0];
    expect(shapeWithoutData(reparsedCell)).toEqual(
      shapeWithoutData({ type: "tableCell", children: [text("c "), literal("https://a.b/x\\"), text("|y")] }),
    );
    expect(format(reparsed), "save 2 equals save 1").toBe(save1);
    expect(formatWithMap(tree).map.unresolved).toEqual([]);
  });
});
