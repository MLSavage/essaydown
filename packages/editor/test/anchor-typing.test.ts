import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Root } from "mdast";
import {
  applyMoveBlock,
  attach,
  candidatesOf,
  format,
  parse,
  parseSidecar,
  type Anchor,
  type AnchorCandidate,
  type Sidecar,
} from "@essaydown/core";
import { joinBackward, splitBlock } from "prosemirror-commands";
import { EditorState, Selection, TextSelection, type Transaction } from "prosemirror-state";
import { chooseSidecarForWrite } from "../../../apps/desktop/src/workspace/sidecar-sync.js";
import { editorPlugins } from "../src/input.js";
import { mdastToPM, pmToMdastWithSources, schema } from "../src/schema.js";
import {
  bindProseMirror,
  carryThrough,
  createDocumentStore,
  replacedRuns,
  type BoundView,
} from "../src/store.js";

/**
 * Task 4.9 (DECISIONS #059; #review-3-r1, Claude r1 riskiest thing 3): PRD §6.2 says in-app
 * operations update anchors live, so identity follows the logical item; its duplicate limit covers
 * external edits only. Typing in the rendered view is an in-app operation, and a paragraph typed
 * above two byte-identical twins shifts their document-wide `occurrence`, so an anchor that is not
 * carried through the edit resolves onto the other twin at the next save.
 *
 * Every case here runs the production sequence: the rendered view's binding commits the typing,
 * the save is `chooseSidecarForWrite` (the pane's write-time choice) and `format`, and the reload
 * is `parseSidecar` + `attach` on the parsed file, as `DocumentPane` opens a document.
 */

const AT = "2026-10-07T00:00:00Z";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));
const FIXTURE_NAMES = Object.keys(
  JSON.parse(readFileSync(`${FIXTURES}/index.json`, "utf8")) as Record<string, unknown>,
).sort();
const fixture = (name: string): string => readFileSync(`${FIXTURES}/${name}`, "utf8");

class FakeView implements BoundView {
  state: EditorState;

  constructor(root: Root) {
    this.state = EditorState.create({ doc: mdastToPM(root).doc, plugins: editorPlugins() });
  }

  updateState(state: EditorState): void {
    this.state = state;
  }
}

function anchorOf(candidate: AnchorCandidate): Anchor {
  return {
    kind: candidate.kind,
    hash: candidate.hash,
    occurrence: candidate.occurrence,
    text: candidate.text,
    sectionHash: candidate.sectionHash,
    blockHash: candidate.blockHash,
    depth: candidate.depth,
    pos: [...candidate.pos],
  };
}

function sentenceAnchors(root: Root, text: string): Anchor[] {
  return candidatesOf(root)
    .filter((candidate) => candidate.kind === "sentence" && candidate.text === text)
    .map(anchorOf);
}

/** Open `markdown` with `sidecar` the way the pane does, and bind a rendered view to it. */
function open(markdown: string, sidecar: Sidecar) {
  const root = parse(markdown);
  const store = createDocumentStore(root, attach(sidecar, root).sidecar);
  const view = new FakeView(root);
  const binding = bindProseMirror(store, view);
  return { store, view, binding };
}

type Opened = ReturnType<typeof open>;

/** Put the caret at `pos` (a selection-only transaction, as a click makes). */
function caret(context: Opened, pos: number): void {
  const { state } = context.view;
  context.binding.dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}

/** Press Enter: the base keymap's `splitBlock`, dispatched through the binding. */
function enter(context: Opened): void {
  splitBlock(context.view.state, context.binding.dispatch);
}

/** Type `text` one character per transaction at the caret. */
function type(context: Opened, text: string): void {
  for (const character of text) {
    const { state } = context.view;
    const { from, to } = state.selection;
    context.binding.dispatch(state.tr.insertText(character, from, to));
  }
}

/** Save (the pane's write-time choice, no other writer) and reload the saved pair. */
function saveAndReload(context: Opened): { root: Root; sidecar: Sidecar } {
  const { root, sidecar } = context.store.getState().document;
  const markdown = format(root);
  const choice = chooseSidecarForWrite(null, null, sidecar, root);
  if (choice.action !== "write") throw new Error("the save skipped its sidecar write");
  const raw = `${JSON.stringify(choice.sidecar, null, 2)}\n`;
  const reloaded = parse(markdown);
  return { root: reloaded, sidecar: attach(parseSidecar(JSON.parse(raw)), reloaded).sidecar };
}

describe("typing keeps every anchor on its logical item (PRD §6.2, in-app operations update anchors live)", () => {
  it("reproduction: a duplicate typed above both twins, saved and reloaded, keeps the rewrite on the second twin", () => {
    const DOC = "Same line here.\n\nMiddle paragraph.\n\nSame line here.\n";
    const twins = sentenceAnchors(parse(DOC), "Same line here.");
    expect(twins.map((twin) => twin.pos)).toEqual([[0, 0], [2, 0]]);
    const context = open(
      DOC,
      parseSidecar({
        version: 1,
        rewrites: [{ anchor: twins[1], variants: [{ text: "made on the second twin", createdAt: AT }] }],
      }),
    );

    // Enter at the start of the first twin, then type the duplicate into the new empty paragraph.
    caret(context, Selection.atStart(context.view.state.doc).from);
    enter(context);
    caret(context, 1);
    type(context, "Same line here.");

    const { root, sidecar } = saveAndReload(context);
    expect(format(root)).toBe(`Same line here.\n\n${DOC}`);
    expect(sentenceAnchors(root, "Same line here.").map((twin) => twin.pos)).toEqual([
      [0, 0],
      [1, 0],
      [3, 0],
    ]);
    expect(sidecar.orphans).toEqual([]);
    expect(sidecar.rewrites).toHaveLength(1);
    expect(sidecar.rewrites[0].anchor.pos).toEqual([3, 0]);
    expect(sidecar.rewrites[0].variants[0].text).toBe("made on the second twin");
  });
});

/** Every heading, sentence and paragraph of `root` anchored, one entry each, in candidate order. */
function anchoredEverywhere(root: Root): Sidecar {
  const candidates = candidatesOf(root);
  return parseSidecar({
    version: 1,
    headings: candidates
      .filter((one) => one.kind === "heading")
      .map((one) => ({ anchor: anchorOf(one), question: `heading ${one.index}` })),
    rewrites: candidates
      .filter((one) => one.kind === "sentence")
      .map((one) => ({
        anchor: anchorOf(one),
        variants: [{ text: `sentence ${one.index}`, createdAt: AT }],
      })),
    coach: candidates
      .filter((one) => one.kind === "paragraph")
      .map((one) => ({
        anchor: anchorOf(one),
        scope: "paragraph",
        question: `paragraph ${one.index}`,
        askedAt: AT,
      })),
  });
}

/** Each entry's position, list by list, after the label it was written with. */
function positions(sidecar: Sidecar): string[] {
  return [
    ...sidecar.headings.map((entry) => `${entry.question} @ ${entry.anchor.pos.join(",")}`),
    ...sidecar.rewrites.map((entry) => `${entry.variants[0].text} @ ${entry.anchor.pos.join(",")}`),
    ...sidecar.coach.map((entry) => `${entry.question} @ ${entry.anchor.pos.join(",")}`),
  ];
}

/** {@link positions} with every top-level index from `at` on moved by `by`. */
function shifted(sidecar: Sidecar, at: number, by: number): string[] {
  const shift = (pos: readonly number[]): string =>
    [pos[0] >= at ? pos[0] + by : pos[0], ...pos.slice(1)].join(",");
  return [
    ...sidecar.headings.map((entry) => `${entry.question} @ ${shift(entry.anchor.pos)}`),
    ...sidecar.rewrites.map((entry) => `${entry.variants[0].text} @ ${shift(entry.anchor.pos)}`),
    ...sidecar.coach.map((entry) => `${entry.question} @ ${shift(entry.anchor.pos)}`),
  ];
}

describe("typing keeps every anchor on its logical item: corpus (task 4.9)", () => {
  const withParagraph = FIXTURE_NAMES.filter((name) =>
    candidatesOf(parse(fixture(name))).some((one) => one.kind === "paragraph"),
  );

  it("every fixture's last top-level paragraph exists to be duplicated", () => {
    expect(withParagraph.length).toBeGreaterThan(0);
  });

  it.each(withParagraph)(
    "editor leg, a typed duplicate of the last paragraph above everything, then its deletion: %s",
    (name) => {
      const root = parse(fixture(name));
      const sidecar = anchoredEverywhere(root);
      const offset = root.children[0]?.type === "yaml" ? 1 : 0;
      const last = candidatesOf(root).filter((one) => one.kind === "paragraph").at(-1);
      const text = (last as NonNullable<typeof last>).text;
      const context = open(fixture(name), sidecar);
      expect(positions(context.store.getState().document.sidecar)).toEqual(positions(sidecar));

      // A blank line opened above the first block, then the duplicate typed into it: all but its
      // last character in one transaction, the last character (the keystroke that makes the
      // twins) in another.
      context.binding.dispatch(context.view.state.tr.insert(0, schema.node("paragraph")));
      caret(context, 1);
      const characters = [...text];
      const { state: blank } = context.view;
      context.binding.dispatch(blank.tr.insertText(characters.slice(0, -1).join(""), 1));
      type(context, characters.at(-1) as string);

      const typed = saveAndReload(context);
      expect(typed.root.children).toHaveLength(root.children.length + 1);
      expect(typed.sidecar.orphans).toEqual([]);
      expect(positions(typed.sidecar)).toEqual(shifted(sidecar, offset, 1));

      // Destructive: the typed paragraph deleted whole. Every entry is back where it began.
      const { state } = context.view;
      context.binding.dispatch(state.tr.delete(0, state.doc.child(0).nodeSize));
      const deleted = saveAndReload(context);
      expect(format(deleted.root)).toBe(format(root));
      expect(deleted.sidecar.orphans).toEqual([]);
      expect(positions(deleted.sidecar)).toEqual(positions(sidecar));
      expect(deleted.sidecar.rewrites.map((entry) => entry.anchor)).toEqual(
        attach(sidecar, root).sidecar.rewrites.map((entry) => entry.anchor),
      );
    },
  );
});

describe("typing keeps every anchor on its logical item: named guards (task 4.9)", () => {
  const DOC = "Same line here.\n\nMiddle paragraph.\n\nSame line here.\n";

  function onSecondTwin(): Opened {
    const twins = sentenceAnchors(parse(DOC), "Same line here.");
    return open(
      DOC,
      parseSidecar({
        version: 1,
        rewrites: [{ anchor: twins[1], variants: [{ text: "second", createdAt: AT }] }],
      }),
    );
  }

  it("§6.2 external edit stays position-based: the same duplicate written on disk resolves by occurrence", () => {
    // The bytes the reproduction types, written by something that is not this app: the file holds
    // no evidence of which twin is new, so the anchor stays with the occurrence it recorded.
    const twins = sentenceAnchors(parse(DOC), "Same line here.");
    const external = parse(`Same line here.\n\n${DOC}`);
    const result = attach(
      parseSidecar({
        version: 1,
        rewrites: [{ anchor: twins[1], variants: [{ text: "second", createdAt: AT }] }],
      }),
      external,
    );
    expect(result.resolutions.map((one) => [one.step, one.duplicate])).toEqual([[1, true]]);
    expect(result.sidecar.rewrites[0].anchor.pos).toEqual([1, 0]);
  });

  it("§6.2 external swap after an in-app session stays position-based", () => {
    const context = onSecondTwin();
    caret(context, 1);
    enter(context);
    caret(context, 1);
    type(context, "Same line here.");
    const saved = saveAndReload(context);
    expect(saved.sidecar.rewrites[0].anchor.pos).toEqual([3, 0]);

    // On disk, the second and fourth blocks swapped: twins at 1 and 3 change places, which the
    // bytes cannot show — the variant stays at position 3.
    const swapped = parse("Same line here.\n\nMiddle paragraph.\n\nSame line here.\n\nSame line here.\n");
    const reloaded = attach(saved.sidecar, swapped);
    expect(reloaded.resolutions.map((one) => one.step)).toEqual([1]);
    expect(reloaded.sidecar.rewrites[0].anchor.pos).toEqual([3, 0]);
    expect(format(swapped)).not.toBe(format(saved.root));
  });

  it("a move after the typed duplicate moves the item the rewrite was made on", () => {
    const context = onSecondTwin();
    caret(context, 1);
    enter(context);
    caret(context, 1);
    type(context, "Same line here.");
    const { root, sidecar } = context.store.getState().document;
    const moved = applyMoveBlock({ root, sidecar }, 3, 0);
    expect(moved.sidecar.rewrites[0].anchor.pos).toEqual([0, 0]);
    expect(moved.sidecar.rewrites[0].anchor.occurrence).toBe(0);
  });

  it("undo after the typed duplicate restores the sidecar the twin had before it", () => {
    const context = onSecondTwin();
    const before = context.store.getState().document.sidecar;
    caret(context, 1);
    enter(context);
    caret(context, 1);
    type(context, "Same line here.");
    expect(context.store.getState().document.sidecar).not.toBe(before);
    context.store.getState().undo();
    expect(context.store.getState().document.sidecar.rewrites[0].anchor).toEqual(
      before.rewrites[0].anchor,
    );
  });

  it("typing that duplicates nothing commits the sidecar itself", () => {
    const context = onSecondTwin();
    const before = context.store.getState().document.sidecar;
    caret(context, 1);
    enter(context);
    caret(context, 1);
    type(context, "Unrelated words.");
    expect(context.store.getState().document.sidecar).toBe(before);
  });
});

describe("carryThrough: the rendered view's block mapping (task 4.9)", () => {
  function stateOf(markdown: string): EditorState {
    return EditorState.create({ doc: mdastToPM(parse(markdown)).doc, plugins: editorPlugins() });
  }
  /** Every old mdast index (and one past them) through `transaction`'s mapping. */
  function mapAll(transaction: Transaction, offset = 0): (number | null)[] {
    const sources = pmToMdastWithSources({ doc: transaction.doc, frontMatter: null }).sources;
    const map = carryThrough(transaction, offset, sources).mapBlock;
    const out: (number | null)[] = [];
    for (let i = 0; i < offset + transaction.before.childCount + 1; i += 1) out.push(map(i));
    return out;
  }
  /** The position of the start of top-level block `index`. */
  function startOf(state: EditorState, index: number): number {
    let pos = 0;
    for (let i = 0; i < index; i += 1) pos += state.doc.child(i).nodeSize;
    return pos;
  }
  const paragraph = (text: string) => schema.node("paragraph", null, schema.text(text));

  it("a block inserted above or between moves the blocks after it one index on", () => {
    const state = stateOf("A one.\n\nB two.\n");
    expect(mapAll(state.tr.insert(0, paragraph("New.")))).toEqual([1, 2, null]);
    expect(mapAll(state.tr.insert(startOf(state, 1), paragraph("New.")))).toEqual([0, 2, null]);
  });

  it("an index past the document, or the front matter's, maps nowhere; the offset moves every index", () => {
    const state = stateOf("A one.\n\nB two.\n");
    expect(mapAll(state.tr.insertText("x", 2), 1)).toEqual([null, 1, 2, null]);
  });

  it("a block whose first character was replaced or deleted maps nowhere", () => {
    const state = stateOf("A one.\n\nB two.\n");
    expect(mapAll(state.tr.insertText("Z", 1, 2))).toEqual([null, 1, null]);
    expect(mapAll(state.tr.delete(0, startOf(state, 1)))).toEqual([null, 0, null]);
  });

  it("a block wrapped in place goes to its wrapper", () => {
    const state = stateOf("A one.\n\nB two.\n");
    const $from = state.doc.resolve(startOf(state, 1) + 1);
    const range = $from.blockRange() as NonNullable<ReturnType<typeof $from.blockRange>>;
    expect(mapAll(state.tr.wrap(range, [{ type: schema.nodes.blockquote }]))).toEqual([0, 1, null]);
  });

  it("a split at a block's start keeps the block in its text half", () => {
    const state = stateOf("A one.\n\nB two.\n");
    const tr = state.tr.split(startOf(state, 1) + 1);
    // The empty half is dropped by the conversion, so the text half is mdast index 1.
    expect(tr.doc.childCount).toBe(3);
    expect(mapAll(tr)).toEqual([0, 1, null]);
  });

  it("a join at a block's start sends it into the block before", () => {
    let state = stateOf("A one.\n\nB two.\n");
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, startOf(state, 1) + 1)));
    let joined: Transaction | null = null;
    joinBackward(state, (tr) => {
      joined = tr;
    });
    expect(mapAll(joined as unknown as Transaction)).toEqual([0, 0, null]);
  });

  it("a block left holding only what the conversion drops maps nowhere", () => {
    // Typed live text keeps a leading space the conversion strips; deleting the rest leaves a
    // paragraph whose first token survived but which `pmToMdast` drops.
    const doc = schema.node("doc", null, [paragraph("A one."), paragraph(" x.")]);
    const state = EditorState.create({ doc, plugins: editorPlugins() });
    const from = startOf(state, 1) + 2;
    const tr = state.tr.delete(from, from + 2);
    expect(pmToMdastWithSources({ doc: tr.doc, frontMatter: null }).sources).toEqual([0]);
    expect(mapAll(tr)).toEqual([0, null, null]);
  });
});

describe("replacedRuns and carryThrough's regions: what an edit replaced (task 4.9)", () => {
  const paragraph = (text: string) => schema.node("paragraph", null, schema.text(text));
  const docOf = (...texts: string[]) => schema.node("doc", null, texts.map(paragraph));

  it("a block inserted is a run with nothing before it; typing inside a block replaces that block", () => {
    const state = EditorState.create({ doc: docOf("A one.", "B two.") });
    expect(replacedRuns(state.doc, state.tr.insert(0, paragraph("New.")).doc)).toEqual([
      { before: [], after: [0] },
    ]);
    expect(replacedRuns(state.doc, state.tr.insertText("x", 9).doc)).toEqual([
      { before: [1], after: [1] },
    ]);
  });

  it("an untouched document has no runs; a block deleted whole is a run with nothing after it", () => {
    const state = EditorState.create({ doc: docOf("A one.", "B two.", "C three.") });
    expect(replacedRuns(state.doc, state.doc)).toEqual([]);
    const second = state.doc.child(0).nodeSize;
    expect(
      replacedRuns(state.doc, state.tr.delete(second, second + state.doc.child(1).nodeSize).doc),
    ).toEqual([{ before: [1], after: [] }]);
  });

  it("a block moved (the same node, out of order) is replaced where it left and where it landed", () => {
    const state = EditorState.create({ doc: docOf("A one.", "B two.", "C three.") });
    const a = state.doc.child(0);
    const moved = state.tr.delete(0, a.nodeSize);
    moved.insert(moved.doc.content.size, a);
    expect(moved.doc.child(2)).toBe(a);
    expect(replacedRuns(state.doc, moved.doc)).toEqual([
      { before: [0], after: [] },
      { before: [], after: [2] },
    ]);
  });

  it("a node reused twice (a paste of an untouched block) is replaced at its second place", () => {
    const state = EditorState.create({ doc: docOf("A one.", "B two.") });
    const a = state.doc.child(0);
    const pasted = state.tr.insert(state.doc.content.size, a);
    expect(replacedRuns(state.doc, pasted.doc)).toEqual([{ before: [], after: [2] }]);
  });

  it("regions are in mdast indices: the front matter offset added, dropped blocks left out", () => {
    const state = EditorState.create({ doc: docOf("A one.", "B two.") });
    // An empty paragraph opened above, which the conversion drops: the run has no mdast block.
    const opened = state.tr.insert(0, schema.node("paragraph"));
    const sources = pmToMdastWithSources({ doc: opened.doc, frontMatter: null }).sources;
    expect(carryThrough(opened, 1, sources).regions()).toEqual([{ before: [], after: [] }]);
    // Typing into it: now it is a block, at mdast index 1 behind the front matter.
    const typed = state.tr.insert(0, paragraph("New."));
    const typedSources = pmToMdastWithSources({ doc: typed.doc, frontMatter: null }).sources;
    expect(carryThrough(typed, 1, typedSources).regions()).toEqual([{ before: [], after: [1] }]);
    const inside = state.tr.insertText("x", 9);
    const insideSources = pmToMdastWithSources({ doc: inside.doc, frontMatter: null }).sources;
    expect(carryThrough(inside, 0, insideSources).regions()).toEqual([{ before: [1], after: [1] }]);
  });
});
