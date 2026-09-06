import type { Root, RootContent } from "mdast";
import { describe, expect, it } from "vitest";
import { contentHash } from "../src/hash.js";
import { format } from "../src/format.js";
import { parse } from "../src/parse.js";
import { emptySidecar, parseSidecar, type Sidecar } from "../src/sidecar.js";
import {
  canRedo,
  canUndo,
  createUndoStack,
  current,
  endCoalescing,
  push,
  redo,
  undo,
  COALESCE_WINDOW_MS,
  UNDO_CAP,
} from "../src/undo.js";

/** A one-paragraph document; each call parses a fresh tree, so no two are the same object. */
function doc(text: string): Root {
  return parse(`${text}\n`);
}

/** A sidecar holding one rewrite entry whose `chosen` variant is `chosen` (§6.5's "Use this"). */
function sidecarWithChoice(sentence: string, chosen: number | null): Sidecar {
  return parseSidecar({
    version: 1,
    rewrites: [
      {
        anchor: {
          kind: "sentence",
          hash: contentHash(sentence),
          occurrence: 0,
          text: sentence,
          sectionHash: null,
          pos: [0, 0],
        },
        variants: [
          { text: "A quiet start.", createdAt: "2026-09-06T10:00:00Z" },
          { text: "A loud start.", createdAt: "2026-09-06T10:00:01Z" },
        ],
        chosen,
      },
    ],
  });
}

const empty = emptySidecar();

describe("createUndoStack", () => {
  it("seeds the document as it was opened, with nothing to undo or redo", () => {
    const root = doc("The pen was full.");
    const stack = createUndoStack(root, empty, { at: 0 });

    expect(stack.entries).toHaveLength(1);
    expect(current(stack)).toEqual({ root, sidecar: empty });
    expect(canUndo(stack)).toBe(false);
    expect(canRedo(stack)).toBe(false);
    expect(stack.openKey).toBe(null);
  });

  it("defaults to the §6.5 numbers and accepts overrides", () => {
    const plain = createUndoStack(doc("a"), empty, { at: 0 });
    expect(plain.cap).toBe(UNDO_CAP);
    expect(plain.coalesceWindowMs).toBe(COALESCE_WINDOW_MS);
    expect(UNDO_CAP).toBe(500);
    expect(COALESCE_WINDOW_MS).toBe(1000);

    const tuned = createUndoStack(doc("a"), empty, { at: 0, cap: 3, coalesceWindowMs: 50 });
    expect(tuned.cap).toBe(3);
    expect(tuned.coalesceWindowMs).toBe(50);
  });

  it("refuses a cap below one and a negative coalescing window", () => {
    expect(() => createUndoStack(doc("a"), empty, { cap: 0 })).toThrow(RangeError);
    expect(() => createUndoStack(doc("a"), empty, { cap: 1.5 })).toThrow(RangeError);
    expect(() => createUndoStack(doc("a"), empty, { coalesceWindowMs: -1 })).toThrow(RangeError);
    expect(() => createUndoStack(doc("a"), empty, { cap: 1, coalesceWindowMs: 0 })).not.toThrow();
  });
});

describe("coalescing (§6.5: transactions within 1 s of each other merge)", () => {
  it("collapses three 'typing' pushes inside one second into a single undo step", () => {
    const base = doc("The pen");
    let stack = createUndoStack(base, empty, { at: 0 });
    stack = push(stack, doc("The pen w"), empty, { coalesceKey: "typing", at: 100 });
    stack = push(stack, doc("The pen wa"), empty, { coalesceKey: "typing", at: 400 });
    const third = doc("The pen was full.");
    stack = push(stack, third, empty, { coalesceKey: "typing", at: 900 });

    expect(stack.entries).toHaveLength(2);
    expect(current(stack).root).toBe(third);

    stack = undo(stack);
    expect(current(stack).root).toBe(base);
    expect(canUndo(stack)).toBe(false);
  });

  it("keeps the latest snapshot of a merged burst, not the first", () => {
    let stack = createUndoStack(doc("a"), empty, { at: 0 });
    stack = push(stack, doc("ab"), empty, { coalesceKey: "typing", at: 10 });
    stack = push(stack, doc("abc"), empty, { coalesceKey: "typing", at: 20 });

    expect(format(current(stack).root)).toBe("abc\n");
    expect(stack.entries[stack.index].at).toBe(20);
  });

  it("does not coalesce a 'rewrite' push between two 'typing' pushes", () => {
    const base = doc("start");
    const first = doc("first typing");
    const rewritten = doc("rewritten");
    const second = doc("second typing");
    let stack = createUndoStack(base, empty, { at: 0 });
    stack = push(stack, first, empty, { coalesceKey: "typing", at: 100 });
    stack = push(stack, rewritten, empty, { coalesceKey: "rewrite", at: 200 });
    stack = push(stack, second, empty, { coalesceKey: "typing", at: 300 });

    expect(stack.entries).toHaveLength(4);
    expect(current(stack).root).toBe(second);
    stack = undo(stack);
    expect(current(stack).root).toBe(rewritten);
    stack = undo(stack);
    expect(current(stack).root).toBe(first);
    stack = undo(stack);
    expect(current(stack).root).toBe(base);
    expect(canUndo(stack)).toBe(false);
  });

  it("starts a new step when the same key arrives after the window closes", () => {
    let stack = createUndoStack(doc("a"), empty, { at: 0 });
    stack = push(stack, doc("ab"), empty, { coalesceKey: "typing", at: 500 });
    stack = push(stack, doc("abc"), empty, { coalesceKey: "typing", at: 1501 });

    expect(stack.entries).toHaveLength(3);
  });

  it("merges exactly at the window edge and splits one millisecond later", () => {
    let atEdge = createUndoStack(doc("a"), empty, { at: 0 });
    atEdge = push(atEdge, doc("ab"), empty, { coalesceKey: "typing", at: 0 });
    atEdge = push(atEdge, doc("abc"), empty, { coalesceKey: "typing", at: COALESCE_WINDOW_MS });
    expect(atEdge.entries).toHaveLength(2);

    let past = createUndoStack(doc("a"), empty, { at: 0 });
    past = push(past, doc("ab"), empty, { coalesceKey: "typing", at: 0 });
    past = push(past, doc("abc"), empty, { coalesceKey: "typing", at: COALESCE_WINDOW_MS + 1 });
    expect(past.entries).toHaveLength(3);
  });

  it("slides the window, so an unbroken burst stays one step past 1 s in total", () => {
    let stack = createUndoStack(doc("a"), empty, { at: 0 });
    for (const at of [900, 1800, 2700, 3600]) {
      stack = push(stack, doc(`a${at}`), empty, { coalesceKey: "typing", at });
    }

    expect(stack.entries).toHaveLength(2);
    expect(stack.entries[1].at).toBe(3600);
  });

  it("never merges pushes that carry no key, however close together", () => {
    let stack = createUndoStack(doc("a"), empty, { at: 0 });
    stack = push(stack, doc("ab"), empty, { at: 0 });
    stack = push(stack, doc("abc"), empty, { at: 0 });

    expect(stack.entries).toHaveLength(3);
    expect(stack.openKey).toBe(null);
  });

  it("does not let a keyed push merge into an entry pushed without a key", () => {
    let stack = createUndoStack(doc("a"), empty, { at: 0 });
    stack = push(stack, doc("ab"), empty, { at: 0 });
    stack = push(stack, doc("abc"), empty, { coalesceKey: "typing", at: 1 });

    expect(stack.entries).toHaveLength(3);
  });

  it("does not merge into an entry pushed with a different key at the same instant", () => {
    let stack = createUndoStack(doc("a"), empty, { at: 0 });
    stack = push(stack, doc("ab"), empty, { coalesceKey: "source", at: 0 });
    stack = push(stack, doc("abc"), empty, { coalesceKey: "typing", at: 0 });

    expect(stack.entries).toHaveLength(3);
  });

  it("starts a new step rather than merging when the clock goes backwards", () => {
    let stack = createUndoStack(doc("a"), empty, { at: 1000 });
    stack = push(stack, doc("ab"), empty, { coalesceKey: "typing", at: 1000 });
    stack = push(stack, doc("abc"), empty, { coalesceKey: "typing", at: 900 });

    expect(stack.entries).toHaveLength(3);
  });

  it("closes the group on a toggle: the edit after it is its own step (§6.5)", () => {
    let stack = createUndoStack(doc("a"), empty, { at: 0 });
    stack = push(stack, doc("ab"), empty, { coalesceKey: "typing", at: 10 });
    const toggled = endCoalescing(stack);
    expect(toggled.entries).toHaveLength(2);
    expect(toggled.openKey).toBe(null);

    const after = push(toggled, doc("abc"), empty, { coalesceKey: "typing", at: 20 });
    expect(after.entries).toHaveLength(3);
  });

  it("leaves the stack untouched when there is no group to close", () => {
    const stack = createUndoStack(doc("a"), empty, { at: 0 });
    expect(endCoalescing(stack)).toBe(stack);
  });

  it("closes the group on undo and on redo, so a later push cannot reopen it", () => {
    let stack = createUndoStack(doc("a"), empty, { at: 0 });
    stack = push(stack, doc("ab"), empty, { coalesceKey: "typing", at: 10 });
    stack = undo(stack);
    expect(stack.openKey).toBe(null);
    stack = redo(stack);
    expect(stack.openKey).toBe(null);

    stack = push(stack, doc("abc"), empty, { coalesceKey: "typing", at: 20 });
    expect(stack.entries).toHaveLength(3);
  });
});

describe("undo and redo", () => {
  it("restores a deep-equal root and sidecar, and the same objects that were pushed", () => {
    const baseRoot = doc("A **bold** start. And *emphasis* here.");
    const baseSidecar = sidecarWithChoice("A bold start.", null);
    const nextRoot = doc("A quiet start. And *emphasis* here.");
    const nextSidecar = sidecarWithChoice("A bold start.", 0);

    let stack = createUndoStack(baseRoot, baseSidecar, { at: 0 });
    stack = push(stack, nextRoot, nextSidecar, { coalesceKey: "rewrite", at: 100 });

    const undone = undo(stack);
    expect(current(undone).root).toEqual(baseRoot);
    expect(current(undone).sidecar).toEqual(baseSidecar);
    expect(current(undone).root).toBe(baseRoot);
    expect(current(undone).sidecar).toBe(baseSidecar);

    const redone = redo(undone);
    expect(current(redone).root).toEqual(nextRoot);
    expect(current(redone).sidecar).toEqual(nextSidecar);
    expect(current(redone).root).toBe(nextRoot);
    expect(current(redone).sidecar).toBe(nextSidecar);
  });

  it('restores the sentence and the sidecar\'s chosen field together (§6.5, "Use this")', () => {
    const before = sidecarWithChoice("A bold start.", null);
    const after = sidecarWithChoice("A bold start.", 0);
    let stack = createUndoStack(doc("A **bold** start."), before, { at: 0 });
    stack = push(stack, doc("A quiet start."), after, { coalesceKey: "rewrite", at: 10 });

    expect(format(current(stack).root)).toBe("A quiet start.\n");
    expect(current(stack).sidecar.rewrites[0].chosen).toBe(0);

    stack = undo(stack);
    expect(format(current(stack).root)).toBe("A **bold** start.\n");
    expect(current(stack).sidecar.rewrites[0].chosen).toBe(null);

    stack = redo(stack);
    expect(format(current(stack).root)).toBe("A quiet start.\n");
    expect(current(stack).sidecar.rewrites[0].chosen).toBe(0);
  });

  it("walks a whole history back to the seed and forward again", () => {
    const roots = [doc("s0"), doc("s1"), doc("s2"), doc("s3")];
    let stack = createUndoStack(roots[0], empty, { at: 0 });
    for (let i = 1; i < roots.length; i += 1) {
      stack = push(stack, roots[i], empty, { at: i });
    }

    for (let i = roots.length - 2; i >= 0; i -= 1) {
      stack = undo(stack);
      expect(current(stack).root).toBe(roots[i]);
    }
    expect(canUndo(stack)).toBe(false);

    for (let i = 1; i < roots.length; i += 1) {
      stack = redo(stack);
      expect(current(stack).root).toBe(roots[i]);
    }
    expect(canRedo(stack)).toBe(false);
  });

  it("is a no-op at either end and never loses history", () => {
    const base = doc("a");
    const next = doc("ab");
    let stack = createUndoStack(base, empty, { at: 0 });
    stack = push(stack, next, empty, { at: 1 });

    const atTop = redo(stack);
    expect(atTop).toBe(stack);
    expect(current(atTop).root).toBe(next);

    const atBottom = undo(undo(undo(stack)));
    expect(current(atBottom).root).toBe(base);
    expect(atBottom.entries).toHaveLength(2);
    expect(canRedo(atBottom)).toBe(true);
  });

  it("reports canUndo and canRedo for every position", () => {
    let stack = createUndoStack(doc("a"), empty, { at: 0 });
    expect([canUndo(stack), canRedo(stack)]).toEqual([false, false]);
    stack = push(stack, doc("ab"), empty, { at: 1 });
    expect([canUndo(stack), canRedo(stack)]).toEqual([true, false]);
    stack = undo(stack);
    expect([canUndo(stack), canRedo(stack)]).toEqual([false, true]);
  });

  it("drops the redo branch when a new mutation is pushed after an undo", () => {
    const base = doc("a");
    const abandoned = doc("abandoned");
    const branch = doc("branch");
    let stack = createUndoStack(base, empty, { at: 0 });
    stack = push(stack, abandoned, empty, { at: 1 });
    stack = undo(stack);
    stack = push(stack, branch, empty, { at: 2 });

    expect(canRedo(stack)).toBe(false);
    expect(stack.entries).toHaveLength(2);
    expect(stack.entries.map((entry) => entry.state.root)).toEqual([base, branch]);
  });

  it("never mutates the stack it is given", () => {
    const stack = createUndoStack(doc("a"), empty, { at: 0 });
    const before = structuredClone({ index: stack.index, length: stack.entries.length });

    push(stack, doc("ab"), empty, { at: 1 });
    undo(stack);
    redo(stack);
    endCoalescing(stack);

    expect({ index: stack.index, length: stack.entries.length }).toEqual(before);
  });
});

describe("cap and structural sharing", () => {
  it("retains the last 500 of 600 pushes", () => {
    const roots = Array.from({ length: 600 }, (_, i) => doc(`paragraph ${i}`));
    let stack = createUndoStack(doc("seed"), empty, { at: 0 });
    roots.forEach((root, i) => {
      stack = push(stack, root, empty, { at: i + 1 });
    });

    expect(stack.entries).toHaveLength(UNDO_CAP);
    expect(stack.index).toBe(UNDO_CAP - 1);
    expect(stack.entries.map((entry) => entry.state.root)).toEqual(roots.slice(600 - UNDO_CAP));
    expect(current(stack).root).toBe(roots[599]);

    // The oldest retained snapshot is push 101; the seed and pushes 1..100 are gone.
    let walked = stack;
    while (canUndo(walked)) walked = undo(walked);
    expect(current(walked).root).toBe(roots[100]);
    expect(format(current(walked).root)).toBe("paragraph 100\n");
  });

  it("drops the oldest first at any cap, keeping the newest snapshot present", () => {
    const roots = [doc("s1"), doc("s2"), doc("s3"), doc("s4")];
    let stack = createUndoStack(doc("seed"), empty, { at: 0, cap: 3 });
    roots.forEach((root, i) => {
      stack = push(stack, root, empty, { at: i + 1 });
    });

    expect(stack.entries.map((entry) => entry.state.root)).toEqual(roots.slice(1));
    expect(current(stack).root).toBe(roots[3]);
    expect(stack.index).toBe(2);
  });

  it("stores snapshots by reference, so unchanged subtrees are shared, not copied", () => {
    const base = doc("First paragraph.\n\nSecond paragraph.");
    const sharedFirst: RootContent = base.children[0];
    const edited: Root = {
      ...base,
      children: [sharedFirst, parse("Second paragraph, revised.\n").children[0]],
    };

    let stack = createUndoStack(base, empty, { at: 0 });
    stack = push(stack, edited, empty, { at: 1 });

    expect(stack.entries[0].state.root).toBe(base);
    expect(stack.entries[1].state.root).toBe(edited);
    expect(stack.entries[1].state.root.children[0]).toBe(stack.entries[0].state.root.children[0]);
    expect(stack.entries[1].state.root.children[1]).not.toBe(
      stack.entries[0].state.root.children[1],
    );
  });

  it("keeps snapshot identity through coalescing, trimming, undo and redo", () => {
    const shared: RootContent = parse("A shared paragraph.\n").children[0];
    const roots = Array.from({ length: 20 }, (_, i) => {
      const tail = parse(`Edit ${i}.\n`).children[0];
      return { type: "root", children: [shared, tail] } as Root;
    });

    let stack = createUndoStack(roots[0], empty, { at: 0, cap: 5 });
    roots.slice(1).forEach((root, i) => {
      stack = push(stack, root, empty, { coalesceKey: "typing", at: (i + 1) * 5_000 });
    });

    expect(stack.entries).toHaveLength(5);
    for (const entry of stack.entries) {
      expect(entry.state.root.children[0]).toBe(shared);
    }

    let walked = undo(undo(stack));
    expect(current(walked).root).toBe(roots[17]);
    walked = redo(walked);
    expect(current(walked).root).toBe(roots[18]);
    expect(current(walked).root.children[0]).toBe(shared);
  });

  it("holds a cap of one snapshot with nothing to undo", () => {
    let stack = createUndoStack(doc("seed"), empty, { at: 0, cap: 1 });
    const only = doc("only");
    stack = push(stack, only, empty, { at: 1 });

    expect(stack.entries).toHaveLength(1);
    expect(stack.index).toBe(0);
    expect(canUndo(stack)).toBe(false);
    expect(current(stack).root).toBe(only);
  });
});

describe("default clock", () => {
  it("stamps a push with the wall clock when no time is injected", () => {
    const before = Date.now();
    let stack = createUndoStack(doc("a"), empty);
    stack = push(stack, doc("ab"), empty, { coalesceKey: "typing" });
    const after = Date.now();

    expect(stack.entries[0].at).toBeGreaterThanOrEqual(before);
    expect(stack.entries[1].at).toBeLessThanOrEqual(after);
    expect(stack.entries[1].at).toBeGreaterThanOrEqual(stack.entries[0].at);
  });

  it("coalesces two default-clock pushes with the same key (they land inside 1 s)", () => {
    let stack = createUndoStack(doc("a"), empty);
    stack = push(stack, doc("ab"), empty, { coalesceKey: "typing" });
    stack = push(stack, doc("abc"), empty, { coalesceKey: "typing" });

    expect(stack.entries).toHaveLength(2);
  });

  it("takes an empty options object and pushes with no key", () => {
    let stack = createUndoStack(doc("a"), empty, { at: 0 });
    stack = push(stack, doc("ab"), empty);
    stack = push(stack, doc("abc"), empty);

    expect(stack.entries).toHaveLength(3);
    expect(stack.entries[1].coalesceKey).toBe(null);
  });
});
