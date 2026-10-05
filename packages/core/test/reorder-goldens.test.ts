import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Nodes, Paragraph, Root } from "mdast";
import { describe, expect, it } from "vitest";
import { format } from "../src/format.js";
import { parse } from "../src/parse.js";
import { blocksOf, sectionsOf } from "../src/blocks.js";
import { sentencesOf } from "../src/sentences.js";
import { applyMoveBlock, applyReorderSentences, emptySidecar } from "../src/sidecar.js";
import { applyAddVariant } from "../src/rewrite.js";

// Task 3.5's two Reorder goldens, which e2e/shell/test/reorder.spec.ts reaches through the sidebar.
// Pinned here too so a core change that moves their bytes is caught by `pnpm test`, not only by the
// shell e2e.
//
// "Paragraph 4" is the fourth top-level paragraph, counted from 1 as task 3.4 counted it. In the
// essay fixture it has two sentences and no marks, so "sentence 3 → 1 … with marks intact" starts
// from expected/essay-fixture.reorder-sentence.seed.md: the canonical essay with one third sentence
// appended to paragraph 4 that carries emphasis, strong and inline code. "Section 3" is the third
// section of `sectionsOf`, and paragraphs 2 and 4 are the second and fourth top-level paragraphs
// inside it (between its heading and the next one).
const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));
const read = (name: string): string => readFileSync(`${FIXTURES}/${name}`, "utf8");
const CANONICAL = read("essay-fixture.canonical.md");
const SEED = read("expected/essay-fixture.reorder-sentence.seed.md");
const SENTENCE_GOLDEN = read("expected/essay-fixture.reorder-sentence.md");
const PARA_GOLDEN = read("expected/essay-fixture.reorder-para.md");

function paragraphIndices(root: Root, from = 0, to = root.children.length): number[] {
  const found: number[] = [];
  for (let at = from; at < to; at += 1) if (root.children[at].type === "paragraph") found.push(at);
  return found;
}

function markCounts(node: Nodes): Record<string, number> {
  const counts: Record<string, number> = { emphasis: 0, strong: 0, inlineCode: 0 };
  const walk = (one: Nodes): void => {
    if (one.type in counts) counts[one.type] += 1;
    if ("children" in one) one.children.forEach(walk);
  };
  walk(node);
  return counts;
}

/** The section-3 block bounds: the blocks between its heading and the next heading. */
function sectionThreeBlocks(root: Root): { from: number; to: number } {
  const start = sectionsOf(root)[2].start;
  let to = start + 1;
  while (to < root.children.length && root.children[to].type !== "heading") to += 1;
  return { from: start + 1, to };
}

describe("expected/essay-fixture.reorder-sentence.md (task 3.5)", () => {
  const seed = parse(SEED);
  const p4 = paragraphIndices(seed)[3];
  const paragraph = seed.children[p4] as Paragraph;
  const blockId = (blocksOf(seed).find((one) => one.path.length === 1 && one.path[0] === p4) as { contentId: string })
    .contentId;

  it("the seed is the canonical essay with a third, marked sentence appended to paragraph 4", () => {
    const canonical = parse(CANONICAL);
    expect(paragraphIndices(canonical)[3]).toBe(p4);
    expect(sentencesOf(canonical.children[p4] as Paragraph)).toHaveLength(2);
    expect(sentencesOf(paragraph)).toHaveLength(3);
    const marks = markCounts(paragraph);
    expect(marks.emphasis).toBeGreaterThan(0);
    expect(marks.strong).toBeGreaterThan(0);
    expect(marks.inlineCode).toBeGreaterThan(0);
    expect(markCounts(canonical.children[p4])).toEqual({ emphasis: 0, strong: 0, inlineCode: 0 });
    // Only paragraph 4's line differs.
    const seedLines = SEED.split("\n");
    const canonicalLines = CANONICAL.split("\n");
    expect(seedLines).toHaveLength(canonicalLines.length);
    const differing = seedLines.flatMap((line, index) => (line === canonicalLines[index] ? [] : [index]));
    expect(differing).toHaveLength(1);
    expect(seedLines[differing[0]].startsWith(canonicalLines[differing[0]])).toBe(true);
  });

  it("sentence 3 → 1 in paragraph 4 equals the golden, marks intact, every other line unchanged", () => {
    const state = applyReorderSentences({ root: seed, sidecar: emptySidecar() }, blockId, [2, 0, 1]);
    expect(format(state.root)).toBe(SENTENCE_GOLDEN);
    const moved = parse(SENTENCE_GOLDEN).children[p4] as Paragraph;
    expect(markCounts(moved)).toEqual(markCounts(paragraph));
    const before = sentencesOf(paragraph).map((one) => one.text);
    expect(sentencesOf(moved).map((one) => one.text)).toEqual([before[2], before[0], before[1]]);
    const goldenLines = SENTENCE_GOLDEN.split("\n");
    const seedLines = SEED.split("\n");
    expect(goldenLines.filter((line, index) => line !== seedLines[index])).toHaveLength(1);
  });

  it("the sidecar entry on sentence 3 moves to sentence 1 with it", () => {
    const withVariant = applyAddVariant({ root: seed, sidecar: emptySidecar() }, [p4, 2], "Steel cured *nothing*.", "2026-10-05T00:00:00Z");
    const state = applyReorderSentences(withVariant, blockId, [2, 0, 1]);
    expect(state.sidecar.rewrites.map((entry) => entry.anchor.pos)).toEqual([[p4, 0]]);
    expect(state.sidecar.orphans).toEqual([]);
  });
});

describe("expected/essay-fixture.reorder-para.md (task 3.5)", () => {
  const canonical = parse(CANONICAL);
  const { from, to } = sectionThreeBlocks(canonical);
  const paragraphs = paragraphIndices(canonical, from, to);

  it("section 3 has at least four paragraphs, and something that is not one between them", () => {
    expect(paragraphs.length).toBeGreaterThanOrEqual(4);
    expect(to - from).toBeGreaterThan(paragraphs.length);
  });

  it("paragraph 2 → 4 in section 3 equals the golden, a reordering of the same lines", () => {
    const state = applyMoveBlock({ root: canonical, sidecar: emptySidecar() }, paragraphs[1], paragraphs[3]);
    expect(format(state.root)).toBe(PARA_GOLDEN);
    expect(PARA_GOLDEN).not.toBe(CANONICAL);
    expect(PARA_GOLDEN.split("\n").sort()).toEqual(CANONICAL.split("\n").sort());
    const golden = parse(PARA_GOLDEN);
    expect(format({ ...golden, children: [golden.children[paragraphs[3]]] })).toBe(
      format({ ...canonical, children: [canonical.children[paragraphs[1]]] }),
    );
    // Nothing outside section 3 moved.
    expect(sectionThreeBlocks(golden)).toEqual({ from, to });
    expect(format({ ...golden, children: golden.children.slice(0, from) })).toBe(
      format({ ...canonical, children: canonical.children.slice(0, from) }),
    );
    expect(format({ ...golden, children: golden.children.slice(to) })).toBe(
      format({ ...canonical, children: canonical.children.slice(to) }),
    );
  });
});
