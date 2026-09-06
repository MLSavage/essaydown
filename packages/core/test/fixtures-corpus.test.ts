import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { format } from "../src/format.js";
import { parse } from "../src/parse.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));

interface Node {
  type: string;
  children?: Node[];
}

interface IndexEntry {
  nodeTypes: string[];
  blockCount: number;
  sectionCount: number;
  paragraphStartLines: number[];
}

function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

// The restricted node set of PRD §6.1.
const SUPPORTED_NODE_TYPES = [
  "root",
  "heading",
  "paragraph",
  "text",
  "emphasis",
  "strong",
  "inlineCode",
  "delete",
  "link",
  "image",
  "list",
  "listItem",
  "blockquote",
  "code",
  "thematicBreak",
  "table",
  "tableRow",
  "tableCell",
  "break",
  "html",
  "yaml",
].sort();

const allFiles = readdirSync(FIXTURES);
const sourceNames = allFiles.filter((n) => n.endsWith(".md") && !n.endsWith(".canonical.md")).sort();
const index = JSON.parse(readFileSync(`${FIXTURES}/index.json`, "utf8")) as Record<string, IndexEntry>;
const schema = JSON.parse(readFileSync(`${FIXTURES}/index.schema.json`, "utf8")) as {
  additionalProperties: { required: string[] };
};

describe("fixtures/markdown corpus (task 0.4)", () => {
  it("has exactly 44 source files and 44 canonical siblings", () => {
    expect(sourceNames).toHaveLength(44);
    for (const name of sourceNames) {
      const stem = name.replace(/\.md$/, "");
      expect(allFiles).toContain(`${stem}.canonical.md`);
    }
    expect(allFiles.filter((n) => n.endsWith(".canonical.md"))).toHaveLength(44);
  });

  it("index.json validates against index.schema.json", () => {
    expect(Object.keys(index).sort()).toEqual(sourceNames);
    const requiredKeys = schema.additionalProperties.required;
    for (const name of sourceNames) {
      expect(name).toMatch(/^[a-z0-9-]+\.md$/);
      const entry = index[name];
      expect(Object.keys(entry).sort()).toEqual([...requiredKeys].sort());
      expect(Array.isArray(entry.nodeTypes)).toBe(true);
      expect(entry.nodeTypes.length).toBeGreaterThan(0);
      expect(new Set(entry.nodeTypes).size).toBe(entry.nodeTypes.length);
      expect(Number.isInteger(entry.blockCount)).toBe(true);
      expect(entry.blockCount).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(entry.sectionCount)).toBe(true);
      expect(entry.sectionCount).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(entry.paragraphStartLines)).toBe(true);
      for (const line of entry.paragraphStartLines) {
        expect(Number.isInteger(line)).toBe(true);
        expect(line).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("has every fixture's .canonical.md sibling equal to format(parse(source))", () => {
    for (const name of sourceNames) {
      const stem = name.replace(/\.md$/, "");
      const source = readFileSync(`${FIXTURES}/${name}`, "utf8");
      const canonical = readFileSync(`${FIXTURES}/${stem}.canonical.md`, "utf8");
      expect(format(parse(source))).toBe(canonical);
    }
  });

  it("has index.json's paragraphStartLines matching the canonical file's actual paragraph positions", () => {
    for (const name of sourceNames) {
      const stem = name.replace(/\.md$/, "");
      const canonical = readFileSync(`${FIXTURES}/${stem}.canonical.md`, "utf8");
      const root = parse(canonical) as unknown as Node & {
        children: (Node & { position?: { start: { line: number } } })[];
      };
      const lines: number[] = [];
      walk(root, (n) => {
        const withPos = n as Node & { position?: { start: { line: number } } };
        if (n.type === "paragraph" && withPos.position) lines.push(withPos.position.start.line);
      });
      expect(index[name].paragraphStartLines).toEqual(lines);
    }
  });

  it("has no supported §6.1 node type absent from the union of node types across the corpus", () => {
    const union = new Set<string>();
    for (const entry of Object.values(index)) {
      for (const type of entry.nodeTypes) union.add(type);
    }
    expect([...union].sort()).toEqual(SUPPORTED_NODE_TYPES);
  });

  it("has hand-computed blockCounts for five named fixtures (PRD §6.1: root's direct children, plus each listItem, plus each tableRow)", () => {
    // nested-lists.md: a 3-deep list.
    //   root children: 1 (the top-level list)                                    -> 1
    //   listItems: "Top level one", "Top level two" (level 1)                    -> 2
    //              "Second level one", "Second level two" (level 2)              -> 2
    //              "Third level one" (level 3)                                   -> 1
    //   total = 1 + 2 + 2 + 1 = 6
    expect(index["nested-lists.md"].blockCount).toBe(6);

    // table-escaped-pipes.md: one table, one header row + two data rows.
    //   root children: 1 (the table)                                            -> 1
    //   tableRows: header + 2 data rows                                          -> 3
    //   total = 1 + 3 = 4
    expect(index["table-escaped-pipes.md"].blockCount).toBe(4);

    // code-fence-nested.md: two fenced code blocks, no nested blocks inside a fence.
    //   root children: 2 (two `code` nodes)                                      -> 2
    //   total = 2
    expect(index["code-fence-nested.md"].blockCount).toBe(2);

    // front-matter.md: yaml front matter, one heading, one paragraph.
    //   root children: yaml, heading, paragraph                                  -> 3
    //   total = 3
    expect(index["front-matter.md"].blockCount).toBe(3);

    // raw-html.md: one html block (blank-line-terminated), one paragraph.
    //   root children: html, paragraph                                          -> 2
    //   total = 2
    expect(index["raw-html.md"].blockCount).toBe(2);
  });
});
