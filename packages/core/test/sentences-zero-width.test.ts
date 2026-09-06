import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Image, Link, Nodes, Paragraph, Root } from "mdast";
import { describe, expect, it } from "vitest";
import { blocksOf } from "../src/blocks.js";
import { format } from "../src/format.js";
import { parse } from "../src/parse.js";
import {
  replaceSentence,
  reorderSentences,
  sentenceMarkdown,
  sentencesOf,
} from "../src/sentences.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));

/** The document, its single top-level paragraph and that paragraph's contentId. */
function document(markdown: string): { root: Root; paragraph: Paragraph; blockId: string } {
  const root = parse(markdown);
  const block = blocksOf(root)[0];
  return { root, paragraph: block.node as Paragraph, blockId: block.contentId };
}

function collect<T extends Nodes>(root: Root, type: T["type"]): T[] {
  const found: T[] = [];
  const walk = (node: Nodes): void => {
    if (node.type === type) found.push(node as T);
    if ("children" in node) for (const child of node.children) walk(child as Nodes);
  };
  walk(root);
  return found;
}

const images = (root: Root): Image[] => collect<Image>(root, "image");
const links = (root: Root): Link[] => collect<Link>(root, "link");

/**
 * The probe cases of DECISIONS #review-0-r0 F1 (Claude findings 1–2, Sol finding 2). A width-0
 * atomic inline node — an image with an empty alt — had no owner at the end of a paragraph and two
 * owners at offset 0, so it was silently deleted or duplicated; a link wrapped around one was
 * dropped by the mark branch's overlap test.
 */
describe("a width-0 image at a paragraph boundary (DECISIONS #review-0-r0 F1)", () => {
  it("survives at the end of a paragraph when the first sentence is replaced", () => {
    const { root, blockId } = document("One. Two. ![](i.png)\n");
    const next = replaceSentence(root, blockId, 0, "X.");

    expect(format(next)).toBe("X. Two. ![](i.png)\n");
    expect(images(next)).toHaveLength(1);
    expect(images(next)[0].url).toBe("i.png");
    expect(images(next)[0].alt).toBe("");
  });

  it("survives at the end of a paragraph under the identity reorder", () => {
    const { root, blockId } = document("One. Two. ![](i.png)\n");
    const next = reorderSentences(root, blockId, [0, 1]);

    expect(format(next)).toBe(format(root));
    expect(images(next)).toHaveLength(1);
    expect(images(next)[0].url).toBe("i.png");
  });

  it("stays at the end of a paragraph when the two sentences before it are swapped", () => {
    const { root, blockId } = document("One. Two. ![](i.png)\n");
    const next = reorderSentences(root, blockId, [1, 0]);

    expect(format(next)).toBe("Two. One. ![](i.png)\n");
    expect(images(next)).toHaveLength(1);
  });

  it("is emitted exactly once when it leads the paragraph and the first sentence is replaced", () => {
    const { root, blockId } = document("![](i.png) One. Two.\n");
    const next = replaceSentence(root, blockId, 0, "X.");

    expect(format(next)).toBe("![](i.png) X. Two.\n");
    expect(images(next)).toHaveLength(1);
    expect(images(next)[0].url).toBe("i.png");
  });

  it("is emitted exactly once when it leads the paragraph and the sentences are reordered", () => {
    const { root, blockId } = document("![](i.png) One. Two.\n");

    expect(format(reorderSentences(root, blockId, [0, 1]))).toBe(format(root));
    expect(images(reorderSentences(root, blockId, [0, 1]))).toHaveLength(1);
    expect(format(reorderSentences(root, blockId, [1, 0]))).toBe("![](i.png) Two. One.\n");
    expect(images(reorderSentences(root, blockId, [1, 0]))).toHaveLength(1);
  });

  it("survives an identity reorder of a paragraph with a single sentence (Sol's probe)", () => {
    const { root, blockId } = document("Hi. ![](x.png)\n");
    const next = reorderSentences(root, blockId, [0]);

    expect(format(next)).toBe("Hi. ![](x.png)\n");
    expect(images(next)).toHaveLength(1);
    expect(images(next)[0].url).toBe("x.png");
  });

  it("survives replacement of the single sentence that precedes it", () => {
    const { root, blockId } = document("Hi. ![](x.png)\n");
    const next = replaceSentence(root, blockId, 0, "Bye.");

    expect(format(next)).toBe("Bye. ![](x.png)\n");
    expect(images(next)).toHaveLength(1);
  });

  it("is deleted with the sentence that contains it, and only that one (absence and presence)", () => {
    const { root, blockId } = document("One ![](i.png) here. Two.\n");
    const sentences = sentencesOf(parse(format(root)).children[0] as Paragraph);
    expect(sentences).toHaveLength(2);

    const first = replaceSentence(root, blockId, 0, "X.");
    expect(images(first)).toHaveLength(0);
    expect(format(first)).toBe("X. Two.\n");

    const second = replaceSentence(root, blockId, 1, "Y.");
    expect(images(second)).toHaveLength(1);
    expect(images(second)[0].url).toBe("i.png");
  });
});

describe("a link around a width-0 image (DECISIONS #review-0-r0 F1, Sol finding 2)", () => {
  const trailing = "Hi. There. [![](x.png)](https://e.x)\n";
  const leading = "[![](x.png)](https://e.x) Hi. There.\n";

  const expectLinkedImageIntact = (root: Root): void => {
    expect(links(root)).toHaveLength(1);
    expect(links(root)[0].url).toBe("https://e.x");
    expect(images(root)).toHaveLength(1);
    expect(images(root)[0].url).toBe("x.png");
    expect(links(root)[0].children).toHaveLength(1);
    expect(links(root)[0].children[0].type).toBe("image");
  };

  it("keeps its url at the end of a paragraph under the identity reorder", () => {
    const { root, blockId } = document(trailing);
    const next = reorderSentences(root, blockId, [0, 1]);

    expect(format(next)).toBe(trailing);
    expectLinkedImageIntact(next);
  });

  it("keeps its url at the end of a paragraph when either sentence is replaced", () => {
    const { root, blockId } = document(trailing);

    const first = replaceSentence(root, blockId, 0, "X.");
    expect(format(first)).toBe("X. There. [![](x.png)](https://e.x)\n");
    expectLinkedImageIntact(first);

    const last = replaceSentence(root, blockId, 1, "Y.");
    expect(format(last)).toBe("Hi. Y. [![](x.png)](https://e.x)\n");
    expectLinkedImageIntact(last);
  });

  it("keeps its url at the start of a paragraph under the identity reorder", () => {
    const { root, blockId } = document(leading);
    const next = reorderSentences(root, blockId, [0, 1]);

    expect(format(next)).toBe(leading);
    expectLinkedImageIntact(next);
  });

  it("keeps its url at the start of a paragraph when the first sentence is replaced", () => {
    const { root, blockId } = document(leading);
    const next = replaceSentence(root, blockId, 0, "X.");

    expect(format(next)).toBe("[![](x.png)](https://e.x) X. There.\n");
    expectLinkedImageIntact(next);
  });
});

describe("two adjacent width-0 images", () => {
  it("both survive, in order, at the end of a paragraph", () => {
    const { root, blockId } = document("One. Two. ![](a.png)![](b.png)\n");

    const reordered = reorderSentences(root, blockId, [0, 1]);
    expect(format(reordered)).toBe("One. Two. ![](a.png)![](b.png)\n");
    expect(images(reordered).map((image) => image.url)).toEqual(["a.png", "b.png"]);

    const replaced = replaceSentence(root, blockId, 0, "X.");
    expect(format(replaced)).toBe("X. Two. ![](a.png)![](b.png)\n");
    expect(images(replaced).map((image) => image.url)).toEqual(["a.png", "b.png"]);
  });

  it("both survive, in order, at the start of a paragraph", () => {
    const { root, blockId } = document("![](a.png)![](b.png) One. Two.\n");

    const reordered = reorderSentences(root, blockId, [0, 1]);
    expect(format(reordered)).toBe("![](a.png)![](b.png) One. Two.\n");
    expect(images(reordered).map((image) => image.url)).toEqual(["a.png", "b.png"]);

    const replaced = replaceSentence(root, blockId, 1, "Y.");
    expect(format(replaced)).toBe("![](a.png)![](b.png) One. Y.\n");
    expect(images(replaced).map((image) => image.url)).toEqual(["a.png", "b.png"]);
  });
});

/**
 * The invariant the corpus never had (DECISIONS #review-0-r0 F1): a sentence operation given its
 * own no-op argument must return a document that serializes to the same bytes. `reorderSentences`
 * takes the identity permutation; `replaceSentence` takes the sentence's own inline Markdown
 * ({@link sentenceMarkdown}) — its plain text would drop the marks inside the sentence, which is a
 * property of the formatter rather than of the slicing this asserts.
 */
describe("corpus-wide identity invariant over fixtures/markdown/index.json", () => {
  const index = JSON.parse(readFileSync(`${FIXTURES}/index.json`, "utf8")) as Record<
    string,
    { paragraphStartLines: number[] }
  >;
  const names = Object.keys(index).sort();

  interface Counts {
    fixtures: number;
    paragraphs: number;
    sentences: number;
  }

  /** Runs both no-op operations over every top-level paragraph of one fixture. */
  function checkFixture(name: string): { paragraphs: number; sentences: number } {
    const stem = name.replace(/\.md$/u, "");
    const canonical = readFileSync(`${FIXTURES}/${stem}.canonical.md`, "utf8");
    const root = parse(canonical);
    const before = format(root);
    const paragraphs = blocksOf(root).filter(
      (block) => block.path.length === 1 && block.node.type === "paragraph",
    );
    let sentenceCount = 0;

    for (const block of paragraphs) {
      const paragraph = block.node as Paragraph;
      const sentences = sentencesOf(paragraph, { blockId: block.contentId });
      sentenceCount += sentences.length;

      const identity = sentences.map((sentence) => sentence.index);
      expect(format(reorderSentences(root, block.contentId, identity))).toBe(before);

      for (const sentence of sentences) {
        const markdown = sentenceMarkdown(paragraph, sentence.index);
        expect(format(replaceSentence(root, block.contentId, sentence.index, markdown))).toBe(
          before,
        );
      }
    }

    return { paragraphs: paragraphs.length, sentences: sentenceCount };
  }

  it("runs over every fixture the index lists, and over a corpus that is not empty", () => {
    const totals = names.reduce<Counts>(
      (accumulated, name) => {
        const { paragraphs, sentences } = checkFixture(name);
        return {
          fixtures: accumulated.fixtures + 1,
          paragraphs: accumulated.paragraphs + paragraphs,
          sentences: accumulated.sentences + sentences,
        };
      },
      { fixtures: 0, paragraphs: 0, sentences: 0 },
    );

    // The counts are read from the index, never written as literals (CLAUDE.md, code rules).
    expect(totals.fixtures).toBe(names.length);
    expect(totals.fixtures).toBeGreaterThan(0);
    expect(totals.paragraphs).toBeGreaterThan(0);
    expect(totals.sentences).toBeGreaterThan(totals.paragraphs);
  });

  it.each(names)(
    "%s: an identity reorder and a self-replacement leave every top-level paragraph byte-identical",
    (name) => {
      const { paragraphs, sentences } = checkFixture(name);
      expect(paragraphs).toBeGreaterThanOrEqual(0);
      expect(sentences).toBeGreaterThanOrEqual(0);
    },
  );
});

describe("sentenceMarkdown", () => {
  it("gives the sentence's own inline Markdown, marks included", () => {
    const { paragraph } = document("A **bold** start. A plain end.\n");

    expect(sentenceMarkdown(paragraph, 0)).toBe("A **bold** start.");
    expect(sentenceMarkdown(paragraph, 1)).toBe("A plain end.");
  });

  it("rejects an index that is not a sentence of the paragraph", () => {
    const { paragraph } = document("Only one.\n");

    expect(() => sentenceMarkdown(paragraph, 1)).toThrow(RangeError);
    expect(() => sentenceMarkdown(paragraph, -1)).toThrow(RangeError);
  });
});
