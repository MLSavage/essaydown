import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Nodes, Paragraph, PhrasingContent, Root } from "mdast";
import { describe, expect, it } from "vitest";
import { blocksOf } from "../src/blocks.js";
import { format } from "../src/format.js";
import { parse } from "../src/parse.js";
import {
  paragraphText,
  replaceSentence,
  reorderSentences,
  sentenceMarkdown,
  sentencesOf,
} from "../src/sentences.js";

/**
 * Marks that span a sentence boundary (DECISIONS #review-0-r1 G3, Sol finding 3).
 *
 * Two things are asserted here, and the corpus grew for the second.
 *
 *  1. **The no-op is the identity.** An identity permutation and a replacement equal to the
 *     sentence's own Markdown return the argument root itself, after the same validation a real
 *     edit gets. Before the fix both rebuilt the paragraph from per-sentence slices, and a mark
 *     spanning a boundary came back split: `**First sentence. Second sentence.**` reordered by
 *     `[0, 1]` became `**First sentence.** **Second sentence.**`, and the self-replacement of
 *     either sentence of `[First sentence. Second sentence.](https://example.com)` turned one link
 *     into two with the space between them moved outside.
 *
 *  2. **The rule for a real edit.** No sentence "keeps" a spanning mark: every sentence the mark
 *     covers keeps its own copy over its own share of the text, and the whitespace at the boundary
 *     is unwrapped from the mark and left where it was. That is the rule under which the bytes of
 *     every untouched sentence are unchanged, which is what the tests below assert at the first,
 *     the middle and the last position — an untouched sentence's own Markdown is the same slice of
 *     the same mark before and after the edit.
 *
 * The 0.14 corpus-wide identity invariant (sentences-zero-width.test.ts) passed on the broken code
 * because no indexed fixture carried a mark across a sentence boundary; the six
 * `spanning-mark-*.md` fixtures this task adds are that shape, and the non-vacuity test below
 * reads them out of index.json rather than naming them, so deleting one fails here.
 */

const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));

/** The document, its single top-level paragraph and that paragraph's contentId. */
function document(markdown: string): { root: Root; paragraph: Paragraph; blockId: string } {
  const root = parse(markdown);
  const block = blocksOf(root)[0];
  return { root, paragraph: block.node as Paragraph, blockId: block.contentId };
}

/** The inline mark types of PRD §6.1 — the nodes that can wrap a sentence boundary. */
const MARK_TYPES = ["strong", "emphasis", "link", "delete"] as const;
type MarkType = (typeof MARK_TYPES)[number];

/** The Markdown of every sentence of a paragraph, in order: the bytes an edit must not disturb. */
function sentenceMarkdowns(paragraph: Paragraph): string[] {
  return sentencesOf(paragraph).map((sentence) => sentenceMarkdown(paragraph, sentence.index));
}

/** The single top-level paragraph an operation rebuilt, read back out of the result. */
function paragraphAt(root: Root, index: number): Paragraph {
  return root.children[index] as Paragraph;
}

/** The plain-text length a node contributes to its paragraph, via the exported offset function. */
function textLength(node: PhrasingContent): number {
  return paragraphText({ type: "paragraph", children: [node] }).length;
}

/**
 * For every mark in `paragraph`, the indices of the sentence boundaries it spans. Boundary `i` is
 * the gap between sentence `i - 1` and sentence `i`; a mark spans it when it carries text on both
 * sides of it.
 */
function spannedBoundaries(paragraph: Paragraph): { type: MarkType; boundary: number }[] {
  const sentences = sentencesOf(paragraph);
  const spans: { type: MarkType; boundary: number }[] = [];

  const walk = (children: readonly PhrasingContent[], offset: number): void => {
    let cursor = offset;
    for (const child of children) {
      const start = cursor;
      const end = start + textLength(child);
      cursor = end;
      if ((MARK_TYPES as readonly string[]).includes(child.type)) {
        for (let i = 1; i < sentences.length; i++) {
          if (start < sentences[i - 1].end && end > sentences[i].start) {
            spans.push({ type: child.type as MarkType, boundary: i });
          }
        }
      }
      if ("children" in child) walk(child.children as PhrasingContent[], start);
    }
  };

  walk(paragraph.children, 0);
  return spans;
}

interface FixtureShape {
  name: string;
  root: Root;
  canonical: string;
  paragraphs: { index: number; blockId: string; paragraph: Paragraph; spans: number }[];
}

/** Every fixture index.json lists, with its top-level paragraphs and their spanning marks. */
const index = JSON.parse(readFileSync(`${FIXTURES}/index.json`, "utf8")) as Record<
  string,
  { nodeTypes: string[] }
>;

const corpus: FixtureShape[] = Object.keys(index)
  .sort()
  .map((name) => {
    const canonical = readFileSync(`${FIXTURES}/${name.replace(/\.md$/u, "")}.canonical.md`, "utf8");
    const root = parse(canonical);
    const paragraphs = blocksOf(root)
      .filter((block) => block.path.length === 1 && block.node.type === "paragraph")
      .map((block) => ({
        index: block.path[0],
        blockId: block.contentId,
        paragraph: block.node as Paragraph,
        spans: spannedBoundaries(block.node as Paragraph).length,
      }));
    return { name, root, canonical, paragraphs };
  });

/** The fixtures that carry at least one mark across a sentence boundary. */
const spanning = corpus.filter((fixture) => fixture.paragraphs.some((p) => p.spans > 0));

// ---------------------------------------------------------------------------------------------
// 1. Sol's two probes: the no-op is the identity
// ---------------------------------------------------------------------------------------------

describe("the no-op of a sentence operation is the identity (Sol's probes)", () => {
  const strong = "**First sentence. Second sentence.**\n";
  const link = "[First sentence. Second sentence.](https://example.com)\n";

  it("segments both probe paragraphs at a boundary inside the mark, so the probes are not vacuous", () => {
    for (const source of [strong, link]) {
      const { paragraph } = document(source);
      expect(sentencesOf(paragraph).map((sentence) => sentence.text)).toEqual([
        "First sentence.",
        "Second sentence.",
      ]);
      expect(spannedBoundaries(paragraph)).toEqual([
        { type: source === strong ? "strong" : "link", boundary: 1 },
      ]);
    }
  });

  it("reorders `**First sentence. Second sentence.**` by [0, 1] to the same bytes", () => {
    const { root, blockId } = document(strong);
    const next = reorderSentences(root, blockId, [0, 1]);
    expect(format(next)).toBe(strong);
    expect(next).toBe(root);
  });

  it("replaces either sentence of the spanning link with its own Markdown to the same bytes", () => {
    const { root, paragraph, blockId } = document(link);
    for (const sentence of sentencesOf(paragraph)) {
      const markdown = sentenceMarkdown(paragraph, sentence.index);
      const next = replaceSentence(root, blockId, sentence.index, markdown);
      expect(format(next)).toBe(link);
      expect(next).toBe(root);
    }
  });

  it("keeps the spanning mark whole rather than splitting it, which is what the bytes encode", () => {
    const { root, blockId } = document(link);
    const links = (paragraphAt(reorderSentences(root, blockId, [0, 1]), 0).children as Nodes[])
      .filter((child) => child.type === "link");
    expect(links).toHaveLength(1);
  });
});

describe("the short-circuit is taken after validation, not instead of it", () => {
  it("still rejects an unknown block, a non-paragraph block and a bad index for a no-op", () => {
    const { root, paragraph, blockId } = document("**One. Two.**\n");
    const own = sentenceMarkdown(paragraph, 0);

    expect(() => reorderSentences(root, "no-such-block", [0, 1])).toThrow(
      /no block with contentId/u,
    );
    expect(() => replaceSentence(root, "no-such-block", 0, own)).toThrow(/no block with contentId/u);
    expect(() => replaceSentence(root, blockId, 2, own)).toThrow(RangeError);
    expect(() => replaceSentence(root, blockId, -1, own)).toThrow(RangeError);

    const heading = parse("# Title\n\n**One. Two.**\n");
    const headingId = blocksOf(heading)[0].contentId;
    expect(() => reorderSentences(heading, headingId, [0, 1])).toThrow(/is a heading/u);
  });

  it("still rejects a non-permutation whose entries happen to be in ascending order", () => {
    const { root, blockId } = document("**One. Two. Three.**\n");
    expect(() => reorderSentences(root, blockId, [0, 1])).toThrow(RangeError);
    expect(() => reorderSentences(root, blockId, [0, 1, 1])).toThrow(RangeError);
  });

  it("takes the identity permutation of a paragraph with no sentences", () => {
    const { root, blockId } = document("![](a.png)\n");
    const next = reorderSentences(root, blockId, []);
    expect(next).toBe(root);
    expect(format(next)).toBe("![](a.png)\n");
  });

  it("decides from the argument, not from the bytes an edit would have produced", () => {
    // `*One.*` and `_One._` are the same tree, so a rebuild would serialize to the same bytes; the
    // replacement is still a real edit, takes the slicing path, and is not the argument root.
    const { root, paragraph, blockId } = document("*One.* Two.\n");
    expect(sentenceMarkdown(paragraph, 0)).toBe("*One.*");
    const next = replaceSentence(root, blockId, 0, "_One._");
    expect(next).not.toBe(root);
    expect(format(next)).toBe("*One.* Two.\n");
  });
});

// ---------------------------------------------------------------------------------------------
// 2. The corpus carries the shape the invariant is written for
// ---------------------------------------------------------------------------------------------

describe("fixtures/markdown carries marks spanning sentence boundaries", () => {
  it("has a canonical sibling and an index entry for every fixture the scan read", () => {
    expect(corpus).toHaveLength(Object.keys(index).length);
    expect(spanning.length).toBeGreaterThan(0);
    for (const fixture of spanning) {
      expect(index[fixture.name]).toBeDefined();
      expect(format(parse(fixture.canonical))).toBe(fixture.canonical);
    }
  });

  it.each(MARK_TYPES)("has at least one indexed fixture with %s spanning a boundary", (type) => {
    const found = corpus.flatMap((fixture) =>
      fixture.paragraphs.flatMap((p) =>
        spannedBoundaries(p.paragraph).filter((span) => span.type === type),
      ),
    );
    expect(found.length).toBeGreaterThan(0);
  });

  it("has a fixture whose mark spans the first boundary and one whose mark spans the last", () => {
    const positions = corpus.flatMap((fixture) =>
      fixture.paragraphs.flatMap((p) => {
        const count = sentencesOf(p.paragraph).length;
        // Only a paragraph with three or more sentences tells the first boundary from the last.
        if (count < 3) return [];
        return spannedBoundaries(p.paragraph).map((span) => ({
          name: fixture.name,
          first: span.boundary === 1,
          last: span.boundary === count - 1,
        }));
      }),
    );
    expect(positions.filter((position) => position.first).length).toBeGreaterThan(0);
    expect(positions.filter((position) => position.last).length).toBeGreaterThan(0);
    // And a boundary that is neither, so "first" and "last" are not the only cases covered.
    expect(
      positions.filter((position) => !position.first && !position.last).length,
    ).toBeGreaterThan(0);
  });

  it("leaves every spanning-mark fixture byte-identical under both no-ops", () => {
    for (const fixture of spanning) {
      for (const { blockId, paragraph } of fixture.paragraphs) {
        const sentences = sentencesOf(paragraph);
        const identity = sentences.map((sentence) => sentence.index);
        expect(format(reorderSentences(fixture.root, blockId, identity))).toBe(fixture.canonical);
        for (const sentence of sentences) {
          const markdown = sentenceMarkdown(paragraph, sentence.index);
          expect(
            format(replaceSentence(fixture.root, blockId, sentence.index, markdown)),
          ).toBe(fixture.canonical);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 3. The rule for a real edit, at the first, middle and last position
// ---------------------------------------------------------------------------------------------

describe("a real edit under a spanning mark, sentence by sentence", () => {
  const source = "**One. Two. Three.**\n";

  it("gives every sentence its own copy of the mark and leaves the boundary space outside it", () => {
    const { root, blockId } = document(source);
    expect(format(replaceSentence(root, blockId, 0, "New."))).toBe("New. **Two. Three.**\n");
    expect(format(replaceSentence(root, blockId, 1, "New."))).toBe("**One.** New. **Three.**\n");
    expect(format(replaceSentence(root, blockId, 2, "New."))).toBe("**One. Two.** New.\n");
    expect(format(reorderSentences(root, blockId, [1, 0, 2]))).toBe(
      "**Two.** **One.** **Three.**\n",
    );
  });

  it.each([0, 1, 2])(
    "leaves the bytes of every untouched sentence unchanged when sentence %i is replaced",
    (index) => {
      const { root, paragraph, blockId } = document(source);
      const before = sentenceMarkdowns(paragraph);
      const next = replaceSentence(root, blockId, index, "New.");
      const after = sentenceMarkdowns(paragraphAt(next, 0));

      expect(after).toHaveLength(before.length);
      expect(after[index]).toBe("New.");
      expect(after.filter((_, i) => i !== index)).toEqual(before.filter((_, i) => i !== index));
    },
  );

  it.each([
    ["the first", [1, 0, 2, 3]],
    ["a middle", [0, 2, 1, 3]],
    ["the last", [0, 1, 3, 2]],
  ] as [string, number[]][])(
    "carries every sentence's bytes with it when %s sentence moves",
    (_label, order) => {
      const { root, paragraph, blockId } = document("**One. Two. Three. Four.**\n");
      const before = sentenceMarkdowns(paragraph);
      expect(before).toHaveLength(order.length);

      const after = sentenceMarkdowns(paragraphAt(reorderSentences(root, blockId, order), 0));
      expect(after).toEqual(order.map((from) => before[from]));
      // The sentences that did not move are at their own index, with their own bytes.
      for (const [position, from] of order.entries()) {
        if (position === from) expect(after[position]).toBe(before[position]);
      }
    },
  );

  it("holds corpus-wide: a real replacement never rewrites another sentence's bytes", () => {
    let edits = 0;
    for (const fixture of spanning) {
      for (const { index: at, blockId, paragraph } of fixture.paragraphs) {
        const before = sentenceMarkdowns(paragraph);
        for (const [index] of before.entries()) {
          const next = replaceSentence(fixture.root, blockId, index, "A replacement.");
          const after = sentenceMarkdowns(paragraphAt(next, at));
          expect(after).toHaveLength(before.length);
          expect(after[index]).toBe("A replacement.");
          expect(after.filter((_, i) => i !== index)).toEqual(before.filter((_, i) => i !== index));
          edits += 1;
        }
      }
    }
    expect(edits).toBeGreaterThan(spanning.length);
  });

  it("holds corpus-wide: an adjacent swap carries each sentence's bytes to its new position", () => {
    let swaps = 0;
    for (const fixture of spanning) {
      for (const { index: at, blockId, paragraph } of fixture.paragraphs) {
        const before = sentenceMarkdowns(paragraph);
        for (let i = 0; i + 1 < before.length; i++) {
          const order = before.map((_, index) => index);
          [order[i], order[i + 1]] = [order[i + 1], order[i]];
          const after = sentenceMarkdowns(paragraphAt(reorderSentences(fixture.root, blockId, order), at));
          expect(after).toEqual(order.map((from) => before[from]));
          swaps += 1;
        }
      }
    }
    expect(swaps).toBeGreaterThan(spanning.length);
  });
});
