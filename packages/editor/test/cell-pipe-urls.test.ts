import type { Nodes, Root } from "mdast";
import { describe, expect, it } from "vitest";
import { format } from "../../core/src/format.js";
import { parse } from "../../core/src/parse.js";
import { formatWithMap } from "../../core/src/positions.js";
import { mdastToPM, pmToMdast } from "../src/schema.js";

/**
 * A loaded `\|` in a table cell's link url, three saves by the editor route (task 4.6 acceptance,
 * DECISIONS #059, #review-3-r2): each save is `format(pmToMdast(mdastToPM(parse(·))))`. The core
 * route's twin is `packages/core/test/cell-pipe-urls.test.ts`.
 */

const LOADED: [string, string, string][] = [
  ["the `<…>` member", "<https://a.b/x\\|y>", "https://a.b/x|y"],
  ["the literal member", "https://a.b/x\\|y", "https://a.b/x|y"],
  ["the `<…>` astral twin", "<https://a.b/x\\|𝒜>", "https://a.b/x|𝒜"],
  ["the literal astral twin", "https://a.b/x\\|𝒜", "https://a.b/x|𝒜"],
];

/** The probe `| a | b |\n| - | - |\n| c <cell> | d |\n`, unpadded, as another editor writes it. */
const probe = (cell: string): string => `| a | b |\n| - | - |\n| c ${cell} | d |\n`;

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

function urlsOf(root: Root): string[] {
  const out: string[] = [];
  const walk = (node: Nodes): void => {
    if (node.type === "link") out.push(node.url);
    if ("children" in node) for (const child of node.children as Nodes[]) walk(child);
  };
  walk(root);
  return out;
}

describe("a loaded `\\|` in a table cell's link url, three saves by the editor route (task 4.6 acceptance)", () => {
  for (const [title, cell, url] of LOADED) {
    it(`${title} \`${cell}\`: two cells, the input's tree and its cell bytes on every save, url \`${url}\` in the editor's tree`, () => {
      const input = probe(cell);
      const tree = parse(input);
      const editorTree = pmToMdast(mdastToPM(tree));
      expect(urlsOf(editorTree), "the url in the editor's tree").toEqual([url]);
      let bytes = input;
      for (let k = 1; k <= 3; k += 1) {
        bytes = reloaded(bytes);
        const reparsed = parse(bytes);
        expect(rowWidths(reparsed), `save ${k}: two cells in every row`).toEqual([2, 2]);
        expect(shape(reparsed), `save ${k}: the tree equals the input's`).toEqual(shape(tree));
        expect(bytes.split("\n")[2], `save ${k}: the cell's bytes are the input's`).toContain(`| c ${cell} |`);
        expect(urlsOf(pmToMdast(mdastToPM(reparsed))), `save ${k}: the url in the editor's tree`).toEqual([url]);
      }
      expect(formatWithMap(editorTree).map.unresolved, "nothing unresolved").toEqual([]);
    });
  }
});
