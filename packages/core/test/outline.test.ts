import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Root } from "mdast";
import { describe, expect, it } from "vitest";
import { sectionsOf } from "../src/blocks.js";
import { format } from "../src/format.js";
import { parse } from "../src/parse.js";
import {
  applyNewQuestion,
  applyOutlineDrop,
  applySetQuestion,
  applySetTopicQuestion,
  NEW_QUESTION_DEPTH,
  outlineDrop,
  outlineOf,
  topicQuestionEditable,
} from "../src/outline.js";
import { attach, emptySidecar, readFrontMatter, type DocumentState } from "../src/sidecar.js";

/**
 * Outline mode's document operations (task 3.2): the rows, the question and topic fields, "New
 * question", and the drag. Each mutation is checked for both halves — what it does to the Markdown
 * (usually nothing, by reference) and what it does to the sidecar — and for its no-op argument
 * over the whole corpus (CLAUDE.md's identity rule).
 */

const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));
const index = JSON.parse(readFileSync(`${FIXTURES}/index.json`, "utf8")) as Record<string, unknown>;
const names = Object.keys(index).sort();

function fixture(name: string): string {
  return readFileSync(`${FIXTURES}/${name}`, "utf8");
}

function stateOf(markdown: string): DocumentState {
  const root = parse(markdown);
  return { root, sidecar: attach(emptySidecar(), root).sidecar };
}

function rows(state: DocumentState): string[] {
  return outlineOf(state).map((row) => `${"#".repeat(row.depth)} ${row.text} ? ${row.question}`);
}

const THREE = "## A\n\na.\n\n### A1\n\n## B\n\nb.\n\n## C\n";

describe("outlineOf", () => {
  it("lists every section in document order with its depth, heading text and question", () => {
    let state = stateOf(THREE);
    expect(rows(state)).toEqual(["## A ? ", "### A1 ? ", "## B ? ", "## C ? "]);
    state = applySetQuestion(state, 2, "What is B for?");
    expect(rows(state)).toEqual(["## A ? ", "### A1 ? ", "## B ? What is B for?", "## C ? "]);
  });

  it("finds a question through its anchor after an edit shifted the heading's top-level index", () => {
    const state = applySetQuestion(stateOf(THREE), 2, "What is B for?");
    // A paragraph typed above everything moves B from index 3 to 4; the sidecar is not refreshed
    // (the editor commits the root alone), so the entry's recorded pos is stale.
    const root: Root = { ...state.root, children: [...parse("New first paragraph.\n").children, ...state.root.children] };
    expect(state.sidecar.headings[0].anchor.pos).toEqual([3]);
    expect(rows({ root, sidecar: state.sidecar })[2]).toBe("## B ? What is B for?");
  });

  it("lists nothing for a document without headings", () => {
    expect(outlineOf(stateOf("Just a paragraph.\n"))).toEqual([]);
  });
});

describe("applySetQuestion", () => {
  it("creates the heading's entry, leaving the Markdown untouched by reference", () => {
    const state = stateOf(THREE);
    const next = applySetQuestion(state, 1, "Why A1?");
    expect(next.root).toBe(state.root);
    expect(next.sidecar.headings).toHaveLength(1);
    expect(next.sidecar.headings[0]).toMatchObject({
      question: "Why A1?",
      anchor: { kind: "heading", text: "A1", depth: 3, pos: [2] },
    });
    // The anchor resolves back to the same heading.
    expect(attach(next.sidecar, next.root).resolutions.map((one) => one.step)).toEqual([1]);
  });

  it("updates an existing entry in place rather than adding a second", () => {
    const once = applySetQuestion(stateOf(THREE), 0, "First?");
    const twice = applySetQuestion(once, 0, "Second?");
    expect(twice.sidecar.headings.map((entry) => entry.question)).toEqual(["Second?"]);
  });

  it("removes the entry for an empty question", () => {
    const set = applySetQuestion(stateOf(THREE), 0, "First?");
    const cleared = applySetQuestion(set, 0, "");
    expect(cleared.sidecar.headings).toEqual([]);
    expect(cleared.root).toBe(set.root);
  });

  it("returns the state itself for the question it already has, and for clearing an absent one", () => {
    const set = applySetQuestion(stateOf(THREE), 0, "First?");
    expect(applySetQuestion(set, 0, "First?")).toBe(set);
    expect(applySetQuestion(set, 1, "")).toBe(set);
  });

  it("keeps two byte-identical headings' questions apart", () => {
    let state = stateOf("## Same\n\none.\n\n## Same\n\ntwo.\n");
    state = applySetQuestion(state, 0, "first");
    state = applySetQuestion(state, 1, "second");
    expect(outlineOf(state).map((row) => row.question)).toEqual(["first", "second"]);
  });

  it("rejects a section index the document does not have", () => {
    const state = stateOf(THREE);
    expect(() => applySetQuestion(state, 4, "x")).toThrow(RangeError);
    expect(() => applySetQuestion(state, -1, "x")).toThrow(RangeError);
    expect(() => applySetQuestion(state, 0.5, "x")).toThrow(RangeError);
  });

  it("applySetQuestion(state, i, '') on a sidecar without questions is the identity for every section of every fixture", () => {
    let fixturesChecked = 0;
    let sectionsChecked = 0;
    for (const name of names) {
      const state = stateOf(fixture(name));
      const before = format(state.root);
      outlineOf(state).forEach((row) => {
        const next = applySetQuestion(state, row.index, "");
        expect(next).toBe(state);
        expect(format(next.root)).toBe(before);
        sectionsChecked += 1;
      });
      fixturesChecked += 1;
    }
    expect(fixturesChecked).toBe(names.length);
    expect(sectionsChecked).toBeGreaterThan(0);
  });
});

describe("applySetTopicQuestion (§6.1's two app-owned keys)", () => {
  it("sets the sidecar's topic question and leaves a document without front matter byte-identical", () => {
    const state = stateOf(THREE);
    const next = applySetTopicQuestion(state, "Why write this?");
    expect(next.sidecar.topicQuestion).toBe("Why write this?");
    expect(next.root).toBe(state.root);
  });

  it("rewrites only the front matter's question line when the document has one", () => {
    const source = fixture("front-matter.md");
    const state = stateOf(source);
    expect(state.sidecar.topicQuestion).toBe("What did the nib ever ask of us?");
    const next = applySetTopicQuestion(state, "Why ink?");
    expect(next.sidecar.topicQuestion).toBe("Why ink?");
    expect(format(next.root)).toBe(source.replace("question: What did the nib ever ask of us?", "question: Why ink?"));
  });

  it("clears the sidecar's value for an empty field", () => {
    const set = applySetTopicQuestion(stateOf(THREE), "Why?");
    expect(applySetTopicQuestion(set, "").sidecar.topicQuestion).toBeNull();
  });

  it("never adds a question line for an empty field, and rewrites an existing one to the empty scalar", () => {
    const titled = stateOf("---\ntitle: T\n---\n\nBody.\n");
    expect(applySetTopicQuestion(titled, "")).toBe(titled);
    const asked = stateOf(fixture("front-matter.md"));
    expect(format(applySetTopicQuestion(asked, "").root)).toContain('\nquestion: ""\n');
  });

  it("refuses a read-only key (a block scalar) and reports it as not editable", () => {
    const state = stateOf(fixture("front-matter-block-scalar.md"));
    expect(topicQuestionEditable(state.root)).toBe(false);
    expect(applySetTopicQuestion(state, "Other?")).toBe(state);
    expect(topicQuestionEditable(parse(fixture("front-matter.md")))).toBe(true);
    expect(topicQuestionEditable(parse(THREE))).toBe(true);
  });

  it("refuses a value with a line break where the block exists, rather than letting the sidecar and the block disagree", () => {
    const state = stateOf(fixture("front-matter.md"));
    expect(applySetTopicQuestion(state, "two\nlines")).toBe(state);
  });

  it("an unchanged topic question is the identity for every fixture", () => {
    let fixturesChecked = 0;
    let withYaml = 0;
    for (const name of names) {
      const state = stateOf(fixture(name));
      const before = format(state.root);
      const next = applySetTopicQuestion(state, state.sidecar.topicQuestion ?? "");
      expect(next).toBe(state);
      expect(format(next.root)).toBe(before);
      if (readFrontMatter(state.root).present) withYaml += 1;
      fixturesChecked += 1;
    }
    expect(fixturesChecked).toBe(names.length);
    expect(withYaml).toBeGreaterThan(0);
  });
});

describe("applyNewQuestion", () => {
  it("appends a heading whose text is the question, with the question anchored to it", () => {
    const state = stateOf("Intro.\n");
    const next = applyNewQuestion(state, "Why now?");
    expect(format(next.root)).toBe("Intro.\n\n## Why now?\n");
    expect(rows(next)).toEqual(["## Why now? ? Why now?"]);
    expect(next.sidecar.headings[0].anchor).toMatchObject({ kind: "heading", text: "Why now?", depth: NEW_QUESTION_DEPTH, pos: [1] });
    // A fixed point of parse∘format: the appended document is what a reopen reads.
    expect(format(parse(format(next.root)))).toBe(format(next.root));
  });

  it("trims the question and ignores an empty one", () => {
    const state = stateOf(THREE);
    expect(applyNewQuestion(state, "   ")).toBe(state);
    expect(format(applyNewQuestion(state, "  Why?  ").root)).toBe(`${THREE}\n## Why?\n`);
  });

  it("keeps the other sections' questions on their own headings", () => {
    const state = applySetQuestion(stateOf(THREE), 0, "About A?");
    const next = applyNewQuestion(state, "Why now?");
    expect(outlineOf(next).map((row) => row.question)).toEqual(["About A?", "", "", "", "Why now?"]);
  });

  it("works on an empty document", () => {
    const next = applyNewQuestion(stateOf(""), "First?");
    expect(format(next.root)).toBe("## First?\n");
  });

  it("applyNewQuestion(state, '') is the identity for every fixture", () => {
    let fixturesChecked = 0;
    for (const name of names) {
      const state = stateOf(fixture(name));
      const before = format(state.root);
      const next = applyNewQuestion(state, "");
      expect(next).toBe(state);
      expect(format(next.root)).toBe(before);
      // The leg is not vacuous: a real question changes the document.
      expect(format(applyNewQuestion(state, "Why?").root)).not.toBe(before);
      fixturesChecked += 1;
    }
    expect(fixturesChecked).toBe(names.length);
  });
});

describe("outlineDrop and applyOutlineDrop (the Outline drag)", () => {
  it("nests the essay fixture's section 5 under section 2, matching expected/essay-fixture.nested.md, its question carried", () => {
    let state = stateOf(fixture("essay-fixture.canonical.md"));
    state = applySetQuestion(state, 5, "What made it golden?");
    state = applySetQuestion(state, 3, "Who was Waterman?");
    const next = applyOutlineDrop(state, 5, 2, true);
    expect(format(next.root)).toBe(fixture("expected/essay-fixture.nested.md"));
    const after = outlineOf(next);
    expect(after[3]).toMatchObject({ depth: 4, text: "The Golden Age of the Fountain Pen", question: "What made it golden?" });
    expect(after[4]).toMatchObject({ text: "Lewis Waterman and the Capillary Feed", question: "Who was Waterman?" });
    expect(next.sidecar.headings.find((entry) => entry.question === "What made it golden?")?.anchor.depth).toBe(4);
  });

  it("reorders up: the section lands before the row, at the row's depth", () => {
    const state = stateOf(THREE);
    expect(outlineDrop(state.root, 3, 1, false)).toEqual({ index: 2, depth: 3 });
    expect(format(applyOutlineDrop(state, 3, 1, false).root)).toBe("## A\n\na.\n\n### C\n\n### A1\n\n## B\n\nb.\n");
  });

  it("reorders down: the section lands after the row's whole section, at the row's depth", () => {
    const state = stateOf(THREE);
    expect(outlineDrop(state.root, 0, 2, false)).toEqual({ index: 5, depth: 2 });
    expect(format(applyOutlineDrop(state, 0, 2, false).root)).toBe("## B\n\nb.\n\n## A\n\na.\n\n### A1\n\n## C\n");
  });

  it("nests as the last child of the row, one level deeper, carrying the section's own subsections", () => {
    const state = stateOf(THREE);
    expect(outlineDrop(state.root, 0, 3, true)).toEqual({ index: 6, depth: 3 });
    expect(format(applyOutlineDrop(state, 0, 3, true).root)).toBe("## B\n\nb.\n\n## C\n\n### A\n\na.\n\n#### A1\n");
  });

  it("re-depths a child nested again under its own parent without moving it (a depth change alone)", () => {
    const state = stateOf("## A\n\n### A1\n\n## B\n");
    // A1 is already A's last child at depth 3: nesting it under A is a no-op.
    expect(applyOutlineDrop(state, 1, 0, true)).toBe(state);
    const deeper = stateOf("# A\n\n### A1\n\n# B\n");
    expect(format(applyOutlineDrop(deeper, 1, 0, true).root)).toBe("# A\n\n## A1\n\n# B\n");
  });

  it("refuses a drop on the row itself, on a row inside the dragged section, and on a row that does not exist", () => {
    const state = stateOf(THREE);
    expect(outlineDrop(state.root, 0, 0, false)).toBeNull();
    expect(outlineDrop(state.root, 0, 0, true)).toBeNull();
    expect(outlineDrop(state.root, 0, 1, true)).toBeNull();
    expect(outlineDrop(state.root, 0, 9, false)).toBeNull();
    expect(outlineDrop(state.root, 9, 0, false)).toBeNull();
    expect(applyOutlineDrop(state, 0, 1, false)).toBe(state);
  });

  it("refuses a nest that would push the dragged section's deepest heading past H6", () => {
    const state = stateOf("##### Deep\n\n## A\n\n### A1\n");
    expect(outlineDrop(state.root, 1, 0, true)).toBeNull();
    expect(outlineDrop(state.root, 2, 0, true)).toEqual({ index: 1, depth: 6 });
  });

  it("returns the state itself for a nest that changes neither place nor depth, and moves otherwise", () => {
    // B is already A's last child at A's depth + 1.
    const nested = stateOf("## A\n\n### B\n");
    expect(applyOutlineDrop(nested, 1, 0, true)).toBe(nested);
    // A reorder always names a row on the far side of the dragged section, so it always moves.
    const flat = stateOf("## A\n\n## B\n");
    expect(format(applyOutlineDrop(flat, 1, 0, false).root)).toBe("## B\n\n## A\n");
    expect(format(applyOutlineDrop(flat, 0, 1, false).root)).toBe("## B\n\n## A\n");
  });

  it("every refused or in-place drop is the identity for every section of every fixture", () => {
    let fixturesChecked = 0;
    let dropsChecked = 0;
    for (const name of names) {
      const state = stateOf(fixture(name));
      const before = format(state.root);
      for (let i = 0; i < sectionsOf(state.root).length; i += 1) {
        const next = applyOutlineDrop(state, i, i, false);
        expect(next).toBe(state);
        expect(format(next.root)).toBe(before);
        dropsChecked += 1;
      }
      fixturesChecked += 1;
    }
    expect(fixturesChecked).toBe(names.length);
    expect(dropsChecked).toBeGreaterThan(0);
  });
});
