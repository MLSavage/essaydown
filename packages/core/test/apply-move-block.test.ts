import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Root } from "mdast";
import { describe, expect, it } from "vitest";
import { format } from "../src/format.js";
import { parse } from "../src/parse.js";
import {
  applyMoveBlock,
  candidatesOf,
  parseSidecar,
  type DocumentState,
  type Sidecar,
} from "../src/sidecar.js";

/**
 * `applyMoveBlock` (task 3.1): `moveBlock` with the sidecar carried along, the mode mutation the
 * document store's `dispatch` is driven with by the shell e2e (`window.__essaydown`). The sidecar
 * half is `applyMoveSection`'s mechanism (one shared helper), so these cases pin the block-shaped
 * permutation: the moved block's anchors travel with it, the blocks it shifted are re-anchored at
 * their new index, and identical blocks keep their own entries (§6.2's in-app duplicate rule).
 */

const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));
const index = JSON.parse(readFileSync(`${FIXTURES}/index.json`, "utf8")) as Record<string, unknown>;
const AT = "2026-10-05T00:00:00Z";

/** A sidecar holding one paragraph-scoped coach entry per paragraph candidate of `root`, each
 * question naming the paragraph it was asked of, so a test can read where each one went. */
function coachOnEveryParagraph(root: Root): Sidecar {
  return parseSidecar({
    version: 1,
    coach: candidatesOf(root)
      .filter((one) => one.kind === "paragraph")
      .map((one, n) => ({
        anchor: { ...one, pos: [...one.pos] },
        scope: "paragraph",
        question: `asked of paragraph ${n}: ${one.text}`,
        askedAt: AT,
      })),
  });
}

function questionAt(sidecar: Sidecar, pos: readonly number[]): string | undefined {
  return sidecar.coach.find(
    (entry) => entry.anchor.pos.length === pos.length && entry.anchor.pos.every((v, i) => v === pos[i]),
  )?.question;
}

describe("applyMoveBlock", () => {
  it("moves the block and carries the moved block's anchor and every shifted block's anchor", () => {
    const root = parse("First block.\n\nSecond block.\n\nThird block.\n");
    const state: DocumentState = { root, sidecar: coachOnEveryParagraph(root) };
    expect(questionAt(state.sidecar, [2])).toBe("asked of paragraph 2: Third block.");

    const next = applyMoveBlock(state, 2, 0);

    expect(format(next.root)).toBe("Third block.\n\nFirst block.\n\nSecond block.\n");
    expect(questionAt(next.sidecar, [0])).toBe("asked of paragraph 2: Third block.");
    expect(questionAt(next.sidecar, [1])).toBe("asked of paragraph 0: First block.");
    expect(questionAt(next.sidecar, [2])).toBe("asked of paragraph 1: Second block.");
    expect(next.sidecar.orphans).toEqual([]);
  });

  it("keeps each of two byte-identical blocks' entries on its logical block (§6.2, in-app)", () => {
    const root = parse("Same words.\n\nIn between.\n\nSame words.\n");
    const state: DocumentState = { root, sidecar: coachOnEveryParagraph(root) };

    const next = applyMoveBlock(state, 0, 2);

    expect(format(next.root)).toBe("In between.\n\nSame words.\n\nSame words.\n");
    // The first twin moved to the end; the second twin shifted up. Only the sidecar can tell.
    expect(questionAt(next.sidecar, [2])).toBe("asked of paragraph 0: Same words.");
    expect(questionAt(next.sidecar, [1])).toBe("asked of paragraph 2: Same words.");
    expect(questionAt(next.sidecar, [0])).toBe("asked of paragraph 1: In between.");
  });

  it("does not touch the state it was given", () => {
    const root = parse("One.\n\nTwo.\n");
    const state: DocumentState = { root, sidecar: coachOnEveryParagraph(root) };
    const before = structuredClone(state);
    applyMoveBlock(state, 0, 1);
    expect(state).toEqual(before);
  });

  it("throws moveBlock's own RangeError for an index outside the document", () => {
    const root = parse("One.\n\nTwo.\n");
    const state: DocumentState = { root, sidecar: coachOnEveryParagraph(root) };
    expect(() => applyMoveBlock(state, 0, 2)).toThrow(RangeError);
    expect(() => applyMoveBlock(state, -1, 0)).toThrow(RangeError);
  });

  it("applyMoveBlock(state, i, i) re-serialises every fixture byte-identically and keeps its sidecar, for every top-level index", () => {
    const names = Object.keys(index).sort();
    let moves = 0;
    for (const name of names) {
      const root = parse(readFileSync(`${FIXTURES}/${name}`, "utf8"));
      const state: DocumentState = { root, sidecar: coachOnEveryParagraph(root) };
      const before = format(root);
      for (let i = 0; i < root.children.length; i += 1) {
        const next = applyMoveBlock(state, i, i);
        expect(format(next.root), `${name} at ${i}`).toBe(before);
        expect(next.sidecar, `${name} at ${i}`).toEqual(state.sidecar);
        moves += 1;
      }
    }
    expect(moves).toBeGreaterThan(0);
  });

  it("a genuine move is neither byte-identical nor sidecar-identical, so the identity leg is not vacuous", () => {
    const root = parse(readFileSync(`${FIXTURES}/essay-fixture.md`, "utf8"));
    const state: DocumentState = { root, sidecar: coachOnEveryParagraph(root) };
    const last = root.children.length - 1;
    const next = applyMoveBlock(state, 0, last);
    expect(format(next.root)).not.toBe(format(root));
    expect(next.sidecar).not.toEqual(state.sidecar);
  });
});
