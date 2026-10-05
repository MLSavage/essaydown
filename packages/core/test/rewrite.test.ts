import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blocksOf } from "../src/blocks.js";
import { format } from "../src/format.js";
import { parse } from "../src/parse.js";
import {
  applyAddVariant,
  applyDeleteOrphan,
  applyReattach,
  applyUseVariant,
  rewriteCards,
  unattachedRewrites,
} from "../src/rewrite.js";
import { replaceSentence } from "../src/sentences.js";
import { attach, emptySidecar, refresh, type DocumentState } from "../src/sidecar.js";
import { createUndoStack, current, push, undo } from "../src/undo.js";

/**
 * Rewrite mode's document operations (task 3.4). Each mutation is checked for both halves — the
 * Markdown and the sidecar — and "Use this" for its no-op argument over the whole corpus
 * (CLAUDE.md's identity rule). The acceptance sequence the shell e2e drives on essay-fixture is
 * replayed here headlessly against the same golden.
 */

const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));
const index = JSON.parse(readFileSync(`${FIXTURES}/index.json`, "utf8")) as Record<string, unknown>;
const names = Object.keys(index).sort();
const ESSAY = readFileSync(`${FIXTURES}/essay-fixture.canonical.md`, "utf8");
const REWRITTEN = readFileSync(`${FIXTURES}/expected/essay-fixture.rewrite.md`, "utf8");
const VARIANT_1 = "If anything they sharpened it.";
const VARIANT_2 = "If anything, a metal nib made it *worse*.";

function stateOf(markdown: string): DocumentState {
  const root = parse(markdown);
  return { root, sidecar: attach(emptySidecar(), root).sidecar };
}

/** Root indices of the top-level paragraphs, in order. */
function paragraphs(markdown: string): number[] {
  return blocksOf(parse(markdown))
    .filter((block) => block.path.length === 1 && block.node.type === "paragraph")
    .map((block) => block.path[0]);
}

/** The state after a typing edit: a new root, the sidecar left as the store leaves it. */
function typed(state: DocumentState, markdown: string): DocumentState {
  return { root: parse(markdown), sidecar: state.sidecar };
}

const P4 = paragraphs(ESSAY)[3];

function withTwoVariants(): DocumentState {
  let state = stateOf(ESSAY);
  state = applyAddVariant(state, [P4, 1], VARIANT_1, "2026-01-01T00:00:00Z");
  return applyAddVariant(state, [P4, 1], VARIANT_2, "2026-01-01T00:00:01Z");
}

describe("rewriteCards", () => {
  it("lists every sentence of a top-level paragraph, and nothing for any other block", () => {
    const cards = rewriteCards(stateOf(ESSAY), P4);
    expect(cards?.map((card) => card.pos)).toEqual([
      [P4, 0],
      [P4, 1],
    ]);
    expect(cards?.every((card) => card.entry === null && !card.duplicate)).toBe(true);
    const heading = blocksOf(parse(ESSAY)).find((block) => block.node.type === "heading");
    expect(rewriteCards(stateOf(ESSAY), heading?.path[0] ?? -1)).toBeNull();
  });

  it("badges a sentence whose text occurs elsewhere, and only that one", () => {
    const cards = rewriteCards(stateOf("Same here. Other.\n\nSame here.\n"), 0);
    expect(cards?.map((card) => card.duplicate)).toEqual([true, false]);
  });
});

describe("applyAddVariant", () => {
  it("creates one entry per sentence and appends to it, leaving the Markdown by reference", () => {
    const before = stateOf(ESSAY);
    const state = applyAddVariant(applyAddVariant(before, [P4, 1], VARIANT_1, "t"), [P4, 1], VARIANT_2, "t");
    expect(state.root).toBe(before.root);
    expect(state.sidecar.rewrites).toHaveLength(1);
    const [entry] = state.sidecar.rewrites;
    expect(entry.anchor.pos).toEqual([P4, 1]);
    expect(entry.variants.map((variant) => variant.text)).toEqual([VARIANT_1, VARIANT_2]);
    expect(entry.chosen).toBeNull();
    expect(rewriteCards(state, P4)?.[1].entry).toEqual(entry);
    expect(rewriteCards(state, P4)?.[0].entry).toBeNull();
  });

  it("refuses a position with no sentence and text that is not inline Markdown", () => {
    expect(() => applyAddVariant(stateOf(ESSAY), [P4, 9], "x.", "t")).toThrow(RangeError);
    expect(() => applyAddVariant(stateOf(ESSAY), [P4, 0], "# Heading", "t")).toThrow(/inline/);
    expect(() => applyAddVariant(stateOf(ESSAY), [P4, 0], "   ", "t")).toThrow(/inline/);
  });
});

describe("applyUseVariant", () => {
  it("choose variant 2 on paragraph 4's sentence 2: expected/essay-fixture.rewrite.md, emphasis kept", () => {
    const state = applyUseVariant(withTwoVariants(), [P4, 1], 1, "2026-01-01T00:00:02Z");
    expect(format(state.root)).toBe(REWRITTEN);
    expect(REWRITTEN).toContain("*worse*");
    const [entry] = state.sidecar.rewrites;
    expect(entry.chosen).toBe(1);
    expect(entry.history.map((one) => one.text)).toEqual([
      "If anything they sharpened it: a steel nib could be ground to a finer point than a quill, which made the ink-starvation problem — the nib running dry mid-stroke — more noticeable, not less.",
    ]);
    // The entry stayed on its sentence, now the variant's text.
    expect(entry.anchor.pos).toEqual([P4, 1]);
    expect(entry.anchor.text).toBe("If anything, a metal nib made it worse.");
    expect(refresh(state.sidecar, state.root).orphans).toEqual([]);
  });

  it("one undo step restores the sentence and chosen together", () => {
    const before = withTwoVariants();
    const stack = push(createUndoStack(before.root, before.sidecar), ...(() => {
      const after = applyUseVariant(before, [P4, 1], 1, "t");
      return [after.root, after.sidecar] as const;
    })());
    expect(format(current(stack).root)).toBe(REWRITTEN);
    const back = current(undo(stack));
    expect(format(back.root)).toBe(ESSAY);
    expect(back.sidecar.rewrites[0].chosen).toBeNull();
    expect(back.sidecar.rewrites[0].history).toEqual([]);
  });

  it("moves later sentences' entries by the number of sentences the variant added", () => {
    let state = stateOf("One here. Two here. Three here.\n");
    state = applyAddVariant(state, [0, 2], "Third.", "t");
    state = applyAddVariant(state, [0, 0], "First. And more.", "t");
    state = applyUseVariant(state, [0, 0], 0, "t");
    expect(format(state.root)).toBe("First. And more. Two here. Three here.\n");
    const third = state.sidecar.rewrites.find((entry) => entry.variants[0].text === "Third.");
    expect(third?.anchor.pos).toEqual([0, 3]);
    expect(third?.anchor.text).toBe("Three here.");
  });

  it("refuses a sentence with no entry and a variant index it does not have", () => {
    expect(() => applyUseVariant(stateOf(ESSAY), [P4, 1], 0, "t")).toThrow(RangeError);
    expect(() => applyUseVariant(withTwoVariants(), [P4, 1], 2, "t")).toThrow(RangeError);
  });

  it("the no-op variant re-serialises byte-identically for every fixture (corpus identity)", () => {
    let checked = 0;
    for (const name of names) {
      const markdown = readFileSync(`${FIXTURES}/${name}`, "utf8");
      const canonical = format(parse(markdown));
      for (const at of paragraphs(markdown)) {
        const before = stateOf(markdown);
        for (const card of rewriteCards(before, at) ?? []) {
          const added = applyAddVariant(before, card.pos, card.markdown, "t");
          const used = applyUseVariant(added, card.pos, 0, "t");
          expect(used.root, `${name} [${card.pos.join(", ")}]`).toBe(before.root);
          expect(format(used.root)).toBe(canonical);
          expect(used.sidecar.rewrites[0].chosen).toBe(0);
          expect(used.sidecar.rewrites[0].history).toEqual([]);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(names.length);
    // Every sentence of every top-level paragraph of every fixture: ~3 s alone, more under the
    // parallel suite, so the default 5 s is too tight.
  }, 30_000);
});

describe("anchoring across typing", () => {
  const chosen = (): DocumentState => applyUseVariant(withTwoVariants(), [P4, 1], 1, "t");

  it("an edit elsewhere in the paragraph keeps the card on its sentence", () => {
    const edited = REWRITTEN.replace("Metal dip pens", "Metal ink dip pens");
    expect(edited).not.toBe(REWRITTEN);
    const state = typed(chosen(), edited);
    expect(rewriteCards(state, P4)?.[1].entry?.variants).toHaveLength(2);
    expect(unattachedRewrites(state)).toEqual([]);
  });

  it("retyping the sentence entirely sends the card to Unattached, and nothing else does", () => {
    const state = typed(chosen(), REWRITTEN.replace("If anything, a metal nib made it *worse*.", "Nothing was solved by it."));
    expect(rewriteCards(state, P4)?.every((card) => card.entry === null)).toBe(true);
    const unattached = unattachedRewrites(state);
    expect(unattached).toHaveLength(1);
    expect(unattached[0].entry.variants.map((variant) => variant.text)).toEqual([VARIANT_1, VARIANT_2]);
  });

  it("dragging the unattached card onto sentence 1 re-anchors it there", () => {
    const state = typed(chosen(), REWRITTEN.replace("If anything, a metal nib made it *worse*.", "Nothing was solved by it."));
    const [orphan] = unattachedRewrites(state);
    const reattached = applyReattach(state, orphan.index, [P4, 0]);
    expect(reattached.root).toBe(state.root);
    expect(unattachedRewrites(reattached)).toEqual([]);
    expect(reattached.sidecar.orphans).toEqual([]);
    const cards = rewriteCards(reattached, P4);
    expect(cards?.[0].entry?.variants.map((variant) => variant.text)).toEqual([VARIANT_1, VARIANT_2]);
    expect(cards?.[0].entry?.anchor.text).toMatch(/^Metal dip pens/);
    expect(cards?.[1].entry).toBeNull();
    expect(refresh(reattached.sidecar, reattached.root).orphans).toEqual([]);
  });

  it("reattaching onto a sentence that has an entry merges into it and keeps its chosen", () => {
    let state = applyAddVariant(stateOf("Alpha one. Beta two.\n"), [0, 1], "Beta.", "t");
    state = applyUseVariant(state, [0, 1], 0, "t");
    state = applyAddVariant(state, [0, 0], "Gamma.", "t");
    state = typed(state, "Delta four. Beta.\n");
    const [orphan] = unattachedRewrites(state);
    expect(orphan.entry.variants[0].text).toBe("Gamma.");
    const merged = applyReattach(state, orphan.index, [0, 1]);
    const entry = rewriteCards(merged, 0)?.[1].entry;
    expect(entry?.variants.map((variant) => variant.text)).toEqual(["Beta.", "Gamma."]);
    expect(entry?.chosen).toBe(0);
    expect(merged.sidecar.rewrites).toHaveLength(1);
  });

  it("refuses an orphan index that is not an unattached rewrite, and a position with no sentence", () => {
    const state = typed(chosen(), REWRITTEN.replace("If anything, a metal nib made it *worse*.", "Nothing was solved by it."));
    const [orphan] = unattachedRewrites(state);
    expect(() => applyReattach(state, orphan.index + 1, [P4, 0])).toThrow(RangeError);
    expect(() => applyReattach(state, orphan.index, [P4, 7])).toThrow(RangeError);
    expect(() => applyDeleteOrphan(state, orphan.index + 1)).toThrow(RangeError);
  });

  it("deleting the unattached card removes it and touches nothing else", () => {
    const state = typed(chosen(), REWRITTEN.replace("If anything, a metal nib made it *worse*.", "Nothing was solved by it."));
    const [orphan] = unattachedRewrites(state);
    const deleted = applyDeleteOrphan(state, orphan.index);
    expect(deleted.root).toBe(state.root);
    expect(unattachedRewrites(deleted)).toEqual([]);
    expect(deleted.sidecar.rewrites).toEqual([]);
  });
});

describe("entries beside the one an operation touches", () => {
  it("adding to one sentence's entry leaves another sentence's entry as it was", () => {
    let state = applyAddVariant(stateOf("Alpha one. Beta two.\n"), [0, 0], "Alpha.", "t");
    state = applyAddVariant(state, [0, 1], "Beta.", "t");
    const first = state.sidecar.rewrites[0];
    state = applyAddVariant(state, [0, 1], "Beta again.", "t");
    expect(state.sidecar.rewrites[0]).toEqual(first);
    expect(state.sidecar.rewrites[1].variants.map((variant) => variant.text)).toEqual(["Beta.", "Beta again."]);
  });

  it("merging an orphan into one entry leaves another entry as it was", () => {
    let state = applyAddVariant(stateOf("Alpha one. Beta two. Gamma three.\n"), [0, 0], "Alpha.", "t");
    state = applyAddVariant(state, [0, 1], "Beta.", "t");
    state = applyAddVariant(state, [0, 2], "Gamma.", "t");
    state = typed(state, "Alpha one. Beta two. Zeta nine.\n");
    const [orphan] = unattachedRewrites(state);
    const merged = applyReattach(state, orphan.index, [0, 1]);
    expect(merged.sidecar.rewrites.map((entry) => entry.variants.map((variant) => variant.text))).toEqual([
      ["Alpha."],
      ["Beta.", "Gamma."],
    ]);
  });

  it("an unattached heading entry is not an unattached rewrite, and cannot be reattached as one", () => {
    const root = parse("## Old heading\n\nAlpha one.\n");
    const sidecar = attach(emptySidecar(), root).sidecar;
    const withHeading = attach(
      {
        ...sidecar,
        headings: [
          {
            anchor: { kind: "heading", hash: "0000000000000", occurrence: 0, text: "Gone", sectionHash: null, blockHash: null, depth: 2, pos: [0] },
            question: "Why?",
          },
        ],
      },
      root,
    ).sidecar;
    const state = typed({ root, sidecar: withHeading }, "## New heading\n\nAlpha one.\n");
    expect(state.sidecar.orphans.map((orphan) => orphan.list)).toEqual(["headings"]);
    expect(unattachedRewrites(state)).toEqual([]);
    expect(() => applyReattach(state, 0, [1, 0])).toThrow(RangeError);
    expect(() => applyDeleteOrphan(state, 0)).toThrow(RangeError);
  });
});

it("replaceSentence is what Use this writes (the golden is not a second implementation)", () => {
  const state = stateOf(ESSAY);
  const block = blocksOf(state.root).find((one) => one.path.length === 1 && one.path[0] === P4);
  expect(format(replaceSentence(state.root, block?.contentId ?? "", 1, VARIANT_2))).toBe(REWRITTEN);
});
