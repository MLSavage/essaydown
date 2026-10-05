import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { paragraphText, parse } from "@essaydown/core";
import { cursorBlock } from "../src/cursor-block.js";
import { mdastToPM, schema } from "../src/schema.js";

/**
 * Rewrite mode's caret → sentence step (task 3.4): every position inside a top-level paragraph
 * names that paragraph's root index (front matter shifted back in) and a plain-text offset in
 * `paragraphText`'s own terms — 0 at the paragraph's start, its whole length at its end, never
 * decreasing — over every fixture, so an image's alt, inline html and a hard break count as
 * `paragraphText` counts them.
 */

const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));
const index = JSON.parse(readFileSync(`${FIXTURES}/index.json`, "utf8")) as Record<string, unknown>;
const names = Object.keys(index).sort();

describe("cursorBlock", () => {
  it("maps every position of every top-level paragraph to its block and plain-text offset (corpus)", () => {
    let paragraphs = 0;
    for (const name of names) {
      const root = parse(readFileSync(`${FIXTURES}/${name}`, "utf8"));
      const shift = root.children[0]?.type === "yaml" ? 1 : 0;
      const { doc } = mdastToPM(root);
      doc.forEach((child, offset, block) => {
        const node = root.children[block + shift];
        if (child.type.name !== "paragraph") {
          expect(cursorBlock(doc, offset + 1)?.offset ?? null, `${name} block ${block}`).toBeNull();
          return;
        }
        expect(node.type).toBe("paragraph");
        if (node.type !== "paragraph") return;
        const plain = paragraphText(node);
        let previous = -1;
        for (let p = offset + 1; p <= offset + child.nodeSize - 1; p += 1) {
          const at = cursorBlock(doc, p);
          expect(at?.block, `${name} @${p}`).toBe(block);
          const value = at?.offset ?? -1;
          expect(value).toBeGreaterThanOrEqual(Math.max(previous, 0));
          previous = value;
        }
        expect(cursorBlock(doc, offset + 1)?.offset).toBe(0);
        expect(cursorBlock(doc, offset + child.nodeSize - 1)?.offset, name).toBe(plain.length);
        paragraphs += 1;
      });
    }
    expect(paragraphs).toBeGreaterThan(names.length);
  });

  it("counts an image's alt, inline html and a hard break as paragraphText does", () => {
    for (const markdown of ["a ![alt](x.png) b\n", "a <span>x</span> b\n", "a\\\nb\n"]) {
      const root = parse(markdown);
      const { doc } = mdastToPM(root);
      const node = root.children[0];
      if (node.type !== "paragraph") throw new Error(markdown);
      expect(cursorBlock(doc, doc.child(0).nodeSize - 1)?.offset, markdown).toBe(paragraphText(node).length);
    }
  });

  it("counts an image without alt text as nothing", () => {
    const paragraph = schema.node("paragraph", null, [
      schema.text("a"),
      schema.node("image", { url: "x.png", alt: null }),
      schema.text("b"),
    ]);
    const doc = schema.node("doc", null, [paragraph]);
    expect(cursorBlock(doc, paragraph.nodeSize - 1)).toEqual({ block: 0, offset: 2 });
  });

  it("is null outside the doc", () => {
    const { doc } = mdastToPM(parse("One.\n"));
    expect(cursorBlock(doc, -1)).toBeNull();
    expect(cursorBlock(doc, doc.content.size + 1)).toBeNull();
  });
});
