import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Link, Paragraph, Root } from "mdast";
import { describe, expect, it } from "vitest";
import { blocksOf, normalizedText } from "../src/blocks.js";
import { format } from "../src/format.js";
import { contentHash } from "../src/hash.js";
import { parse } from "../src/parse.js";
import {
  ABBREVIATIONS,
  paragraphText,
  replaceSentence,
  reorderSentences,
  segmentSentences,
  sentencesOf,
  type SegmentFn,
} from "../src/sentences.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));

interface Case {
  id: string;
  rule: string;
  text: string;
  sentences: string[];
}

const casesFile = JSON.parse(
  readFileSync(fileURLToPath(new URL("./sentences.cases.json", import.meta.url)), "utf8"),
) as { _note: string; cases: Case[] };
const cases = casesFile.cases;

/** The document, its single top-level paragraph and that paragraph's contentId. */
function document(markdown: string): { root: Root; paragraph: Paragraph; blockId: string } {
  const root = parse(markdown);
  const block = blocksOf(root)[0];
  return { root, paragraph: block.node as Paragraph, blockId: block.contentId };
}

describe("sentences.cases.json", () => {
  it("holds the 30 cases task 0.8's acceptance names, with unique ids", () => {
    expect(cases).toHaveLength(30);
    expect(new Set(cases.map((one) => one.id)).size).toBe(cases.length);
    for (const one of cases) {
      expect(typeof one.rule).toBe("string");
      expect(one.rule.length).toBeGreaterThan(0);
      expect(Array.isArray(one.sentences)).toBe(true);
    }
  });

  it("contains the three cases the acceptance spells out, at the counts it states", () => {
    const named = new Map(cases.map((one) => [one.text, one.sentences.length]));
    expect(named.get("Dr. Smith went home. He slept.")).toBe(2);
    expect(named.get("It cost 3.50 dollars. Then more.")).toBe(2);
    expect(named.get("See e.g. the chart. Next.")).toBe(2);
  });

  it("covers every abbreviation PRD §6.1 lists", () => {
    const corpus = cases.map((one) => one.text).join("\n");
    for (const abbreviation of ABBREVIATIONS) {
      expect(corpus).toContain(abbreviation);
    }
  });

  it.each(cases)("segments $id", ({ text, sentences }) => {
    const segmented = segmentSentences(text);
    expect(segmented.map((sentence) => sentence.text)).toEqual(sentences);
    for (const sentence of segmented) {
      expect(text.slice(sentence.start, sentence.end)).toBe(sentence.text);
    }
  });

  it.each(cases)("addresses $id through sentencesOf", ({ text, sentences }) => {
    const paragraph: Paragraph = { type: "paragraph", children: [{ type: "text", value: text }] };
    const found = sentencesOf(paragraph);
    expect(found.map((sentence) => sentence.text)).toEqual(sentences);
    expect(found.map((sentence) => sentence.index)).toEqual(sentences.map((_, index) => index));
    const plain = paragraphText(paragraph);
    for (const sentence of found) {
      expect(plain.slice(sentence.start, sentence.end)).toBe(sentence.text);
    }
  });
});

describe("sentencesOf", () => {
  it("reads offsets over the paragraph's plain text, not its Markdown", () => {
    const { paragraph } = document("A **bold** start. And *emphasis* here.\n");
    expect(paragraphText(paragraph)).toBe("A bold start. And emphasis here.");
    expect(sentencesOf(paragraph).map((sentence) => [sentence.start, sentence.end])).toEqual([
      [0, 13],
      [14, 32],
    ]);
  });

  it("carries the blockId it is given, and otherwise the paragraph's own first-occurrence id", () => {
    const { root, paragraph, blockId } = document("Only one. And two.\n");
    expect(sentencesOf(paragraph).map((sentence) => sentence.blockId)).toEqual([blockId, blockId]);
    expect(blockId).toBe(`${contentHash(normalizedText(paragraph))}-0`);

    const second = blocksOf(parse("Same text.\n\nSame text.\n")).at(-1);
    const given = sentencesOf(second?.node as Paragraph, { blockId: second?.contentId });
    expect(given[0].blockId).toBe(second?.contentId);
    expect(given[0].blockId.endsWith("-1")).toBe(true);
    expect(root.children).toHaveLength(1);
  });

  it("takes its candidate boundaries from an injected segmenter", () => {
    const never: SegmentFn = () => [0];
    const everyWord: SegmentFn = (text) => {
      const starts = [0];
      for (let i = 0; i < text.length; i += 1) if (text[i] === " ") starts.push(i + 1);
      return starts;
    };
    const paragraph: Paragraph = {
      type: "paragraph",
      children: [{ type: "text", value: "One. Two. Three." }],
    };
    expect(sentencesOf(paragraph, { segment: never }).map((s) => s.text)).toEqual([
      "One. Two. Three.",
    ]);
    expect(sentencesOf(paragraph, { segment: everyWord }).map((s) => s.text)).toEqual([
      "One.",
      "Two.",
      "Three.",
    ]);
  });

  it("finds no sentences in a paragraph whose only content has no text", () => {
    const { paragraph } = document("![](a.png)\n");
    expect(paragraphText(paragraph)).toBe("");
    expect(sentencesOf(paragraph)).toEqual([]);
  });
});

describe("replaceSentence", () => {
  const source = "A **bold** start. And *emphasis* here.\n";

  it("replaces the sentence with plain text, marks inside the range going with it", () => {
    const { root, blockId } = document(source);
    expect(format(replaceSentence(root, blockId, 0, "A quiet start."))).toBe(
      "A quiet start. And *emphasis* here.\n",
    );
  });

  it("takes the marks of the replacement text, so the user controls them", () => {
    const { root, blockId } = document(source);
    expect(format(replaceSentence(root, blockId, 0, "A **quiet** start."))).toBe(
      "A **quiet** start. And *emphasis* here.\n",
    );
  });

  it("leaves the untouched sentence's marks alone when the second is replaced", () => {
    const { root, blockId } = document(source);
    expect(format(replaceSentence(root, blockId, 1, "And *calm* here."))).toBe(
      "A **bold** start. And *calm* here.\n",
    );
  });

  it("does not mutate the root it was given", () => {
    const { root, blockId } = document(source);
    const before = structuredClone(root);
    replaceSentence(root, blockId, 0, "A quiet start.");
    expect(root).toEqual(before);
  });

  it("keeps the part of a mark that lies outside the replaced range, and drops the part inside", () => {
    const { root, blockId } = document("*One here. Two there.* Three.\n");
    expect(format(replaceSentence(root, blockId, 1, "Two elsewhere."))).toBe(
      "*One here.* Two elsewhere. Three.\n",
    );
  });

  it("moves an image with the sentence that contains it", () => {
    const { root, blockId } = document("First one. See ![a pen](pen.png) here.\n");
    expect(format(replaceSentence(root, blockId, 0, "New one."))).toBe(
      "New one. See ![a pen](pen.png) here.\n",
    );
    expect(format(replaceSentence(root, blockId, 1, "Gone."))).toBe("First one. Gone.\n");
  });

  it("keeps inline code inside the sentence it belongs to", () => {
    const { root, blockId } = document("Run `pnpm test` now. Then read it.\n");
    expect(format(replaceSentence(root, blockId, 1, "Then stop."))).toBe(
      "Run `pnpm test` now. Then stop.\n",
    );
  });

  it("rejects an index that is not a sentence of the block", () => {
    const { root, blockId } = document(source);
    expect(() => replaceSentence(root, blockId, 2, "x.")).toThrow(RangeError);
    expect(() => replaceSentence(root, blockId, -1, "x.")).toThrow(RangeError);
    expect(() => replaceSentence(root, blockId, 1.5, "x.")).toThrow(RangeError);
  });

  it("rejects a replacement that is not inline Markdown", () => {
    const { root, blockId } = document(source);
    expect(() => replaceSentence(root, blockId, 0, "# A heading")).toThrow(/not inline Markdown/u);
    expect(() => replaceSentence(root, blockId, 0, "One.\n\nTwo.")).toThrow(/not inline Markdown/u);
    expect(() => replaceSentence(root, blockId, 0, "")).toThrow(/not inline Markdown/u);
  });

  it("rejects an unknown block, and every block that is not a top-level paragraph (PRD §6.1 v1 scope)", () => {
    const root = parse("## A heading\n\n- A nested one. And another.\n");
    const blocks = blocksOf(root);
    const heading = blocks.find((block) => block.node.type === "heading");
    const listItem = blocks.find((block) => block.node.type === "listItem");
    // A paragraph inside a list item is not a block at all (§6.1), so it has no contentId to pass:
    // the reachable non-paragraph blocks are the top-level ones and the listItem/tableRow blocks.
    expect(blocks.some((block) => block.node.type === "paragraph")).toBe(false);
    expect(() => replaceSentence(root, "0000000000000-0", 0, "x.")).toThrow(/no block with/u);
    expect(() => replaceSentence(root, heading?.contentId ?? "", 0, "x.")).toThrow(/top-level/u);
    expect(() => replaceSentence(root, listItem?.contentId ?? "", 0, "x.")).toThrow(/top-level/u);
    expect(() => reorderSentences(root, listItem?.contentId ?? "", [1, 0])).toThrow(/top-level/u);
  });
});

describe("a link spanning a sentence boundary", () => {
  const source = "See [the pen. It is](https://example.com/pen) here.\n";

  it("is split into two sentences whose plain text ignores the link syntax", () => {
    const { paragraph } = document(source);
    expect(sentencesOf(paragraph).map((sentence) => sentence.text)).toEqual([
      "See the pen.",
      "It is here.",
    ]);
  });

  it("survives on both sides of a reorder, each side keeping the url", () => {
    const { root, blockId } = document(source);
    const next = reorderSentences(root, blockId, [1, 0]);
    const links = (next.children[0] as Paragraph).children.filter(
      (child): child is Link => child.type === "link",
    );
    expect(links).toHaveLength(2);
    expect(links.map((link) => link.url)).toEqual([
      "https://example.com/pen",
      "https://example.com/pen",
    ]);
    expect(
      links.map((link) => paragraphText({ type: "paragraph", children: link.children })),
    ).toEqual(["It is", "the pen."]);
    expect(format(next)).toBe(
      "[It is](https://example.com/pen) here. See [the pen.](https://example.com/pen)\n",
    );
  });

  it("survives on the other side when one of the two sentences is replaced", () => {
    const { root, blockId } = document(source);
    const first = replaceSentence(root, blockId, 0, "New first.");
    expect(paragraphText(first.children[0] as Paragraph)).toBe("New first. It is here.");
    expect(
      (first.children[0] as Paragraph).children.filter((child) => child.type === "link"),
    ).toHaveLength(1);
    expect(format(first)).toBe("New first. [It is](https://example.com/pen) here.\n");

    const second = replaceSentence(root, blockId, 1, "New second.");
    expect(paragraphText(second.children[0] as Paragraph)).toBe("See the pen. New second.");
    expect(format(second)).toBe("See [the pen.](https://example.com/pen) New second.\n");
  });
});

describe("reorderSentences", () => {
  it("is a no-op for the identity permutation", () => {
    const source = "A **bold** start. And *emphasis* here.\n";
    const { root, blockId } = document(source);
    expect(format(reorderSentences(root, blockId, [0, 1]))).toBe(source);
  });

  it("swaps two sentences, marks travelling with them", () => {
    const { root, blockId } = document("A **bold** start. And *emphasis* here.\n");
    expect(format(reorderSentences(root, blockId, [1, 0]))).toBe(
      "And *emphasis* here. A **bold** start.\n",
    );
  });

  it("rotates three sentences", () => {
    const { root, blockId } = document("One. Two. Three.\n");
    expect(format(reorderSentences(root, blockId, [2, 0, 1]))).toBe("Three. One. Two.\n");
  });

  it("leaves the whitespace between sentences where it was", () => {
    const { root, blockId } = document("One.  Two. Three.\n");
    expect(paragraphText(reorderSentences(root, blockId, [2, 1, 0]).children[0] as Paragraph)).toBe(
      "Three.  Two. One.",
    );
  });

  it("keeps a hard break between the sentences it separated", () => {
    const { root, paragraph, blockId } = document("One.  \nTwo.\n");
    expect(paragraph.children.some((child) => child.type === "break")).toBe(true);
    expect(paragraphText(paragraph)).toBe("One. Two.");
    expect(sentencesOf(paragraph).map((sentence) => sentence.text)).toEqual(["One.", "Two."]);

    const next = reorderSentences(root, blockId, [1, 0]);
    expect((next.children[0] as Paragraph).children.some((child) => child.type === "break")).toBe(
      true,
    );
    // A hard break is canonically `\` + newline in docs/MARKDOWN-STYLE.md's style.
    expect(format(next)).toBe("Two.\\\nOne.\n");
    expect(format(reorderSentences(root, blockId, [0, 1]))).toBe("One.\\\nTwo.\n");
  });

  it("moves an image with its sentence", () => {
    const { root, blockId } = document("See ![a pen](pen.png) here. Then read.\n");
    expect(format(reorderSentences(root, blockId, [1, 0]))).toBe(
      "Then read. See ![a pen](pen.png) here.\n",
    );
  });

  it("does not mutate the root it was given", () => {
    const { root, blockId } = document("One. Two.\n");
    const before = structuredClone(root);
    reorderSentences(root, blockId, [1, 0]);
    expect(root).toEqual(before);
  });

  it("accepts the empty permutation for a paragraph with no sentences", () => {
    const { root, blockId } = document("![](a.png)\n");
    expect(format(reorderSentences(root, blockId, []))).toBe("![](a.png)\n");
  });

  it("rejects anything that is not a permutation of the sentence indices", () => {
    const { root, blockId } = document("One. Two. Three.\n");
    expect(() => reorderSentences(root, blockId, [0, 1])).toThrow(RangeError);
    expect(() => reorderSentences(root, blockId, [0, 1, 1])).toThrow(RangeError);
    expect(() => reorderSentences(root, blockId, [0, 1, 3])).toThrow(RangeError);
    expect(() => reorderSentences(root, blockId, [0, 1, -1])).toThrow(RangeError);
    expect(() => reorderSentences(root, blockId, [0, 1, 2.5])).toThrow(RangeError);
  });
});

describe("over the essay fixture", () => {
  const canonical = readFileSync(`${FIXTURES}/essay-fixture.canonical.md`, "utf8");
  const root = parse(canonical);
  const paragraphs = blocksOf(root).filter(
    (block) => block.path.length === 1 && block.node.type === "paragraph",
  );

  it("finds sentences in every top-level paragraph of the essay", () => {
    expect(paragraphs.length).toBeGreaterThan(0);
    for (const block of paragraphs) {
      const sentences = sentencesOf(block.node as Paragraph, { blockId: block.contentId });
      expect(sentences.length).toBeGreaterThan(0);
      expect(sentences.map((sentence) => sentence.text).join(" ").length).toBeGreaterThan(0);
    }
  });

  it("leaves the document byte-identical when every paragraph is reordered into its own order", () => {
    let next = root;
    for (const block of paragraphs) {
      const sentences = sentencesOf(block.node as Paragraph, { blockId: block.contentId });
      next = reorderSentences(
        next,
        block.contentId,
        sentences.map((sentence) => sentence.index),
      );
    }
    expect(format(next)).toBe(canonical);
  });
});
