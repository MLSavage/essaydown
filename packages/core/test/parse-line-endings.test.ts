import { describe, expect, it } from "vitest";
import { format } from "../src/format.js";
import { parse } from "../src/parse.js";

/**
 * DECISIONS #review-0-r0 F12/F13 (Sol finding 4, Grok findings 9-10): `parse` normalises
 * `\r\n?` to `\n` over the whole document before handing it to the parser. micromark on its own
 * only drops the CR between blocks, so a CRLF pair survives inside a multi-line paragraph and a
 * fenced code block without this rewrite. Each case below is a string literal, not a corpus
 * fixture — fixtures/markdown reserves its one CRLF source for `crlf-line-endings.md` (task
 * 0.4), and these are ordinary in-memory assertions on `parse`/`format`.
 */

interface Node {
  type: string;
  value?: string;
  children?: Node[];
}

function values(root: Node): string[] {
  const found: string[] = [];
  const walk = (node: Node): void => {
    if (typeof node.value === "string") found.push(node.value);
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return found;
}

describe("parse normalises CRLF line endings (PRD §6.1, invariant C)", () => {
  it("a CRLF two-line paragraph", () => {
    const source = "Line one\r\nLine two\r\n";
    expect(source).toContain("\r\n");

    const root = parse(source);
    const nodeValues = values(root as Node);
    expect(nodeValues.length).toBeGreaterThan(0);
    for (const value of nodeValues) expect(value).not.toContain("\r");

    expect(format(root)).not.toContain("\r");
  });

  it("a CRLF fenced code block", () => {
    const source = "```\r\nline one\r\nline two\r\n```\r\n";
    expect(source).toContain("\r\n");

    const root = parse(source);
    const nodeValues = values(root as Node);
    expect(nodeValues.length).toBeGreaterThan(0);
    for (const value of nodeValues) expect(value).not.toContain("\r");

    expect(format(root)).not.toContain("\r");
  });

  it("a CRLF html block", () => {
    const source = "<div>\r\n  <p>hi</p>\r\n</div>\r\n\r\nA paragraph.\r\n";
    expect(source).toContain("\r\n");

    const root = parse(source);
    const nodeValues = values(root as Node);
    expect(nodeValues.length).toBeGreaterThan(0);
    for (const value of nodeValues) expect(value).not.toContain("\r");

    expect(format(root)).not.toContain("\r");
  });

  it("a CRLF yaml block", () => {
    const source = "---\r\ntitle: X\r\nquestion: Y\r\n---\r\n\r\nA paragraph.\r\n";
    expect(source).toContain("\r\n");

    const root = parse(source);
    const nodeValues = values(root as Node);
    expect(nodeValues.length).toBeGreaterThan(0);
    for (const value of nodeValues) expect(value).not.toContain("\r");

    expect(format(root)).not.toContain("\r");
  });
});
