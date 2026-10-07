import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Nodes, Root } from "mdast";
import type { Node as PMNode } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import { format } from "../../core/src/format.js";
import { parse } from "../../core/src/parse.js";
import { formatWithMap } from "../../core/src/positions.js";
import { mdastToPM, pmToMdast, schema } from "../src/schema.js";

/**
 * A loaded URL literal ending in `_`, `*` or `~` keeps the writer's bytes, by the editor route
 * (task 4.7 acceptance, DECISIONS #059, #review-3-r0 C2): each save is
 * `format(pmToMdast(mdastToPM(parse(·))))`. The core route's twin, and the guards on the
 * serializer's own branches, are `packages/core/test/url-trail.test.ts`.
 *
 * The corpus leg types, at both edges of every textblock of every fixture in index.json, a literal
 * link and one trailing character — the loaded literal followed by a typed `_`, `*` or
 * `~` — and reads the position map's `unresolved` first: it is where `settleLiterals` reports a
 * give-up (C13), so a case removed from `literalMisread`'s mirror of the parser turns it red.
 */

const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));
const index = JSON.parse(readFileSync(`${FIXTURES}/index.json`, "utf8")) as Record<string, unknown>;
const names = Object.keys(index).sort();

function reloaded(bytes: string): string {
  return format(pmToMdast(mdastToPM(parse(bytes))));
}

/** `node` without `position`, recursively: the tree `parse` makes, as the app compares it. */
function shape(node: Nodes): unknown {
  return JSON.parse(JSON.stringify(node, (key, value: unknown) => (key === "position" ? undefined : value)));
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

/** The body row's first cell's bytes in a formatted probe, without its padding. */
function firstBodyCell(bytes: string): string {
  return bytes.split("\n")[2].split(" | ")[0].slice(2).trimEnd();
}

/** Bytes with the formatter's column padding taken out (lesson [3.7.r3d]). */
function unpadded(bytes: string): string {
  return bytes.replace(/ +/g, " ").replace(/-+/g, "-");
}

const TRAILS = ["_", "*", "~"];
const URLS = ["https://a.b/x", "https://a.b/𝒜"];
const AFTER: [string, string][] = [
  ["the block's end", ""],
  ["whitespace", " y"],
  ["punctuation", "."],
  ["an astral symbol", "😀"],
  ["an astral letter", "𝒜"],
];

const cellProbe = (cell: string): string => `| a | b |\n| - | - |\n| c ${cell} | d |\n`;

const MEMBERS: [string, string, boolean][] = TRAILS.flatMap((trail) =>
  URLS.flatMap((url) =>
    AFTER.flatMap(([neighbour, after]): [string, string, boolean][] => {
      const bytes = `${url}${trail}${after}`;
      return [
        [`paragraph, \`${bytes}\` (${neighbour} after \`${trail}\`)`, `see ${bytes}\n`, false],
        [`table cell, \`${bytes}\` (${neighbour} after \`${trail}\`; the formatter pads the column)`, cellProbe(bytes), true],
      ];
    }),
  ),
);

describe("a loaded URL literal ending in `_`, `*` or `~` keeps the writer's bytes, by the editor route (task 4.7 acceptance, C2)", () => {
  it.each(MEMBERS)("%s: save 1 is the input's bytes, save 2 is save 1, the tree is kept", (_title, input, cell) => {
    const tree = parse(input);
    const save1 = reloaded(input);
    if (cell) {
      expect(firstBodyCell(save1), "save 1: the cell's bytes are the input's").toBe(firstBodyCell(input));
      expect(unpadded(save1), "save 1: the input, the formatter's column padding aside").toBe(input);
      expect(rowWidths(parse(save1)), "two cells in every row").toEqual([2, 2]);
    } else {
      expect(save1, "save 1: the input's bytes").toBe(input);
    }
    expect(reloaded(save1), "save 2 equals save 1").toBe(save1);
    expect(shape(parse(save1)), "the tree of save 1 is the input's").toEqual(shape(tree));
    const editorTree = pmToMdast(mdastToPM(tree));
    const mapped = formatWithMap(editorTree);
    expect(mapped.text).toBe(save1);
    expect(mapped.map.unresolved, "nothing unresolved").toEqual([]);
  });
});

/** Where the first link mark's text ends in `doc`. */
function firstLinkEnd(doc: PMNode): number {
  let end = -1;
  doc.descendants((node, pos) => {
    if (end === -1 && node.isText && node.marks.some((mark) => mark.type === schema.marks.link)) {
      end = pos + node.nodeSize;
    }
    return end === -1;
  });
  return end;
}

describe("the r3 guard: a `\\`-terminal literal in a cell followed by a typed `|y`, by the editor route (task 4.7, #review-3-r3)", () => {
  it("two cells, the tree, and the settled resource form's bytes", () => {
    const editor = mdastToPM(parse("| a | b |\n| - | - |\n| c https://a.b/x\\ | d |\n"));
    const at = firstLinkEnd(editor.doc);
    expect(editor.doc.textBetween(at - 14, at)).toBe("https://a.b/x\\");
    const doc = EditorState.create({ doc: editor.doc }).tr.insert(at, schema.text("|y")).doc;
    const save1 = format(pmToMdast({ doc, frontMatter: editor.frontMatter }));
    expect(firstBodyCell(save1)).toBe("c [https://a.b/x\\\\](https://a.b/x\\\\)\\|y");
    const reparsed = parse(save1);
    expect(rowWidths(reparsed), "two cells").toEqual([2, 2]);
    const cell = (reparsed.children[0] as { children: { children: Nodes[] }[] }).children[1].children[0];
    expect(shape(cell)).toEqual({
      type: "tableCell",
      children: [
        { type: "text", value: "c " },
        { type: "link", title: null, url: "https://a.b/x\\", children: [{ type: "text", value: "https://a.b/x\\" }] },
        { type: "text", value: "|y" },
      ],
    });
    expect(reloaded(save1), "save 2 equals save 1").toBe(save1);
  });
});

const URL_TYPED = "https://example.com/x";

/** The start and the end of every textblock outside a fenced code block, in document order. */
function blockEdges(doc: PMNode): [number, number][] {
  const out: [number, number][] = [];
  doc.descendants((node, pos) => {
    if (node.type === schema.nodes.code_block) return false;
    if (node.isTextblock) {
      out.push([pos + 1, pos + 1 + node.content.size]);
      return false;
    }
    return true;
  });
  return out;
}

/**
 * At the start and at the end of every block, the literal link (as a loaded one is) and `trail`,
 * a space between them and the block's own text, applied back-to-front. Two per block, so every
 * other link of a block has a literal before it and one after it: a disagreement at that link
 * leaves a raw literal on each side, which is what a case missing from `literalMisread`'s mirror
 * needs to reach the give-up rather than to escape its way out.
 */
function typeTrailedLiteralAtEveryBlockEdge(doc: PMNode, trail: string): { doc: PMNode; typed: number } {
  const edges = blockEdges(doc);
  const literal = (): PMNode => schema.text(URL_TYPED, [schema.marks.link.create({ url: URL_TYPED, title: null, literal: true })]);
  let tr = EditorState.create({ doc }).tr;
  for (const [start, end] of [...edges].reverse()) {
    tr = tr.insert(end, [schema.text(" "), literal(), schema.text(trail)]);
    tr = tr.insert(start, [literal(), schema.text(`${trail} `)]);
  }
  return { doc: tr.doc, typed: 2 * edges.length };
}

function count(haystack: string, needle: string): number {
  let n = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) n += 1;
  return n;
}

describe("a literal link and a typed trailing `_`, `*` or `~` at both edges of every block of every fixture (task 4.7 corpus leg; C13's reader)", () => {
  for (const trail of TRAILS) {
    it.each(names)(`\`${trail}\`, %s: nothing unresolved, the bytes hold the literal and its \`${trail}\` as typed, a fixed point`, (name) => {
      const editor = mdastToPM(parse(readFileSync(`${FIXTURES}/${name}`, "utf8")));
      const { doc, typed } = typeTrailedLiteralAtEveryBlockEdge(editor.doc, trail);
      const root = pmToMdast({ doc, frontMatter: editor.frontMatter });
      const mapped = formatWithMap(root);
      expect(mapped.map.unresolved, `${name}: nothing unresolved (no settleLiterals give-up)`).toEqual([]);
      const bytes = format(root);
      expect(mapped.text).toBe(bytes);
      expect(count(bytes, `${URL_TYPED}${trail}`), `${name}: the literal and its \`${trail}\`, twice per block`).toBe(typed);
      expect(format(parse(bytes)), `${name}: parse∘format fixed point`).toBe(bytes);
      expect(reloaded(bytes), `${name}: the editor's own trip`).toBe(bytes);
    });
  }
});
