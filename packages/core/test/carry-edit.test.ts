import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Root } from "mdast";
import { format } from "../src/format.js";
import { parse } from "../src/parse.js";
import {
  anchorOf,
  attach,
  candidatesOf,
  carryEdit,
  parseSidecar,
  type Anchor,
  type DocumentState,
  type EditRegion,
  type Sidecar,
  type TopLevelEdit,
} from "../src/sidecar.js";

/**
 * Task 4.9: `carryEdit`, the core half of §6.2's "in-app operations update anchors live" for
 * typing. The editor half — the ProseMirror runs and mapping that answer `regions` and `mapBlock` —
 * and the reproduction through the rendered view are packages/editor/test/anchor-typing.test.ts.
 * Here the edit is written by hand, so each rule of the doc comment is one case.
 */

const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));
const FIXTURE_NAMES = Object.keys(
  JSON.parse(readFileSync(`${FIXTURES}/index.json`, "utf8")) as Record<string, unknown>,
).sort();
const fixture = (name: string): string => readFileSync(`${FIXTURES}/${name}`, "utf8");

const AT = "2026-10-07T00:00:00Z";

function sentence(root: Root, text: string, occurrence: number): Anchor {
  const found = candidatesOf(root).find(
    (one) => one.kind === "sentence" && one.text === text && one.occurrence === occurrence,
  );
  if (found === undefined) throw new Error(`no sentence ${text}#${occurrence}`);
  return anchorOf(found);
}

function rewrites(...anchors: Anchor[]): Sidecar {
  return parseSidecar({
    version: 1,
    rewrites: anchors.map((anchor, index) => ({
      anchor,
      variants: [{ text: `variant ${index}`, createdAt: AT }],
    })),
  });
}

/** An edit from its runs and its mapping, recording what it is asked. */
function edit(
  regions: readonly EditRegion[],
  mapBlock: (index: number) => number | null,
  mapOffset: TopLevelEdit["mapOffset"] = () => null,
): TopLevelEdit & { asked: number[]; regionsAsked: number; nearestFor: Anchor[]; offsetsAsked: number[][] } {
  const recorder = {
    asked: [] as number[],
    offsetsAsked: [] as number[][],
    regionsAsked: 0,
    nearestFor: [] as Anchor[],
    regions: () => {
      recorder.regionsAsked += 1;
      return regions;
    },
    mapBlock: (index: number) => {
      recorder.asked.push(index);
      return mapBlock(index);
    },
    mapOffset: (index: number, offset: number) => {
      recorder.offsetsAsked.push([index, offset]);
      return mapOffset(index, offset);
    },
    nearest: (anchor: Anchor) => {
      recorder.nearestFor.push(anchor);
    },
  };
  return recorder;
}

/** The default segmenter, counting its calls — one per paragraph segmented. */
function countingSegment(): { calls: number; segment: (text: string) => readonly number[] } {
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  const counter = {
    calls: 0,
    segment: (text: string) => {
      counter.calls += 1;
      return [...segmenter.segment(text)].map((one) => one.index);
    },
  };
  return counter;
}

/** A mapping that shifts every block from `at` on by `by`. */
function shiftFrom(at: number, by: number): (index: number) => number {
  return (index) => (index < at ? index : index + by);
}

const TWINS = "Same line here.\n\nMiddle paragraph.\n\nSame line here.\n";
/** {@link TWINS} with the duplicate typed above both: one run, a block inserted at 0. */
const TYPED = `Same line here.\n\n${TWINS}`;
const TYPED_ABOVE: EditRegion[] = [{ before: [], after: [0] }];

describe("carryEdit (task 4.9; PRD §6.2, in-app operations update anchors live)", () => {
  it("an empty sidecar is returned as it is, and the edit is never asked", () => {
    const sidecar = parseSidecar({ version: 1 });
    const typed = edit(TYPED_ABOVE, shiftFrom(0, 1));
    expect(carryEdit({ root: parse(TWINS), sidecar }, parse(TYPED), typed)).toBe(sidecar);
    expect(typed.regionsAsked).toBe(0);
    expect(typed.asked).toEqual([]);
  });

  it("a run that creates an item of an anchored key carries the entry, rebuilt at its new rank", () => {
    const before = parse(TWINS);
    const sidecar = rewrites(sentence(before, "Same line here.", 1));
    const out = carryEdit({ root: before, sidecar }, parse(TYPED), edit(TYPED_ABOVE, shiftFrom(0, 1)));

    expect(out).not.toBe(sidecar);
    expect(out.rewrites[0].anchor).toEqual(sentence(parse(TYPED), "Same line here.", 2));
    expect(out.rewrites[0].anchor.pos).toEqual([3, 0]);
    expect(out.rewrites[0].variants).toEqual(sidecar.rewrites[0].variants);
    expect(out.orphans).toEqual([]);
  });

  it("a run that destroys an item of an anchored key carries the entry down a rank", () => {
    const before = parse(TYPED);
    const sidecar = rewrites(sentence(before, "Same line here.", 2));
    const out = carryEdit(
      { root: before, sidecar },
      parse(TWINS),
      edit([{ before: [0], after: [] }], (index) => (index === 0 ? null : index - 1)),
    );
    expect(out.rewrites[0].anchor).toEqual(sentence(parse(TWINS), "Same line here.", 1));
  });

  it("carries headings and coach entries as well as rewrites", () => {
    const DOC = "## Twin\n\nSame line here.\n\n## Twin\n\nSame line here.\n";
    const before = parse(DOC);
    const candidates = candidatesOf(before);
    const heading = anchorOf(candidates.filter((one) => one.kind === "heading")[1]);
    const paragraph = anchorOf(candidates.filter((one) => one.kind === "paragraph")[1]);
    const sidecar = parseSidecar({
      version: 1,
      headings: [{ anchor: heading, question: "second heading" }],
      coach: [{ anchor: paragraph, scope: "paragraph", question: "second paragraph", askedAt: AT }],
    });
    const after = parse(`## Twin\n\nSame line here.\n\n${DOC}`);
    const out = carryEdit(
      { root: before, sidecar },
      after,
      edit([{ before: [], after: [0, 1] }], shiftFrom(0, 2)),
    );

    expect(out.headings[0].anchor.pos).toEqual([4]);
    expect(out.headings[0].anchor.occurrence).toBe(2);
    expect(out.coach[0].anchor.pos).toEqual([5]);
    expect(out.coach[0].anchor.occurrence).toBe(2);
  });

  it("runs that create no item of an anchored key return the sidecar itself, the mapping never asked", () => {
    // A paragraph typed above that duplicates nothing: every position shifts, no rank does.
    const before = parse(TWINS);
    const sidecar = rewrites(sentence(before, "Same line here.", 0), sentence(before, "Same line here.", 1));
    const typed = edit(TYPED_ABOVE, shiftFrom(0, 1));
    const counter = countingSegment();
    const after = parse(`Unrelated.\n\n${TWINS}`);
    expect(carryEdit({ root: before, sidecar }, after, typed, counter)).toBe(sidecar);
    expect(typed.asked).toEqual([]);
    // Only the run's one paragraph was segmented, never either whole document.
    expect(counter.calls).toBe(1);
  });

  it("a run whose count of an anchored key is unchanged leaves that key's entries, the mapping never asked", () => {
    // The second twin's paragraph gains a sentence: the run holds one twin before and after.
    const before = parse(TWINS);
    const sidecar = rewrites(sentence(before, "Same line here.", 1));
    const typed = edit([{ before: [2], after: [2] }], (index) => index);
    const after = parse(TWINS.replace(/here\.\n$/u, "here. Added after.\n"));
    const counter = countingSegment();
    expect(carryEdit({ root: before, sidecar }, after, typed, counter)).toBe(sidecar);
    expect(typed.asked).toEqual([]);
    // The run's paragraph before and after, never either whole document.
    expect(counter.calls).toBe(2);
  });

  it("counts are compared run by run: a twin removed in one run and typed in another is a change", () => {
    // Twin 0 deleted above the middle paragraph and a twin typed below it, in one edit: the
    // document holds two twins before and after, but per run the counts moved, so the key is
    // dirty and the mapping is asked about the anchored item's block.
    const DOC = "Same line here.\n\nMiddle paragraph.\n\nOther.\n\nSame line here.\n";
    const before = parse(DOC);
    const after = parse("Middle paragraph.\n\nSame line here.\n\nOther.\n\nSame line here.\n");
    const runs: EditRegion[] = [
      { before: [0], after: [] },
      { before: [], after: [1] },
    ];
    const map = (index: number): number | null => (index === 0 ? null : index === 1 ? 0 : index);

    // The anchored second twin is still the second in the document: asked, and kept.
    const second = rewrites(sentence(before, "Same line here.", 1));
    const typed = edit(runs, map);
    expect(carryEdit({ root: before, sidecar: second }, after, typed)).toBe(second);
    expect(typed.asked).toEqual([3]);

    // Merged into one count, the key would look unchanged and the mapping never be asked.
    const merged = edit([{ before: [0], after: [1] }], map);
    expect(carryEdit({ root: before, sidecar: second }, after, merged)).toBe(second);
    expect(merged.asked).toEqual([]);
  });

  it("only dirty keys' entries are carried: an entry of an unchanged key stays, whatever the mapping says", () => {
    // One run in which key B gains an item (B dirty) and key A keeps its count. The mapping is
    // hand-written to send A's block elsewhere: were A carried, it would change rank.
    const before = parse("A one.\n\nA one. B two.\n");
    const a = sentence(before, "A one.", 1);
    const b = sentence(before, "B two.", 0);
    const sidecar = rewrites(a, b);
    const after = parse("A one. B two.\n\nA one. B two.\n");
    const typed = edit([{ before: [0, 1], after: [0, 1] }], () => 0);
    const out = carryEdit({ root: before, sidecar }, after, typed);
    expect(out.rewrites[0].anchor).toEqual(a);
    expect(typed.asked).toEqual([1]);
  });

  it("a dirty entry goes to the same-key candidate nearest its old place in its block, ties to the lowest index", () => {
    const before = parse("Same line here. Other. Same line here.\n");
    const sidecar = rewrites(sentence(before, "Same line here.", 0));
    // The anchored paragraph edited into two twins (sentence 1 removed), with a twin typed above.
    const after = parse("Same line here.\n\nSame line here. Same line here.\n");
    const run: EditRegion[] = [{ before: [0], after: [0, 1] }];
    const out = carryEdit({ root: before, sidecar }, after, edit(run, () => 1));
    expect(out.rewrites[0].anchor.pos).toEqual([1, 0]);
    expect(out.rewrites[0].anchor.occurrence).toBe(1);

    // From old sentence index 1, new indices 0 and 2 are equally near: the lower wins.
    const middle = parse("Other. Same line here. Other.\n");
    const atMiddle = rewrites(sentence(middle, "Same line here.", 0));
    const spread = parse("Same line here.\n\nSame line here. Other. Same line here.\n");
    const tied = carryEdit({ root: middle, sidecar: atMiddle }, spread, edit(run, () => 1));
    expect(tied.rewrites[0].anchor.pos).toEqual([1, 0]);
  });

  it("a dirty entry whose block no longer holds its text is left for the next save", () => {
    // The anchored twin rewritten while a twin is typed above: its key is dirty, its text gone.
    const before = parse(TWINS);
    const sidecar = rewrites(sentence(before, "Same line here.", 1));
    const after = parse(`Same line here.\n\n${TWINS.replace(/Same line here\.\n$/u, "Changed line.\n")}`);
    const typed = edit(
      [
        { before: [], after: [0] },
        { before: [2], after: [3] },
      ],
      shiftFrom(0, 1),
    );
    expect(carryEdit({ root: before, sidecar }, after, typed)).toBe(sidecar);
    expect(typed.asked).toEqual([2]);
  });

  it("a dirty entry mapped where the document has no candidate of its kind is left", () => {
    const before = parse(TWINS);
    const sidecar = rewrites(sentence(before, "Same line here.", 1));
    expect(carryEdit({ root: before, sidecar }, parse(TYPED), edit(TYPED_ABOVE, () => 9))).toBe(sidecar);
  });

  it("a dirty entry whose block the edit removed (mapBlock null) is left", () => {
    const before = parse(TWINS);
    const sidecar = rewrites(sentence(before, "Same line here.", 1));
    expect(carryEdit({ root: before, sidecar }, parse(TYPED), edit(TYPED_ABOVE, () => null))).toBe(
      sidecar,
    );
  });

  it("a dirty entry that only steps 3–5 resolve is left as it was (no exact item to carry)", () => {
    const before = parse(TWINS);
    const exact = sentence(before, "Same line here.", 1);
    const stepThree: Anchor = { ...exact, occurrence: 7 };
    const stepFour: Anchor = {
      ...sentence(before, "Middle paragraph.", 0),
      hash: "0000000000000",
      text: "Middle paragraphs.",
    };
    const stepFive: Anchor = { ...exact, hash: "zzzzzzzzzzzzz", text: "Nothing like it at all." };
    const sidecar = rewrites(stepThree, stepFour, stepFive);
    expect(attach(sidecar, before).resolutions.map((one) => one.step)).toEqual([3, 4, 5]);

    // The run creates a twin, so stepThree's key is dirty; it is resolved, by step 3, and left.
    const typed = edit(TYPED_ABOVE, shiftFrom(0, 1));
    expect(carryEdit({ root: before, sidecar }, parse(TYPED), typed)).toBe(sidecar);
    expect(typed.asked).toEqual([]);
  });

  it("an entry whose dirty key leaves its rank alone is not rebuilt", () => {
    // A twin typed *below* both: the key is dirty, the anchored first twin keeps occurrence 0.
    const before = parse(TWINS);
    const sidecar = rewrites(sentence(before, "Same line here.", 0));
    const typed = edit([{ before: [], after: [3] }], (index) => index);
    expect(carryEdit({ root: before, sidecar }, parse(`${TWINS}\nSame line here.\n`), typed)).toBe(sidecar);
    expect(typed.asked).toEqual([0]);
  });

  it("identity: no runs, every fixture anchored everywhere, returns each sidecar itself", () => {
    let checked = 0;
    for (const name of FIXTURE_NAMES) {
      const root = parse(fixture(name));
      const candidates = candidatesOf(root);
      if (candidates.length === 0) continue;
      const sidecar = parseSidecar({
        version: 1,
        headings: candidates
          .filter((one) => one.kind === "heading")
          .map((one) => ({ anchor: anchorOf(one), question: "q" })),
        rewrites: candidates
          .filter((one) => one.kind === "sentence")
          .map((one) => ({ anchor: anchorOf(one), variants: [] })),
        coach: candidates
          .filter((one) => one.kind === "paragraph")
          .map((one) => ({ anchor: anchorOf(one), scope: "paragraph", question: "q", askedAt: AT })),
      });
      const state: DocumentState = { root, sidecar };
      expect(carryEdit(state, root, edit([], (index) => index)), name).toBe(sidecar);
      expect(format(root), name).toBe(format(parse(fixture(name))));
      checked += 1;
    }
    expect(checked).toBe(
      FIXTURE_NAMES.filter((name) => candidatesOf(parse(fixture(name))).length > 0).length,
    );
    expect(checked).toBeGreaterThan(0);
  });
});

describe("carryEdit follows a sentence by its first character (task 4.26; DECISIONS #review-4-r0 U2)", () => {
  const BOTH = "Same line here. Same line here.\n";
  /** {@link BOTH} with the twin typed at the paragraph's start: one run, the paragraph replaced. */
  const THREE = "Same line here. Same line here. Same line here.\n";
  const IN_PLACE: EditRegion[] = [{ before: [0], after: [0] }];
  /** The second sentence's first character (offset 16), moved by the 16 characters typed before it. */
  const typedBefore: TopLevelEdit["mapOffset"] = (index, offset) => ({ index, offset: offset + 16 });

  it("the item rule: the sentence of its key holding the mapped start, not the twin at its old index", () => {
    const before = parse(BOTH);
    const sidecar = rewrites(sentence(before, "Same line here.", 1));
    const typed = edit(IN_PLACE, (index) => index, typedBefore);
    const out = carryEdit({ root: before, sidecar }, parse(THREE), typed);
    expect(out.rewrites[0].anchor.pos).toEqual([0, 2]);
    expect(out.rewrites[0].anchor.occurrence).toBe(2);
    expect(typed.offsetsAsked).toEqual([[0, 16]]);
    expect(typed.nearestFor).toEqual([]);
  });

  it("the named fallback: a start mapOffset cannot place (deleted) goes nearest-by-index and is reported", () => {
    const before = parse(BOTH);
    const anchor = sentence(before, "Same line here.", 1);
    const deleted = edit(IN_PLACE, (index) => index);
    const out = carryEdit({ root: before, sidecar: rewrites(anchor) }, parse(THREE), deleted);
    expect(out.rewrites[0].anchor.pos).toEqual([0, 1]);
    expect(deleted.nearestFor).toEqual([anchor]);
  });

  it("the fallback reports nothing when it finds no candidate either", () => {
    const before = parse(BOTH);
    const sidecar = rewrites(sentence(before, "Same line here.", 1));
    const gone = edit(IN_PLACE, (index) => index);
    expect(carryEdit({ root: before, sidecar }, parse("Other words.\n"), gone)).toBe(sidecar);
    expect(gone.nearestFor).toEqual([]);
  });

  it("a mapped start held by a sentence of another key leaves the entry as it was", () => {
    const before = parse(BOTH);
    const sidecar = rewrites(sentence(before, "Same line here.", 1));
    const typed = edit(IN_PLACE, (index) => index, (index) => ({ index, offset: 0 }));
    expect(carryEdit({ root: before, sidecar }, parse("Other words. Same line here.\n"), typed)).toBe(sidecar);
    expect(typed.nearestFor).toEqual([]);
  });

  it("a mapped start no sentence holds (past the text, or in a child with no sentences) leaves the entry", () => {
    const before = parse(BOTH);
    const sidecar = rewrites(sentence(before, "Same line here.", 1));
    const past = edit(IN_PLACE, (index) => index, (index) => ({ index, offset: 999 }));
    expect(carryEdit({ root: before, sidecar }, parse(THREE), past)).toBe(sidecar);
    const heading = edit(
      [{ before: [0], after: [0, 1] }],
      (index) => index,
      () => ({ index: 0, offset: 0 }),
    );
    expect(carryEdit({ root: before, sidecar }, parse(`# Same line here.\n\n${THREE}`), heading)).toBe(
      sidecar,
    );
  });

  it("a heading or paragraph entry is carried by its child alone: mapOffset is never asked", () => {
    const before = parse(TWINS);
    const sidecar = parseSidecar({
      version: 1,
      coach: [
        {
          anchor: anchorOf(
            candidatesOf(before).find((one) => one.kind === "paragraph" && one.pos[0] === 2) as never,
          ),
          scope: "paragraph",
          question: "q",
          askedAt: AT,
        },
      ],
    });
    const typed = edit(TYPED_ABOVE, shiftFrom(0, 1), typedBefore);
    const out = carryEdit({ root: before, sidecar }, parse(TYPED), typed);
    expect(out.coach[0].anchor.pos).toEqual([3]);
    expect(typed.offsetsAsked).toEqual([]);
    expect(typed.nearestFor).toEqual([]);
  });
});
