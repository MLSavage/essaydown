import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Html, Yaml } from "mdast";
import { describe, expect, it } from "vitest";
import { format } from "../src/format.js";
import { parse } from "../src/parse.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/front-matter", import.meta.url));

const RAW_HTML = [
  '<div class="callout" data-kind="aside">',
  "  <!-- the app must not touch a byte of this -->",
  "  <p>Hand-written&nbsp;HTML, <b>bold</b>&mdash;kept.</p>",
  "</div>",
].join("\n");

const RAW_YAML = [
  "title: 'The Fountain Pen'  # kept as written",
  "question: |",
  "  What did the nib ever ask of us?",
  "notes:",
  "  - ink",
  "  - paper",
].join("\n");

describe("opaque set (PRD §6.1)", () => {
  it("keeps an html node byte-identical across format(parse(x))", () => {
    const source = `A paragraph.\n\n${RAW_HTML}\n\nAnother paragraph.\n`;
    const before = parse(source).children.find((n) => n.type === "html") as Html;
    expect(before.value).toBe(RAW_HTML);

    const round = format(parse(source));
    const after = parse(round).children.find((n) => n.type === "html") as Html;
    expect(after.value).toBe(RAW_HTML);
    expect(round).toBe(source);
  });

  it("keeps a yaml block byte-identical across format(parse(x))", () => {
    const source = `---\n${RAW_YAML}\n---\n\nA paragraph.\n`;
    const before = parse(source).children.find((n) => n.type === "yaml") as Yaml;
    expect(before.value).toBe(RAW_YAML);

    const round = format(parse(source));
    const after = parse(round).children.find((n) => n.type === "yaml") as Yaml;
    expect(after.value).toBe(RAW_YAML);
    expect(round).toBe(source);
  });
});

interface Node {
  type: string;
  value?: string;
  children?: Node[];
}

describe("syntax the parser does not enable (PRD §4, §6.1)", () => {
  it("parses a `[^1]` footnote reference as plain text", () => {
    const root = parse("Pens leak.[^1]\n\n[^1]: Especially in aeroplanes.\n");
    const values: string[] = [];
    const walk = (node: Node): void => {
      if (node.type === "text") values.push(node.value ?? "");
      for (const child of node.children ?? []) walk(child);
    };
    walk(root as Node);
    expect(root.children.every((n) => n.type === "paragraph")).toBe(true);
    expect(values.join("\n")).toContain("[^1]");
    expect(JSON.stringify(root)).not.toContain("footnote");
  });
});

describe("front-matter fixtures round-trip byte-identical (PRD §6.1)", () => {
  const names = readdirSync(FIXTURES)
    .filter((n) => n.endsWith(".md"))
    .sort();

  it("covers the quoted, commented, block-scalar, duplicate and malformed forms", () => {
    expect(names).toEqual([
      "block-scalar.md",
      "commented.md",
      "duplicate.md",
      "malformed.md",
      "quoted.md",
    ]);
  });

  for (const name of names) {
    it(`${name} is unchanged when no app-owned key changes`, () => {
      const source = readFileSync(`${FIXTURES}/${name}`, "utf8");
      const root = parse(source);
      expect(root.children[0].type).toBe("yaml");
      expect(format(root)).toBe(source);
    });
  }
});
