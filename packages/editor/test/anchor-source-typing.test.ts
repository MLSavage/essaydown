import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Paragraph, Root } from "mdast";
import {
  attach,
  candidatesOf,
  format,
  paragraphText,
  parse,
  parseSidecar,
  sentencesOf,
  type Anchor,
  type AnchorCandidate,
  type Sidecar,
} from "@essaydown/core";
import {
  ChangeSet,
  EditorState as CMState,
  Text,
  type ChangeSpec,
  type TransactionSpec,
} from "@codemirror/state";
import { chooseSidecarForWrite } from "../../../apps/desktop/src/workspace/sidecar-sync.js";
import { createDocumentStore } from "../src/store.js";
import { bindCodeMirror, sourceEdit, type BoundSourceView } from "../src/toggle.js";

/**
 * Task 4.27 (DECISIONS #review-4-r0 C4): typing in the source view is an in-app operation as much
 * as typing in the rendered view, so PRD §6.2's "in-app operations update anchors live" holds there
 * too. Before this task the source binding committed `parse(text)` with the sidecar unchanged, so a
 * twin typed above an anchored item took its anchor at the next save.
 *
 * Every case runs the production sequence: CodeMirror transactions on the view, the binding's
 * `change` with the view's text (what the pane's update listener does), the burst committed by a
 * flush, the save as `chooseSidecarForWrite` + `format`, and the reload as `parseSidecar` +
 * `attach` on the parsed file, as `DocumentPane` opens a document.
 */

const AT = "2026-10-10T00:00:00Z";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));
const FIXTURE_NAMES = Object.keys(
  JSON.parse(readFileSync(`${FIXTURES}/index.json`, "utf8")) as Record<string, unknown>,
).sort();
const fixture = (name: string): string => readFileSync(`${FIXTURES}/${name}`, "utf8");

/** A CodeMirror view reduced to what `BoundSourceView` names. */
class FakeSourceView implements BoundSourceView {
  state = CMState.create({ doc: "" });

  dispatch(spec: TransactionSpec): void {
    this.state = this.state.update(spec).state;
  }

  text(): string {
    return this.state.doc.toString();
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

function rewriteOn(anchor: Anchor, label: string): Sidecar {
  return parseSidecar({
    version: 1,
    rewrites: [{ anchor, variants: [{ text: label, createdAt: AT }] }],
  });
}

/**
 * Open `markdown` with `sidecar` the way the pane does, and bind a source view to it. The commit
 * timer never fires on its own: each case commits by `flush`, the way a toggle or a save does.
 */
function open(markdown: string, sidecar: Sidecar) {
  const root = parse(markdown);
  const store = createDocumentStore(root, attach(sidecar, root).sidecar);
  const view = new FakeSourceView();
  const binding = bindCodeMirror(store, view, { schedule: () => () => undefined });
  return { store, view, binding };
}

type Opened = ReturnType<typeof open>;

/** One CodeMirror transaction, then the update listener's call. */
function edit(context: Opened, spec: TransactionSpec): void {
  context.view.dispatch(spec);
  context.binding.change(context.view.text());
}

/** Type `text` at `at`, one character per transaction. */
function type(context: Opened, at: number, text: string): void {
  let position = at;
  for (const character of text) {
    edit(context, { changes: { from: position, insert: character } });
    position += character.length;
  }
}

/** Save (the pane's write-time choice, no other writer) and reload the saved pair. */
function saveAndReload(context: Opened): { root: Root; sidecar: Sidecar } {
  context.binding.flush();
  const { root, sidecar } = context.store.getState().document;
  const markdown = format(root);
  const choice = chooseSidecarForWrite(null, null, sidecar, root);
  if (choice.action !== "write") throw new Error("the save skipped its sidecar write");
  const raw = `${JSON.stringify(choice.sidecar, null, 2)}\n`;
  const reloaded = parse(markdown);
  return { root: reloaded, sidecar: attach(parseSidecar(JSON.parse(raw)), reloaded).sidecar };
}

/** The source offset at which top-level block `index` of the view's text starts. */
function blockStart(context: Opened, index: number): number {
  return parse(context.view.text()).children[index].position?.start.offset ?? -1;
}

const TWIN_PARAGRAPHS = "Same line here.\n\nMiddle paragraph.\n\nSame line here.\n";
const TWIN_SENTENCES = "Same line here. Same line here.\n";

describe("the source view's commit carries the sidecar (task 4.27; DECISIONS #review-4-r0 C4)", () => {
  it("Claude's reproduction: a twin paragraph typed above both twins in the source view keeps the rewrite on [3,0]", () => {
    const twins = sentenceAnchors(parse(TWIN_PARAGRAPHS), "Same line here.");
    expect(twins.map((twin) => twin.pos)).toEqual([[0, 0], [2, 0]]);
    const context = open(TWIN_PARAGRAPHS, rewriteOn(twins[1], "made on the second twin"));

    type(context, 0, "Same line here.\n\n");

    const { root, sidecar } = saveAndReload(context);
    expect(format(root)).toBe(`Same line here.\n\n${TWIN_PARAGRAPHS}`);
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

  it("a same-block twin typed at the paragraph's start in the source view keeps the rewrite on the original second sentence", () => {
    const twins = sentenceAnchors(parse(TWIN_SENTENCES), "Same line here.");
    expect(twins.map((twin) => twin.pos)).toEqual([[0, 0], [0, 1]]);
    const context = open(TWIN_SENTENCES, rewriteOn(twins[1], "belongs to original second sentence"));

    type(context, 0, "Same line here. ");

    const { root, sidecar } = saveAndReload(context);
    expect(format(root)).toBe("Same line here. Same line here. Same line here.\n");
    expect(sidecar.orphans).toEqual([]);
    expect(sidecar.rewrites).toHaveLength(1);
    expect(sidecar.rewrites[0].anchor.pos).toEqual([0, 2]);
    expect(sidecar.rewrites[0].anchor.occurrence).toBe(2);
    expect(sidecar.rewrites[0].variants[0].text).toBe("belongs to original second sentence");
  });
});

describe("the source view's commit carries the sidecar: corpus leg seeded from the source view (task 4.27)", () => {
  type Leg = "twin at document start" | "twin at block start" | "first character deleted";
  const LEGS: Leg[] = ["twin at document start", "twin at block start", "first character deleted"];

  /** Every top-level sentence of every fixture, with what the legs need to find it again. */
  const cases = FIXTURE_NAMES.flatMap((name) => {
    const root = parse(fixture(name));
    return candidatesOf(root)
      .filter((one) => one.kind === "sentence")
      .map((one) => {
        const [block, index] = one.pos;
        const sentence = sentencesOf(root.children[block] as Paragraph)[index];
        return { name, at: `${block},${index}`, candidate: one, sentence };
      });
  });

  it("the corpus has sentences to anchor", () => {
    expect(cases.length).toBeGreaterThan(0);
    expect(new Set(cases.map((one) => one.name)).size).toBeGreaterThan(1);
  });

  it.each(LEGS)("source leg, typed in the source view: %s", (leg) => {
    let held = 0;
    let deleted = 0;
    let merged = 0;
    for (const { name, at, candidate, sentence } of cases) {
      const label = `${name} [${at}] ${leg}`;
      const [block] = candidate.pos;
      const context = open(fixture(name), rewriteOn(anchorOf(candidate), label));
      const before = context.store.getState().document;
      const body = before.root.children[0]?.type === "yaml" ? 1 : 0;
      if (leg === "twin at document start") {
        type(context, blockStart(context, body), `${candidate.text}\n\n`);
      } else if (leg === "twin at block start") {
        type(context, blockStart(context, block), `${candidate.text} `);
      } else {
        const from = blockStart(context, block);
        edit(context, { changes: { from, to: from + 1 } });
      }

      const { root, sidecar } = saveAndReload(context);
      const shift = leg === "twin at document start" ? root.children.length - before.root.children.length : 0;
      const was = paragraphText(before.root.children[block] as Paragraph);
      // A deletion can drop or merge the block: the item is then looked for nowhere.
      const paragraph =
        root.children.length === before.root.children.length + shift ? root.children[block + shift] : undefined;
      const now = paragraph?.type === "paragraph" ? paragraphText(paragraph) : "";
      const start = sentence.start + (leg === "twin at document start" ? 0 : now.length - was.length);
      const item =
        paragraph?.type === "paragraph" && (leg !== "twin at document start" || shift === 1)
          ? sentencesOf(paragraph).find((one) => one.start === start && one.text === sentence.text)
          : undefined;
      if (item !== undefined) {
        expect(sidecar.orphans, label).toEqual([]);
        expect(sidecar.rewrites[0]?.anchor.pos, label).toEqual([block + shift, item.index]);
        held += 1;
      } else if (leg === "first character deleted" && sentence.start === 0) {
        // The deletion took the item's own first character: `mapOffset` answers null, the one
        // case left to core's nearest-by-index fallback (named in its carry-edit guards).
        deleted += 1;
      } else {
        // The typed twin is not a sentence of its own (it segments into its neighbour, or its
        // bytes parse as something else), so no item of the anchored text is left where it was
        // looked for: the live carry leaves the entry as it was, never moves it.
        expect(context.store.getState().document.sidecar.rewrites[0].anchor, label).toEqual(
          before.sidecar.rewrites[0].anchor,
        );
        merged += 1;
      }
    }
    expect(held).toBeGreaterThan(0);
    expect(held + deleted + merged).toBe(cases.length);
    if (leg === "first character deleted") expect(deleted).toBeGreaterThan(0);
    else expect(deleted).toBe(0);
  }, 120_000);
});

/** Every top-level item anchored, one entry per list (4.26's identity-leg sidecar). */
function anchoredEverywhere(root: Root): Sidecar {
  const candidates = candidatesOf(root);
  return parseSidecar({
    version: 1,
    headings: candidates
      .filter((one) => one.kind === "heading")
      .map((one) => ({ anchor: anchorOf(one), question: `heading ${one.index}` })),
    rewrites: candidates
      .filter((one) => one.kind === "sentence")
      .map((one) => ({ anchor: anchorOf(one), variants: [{ text: `sentence ${one.index}`, createdAt: AT }] })),
    coach: candidates
      .filter((one) => one.kind === "paragraph")
      .map((one) => ({ anchor: anchorOf(one), scope: "paragraph", question: `paragraph ${one.index}`, askedAt: AT })),
  });
}

describe("the source view's commit carries the sidecar: identity leg (task 4.27)", () => {
  it.each(FIXTURE_NAMES)("a no-op burst in the source view re-serialises the sidecar byte-identically: %s", (name) => {
    const root = parse(fixture(name));
    const context = open(fixture(name), anchoredEverywhere(root));
    const opened = context.store.getState().document;
    const write = (current: Sidecar): string => {
      const choice = chooseSidecarForWrite(null, null, current, context.store.getState().document.root);
      if (choice.action !== "write") throw new Error("the save skipped its sidecar write");
      return `${JSON.stringify(choice.sidecar, null, 2)}\n`;
    };
    const bytes = write(opened.sidecar);

    // The whole text replaced by itself, then a character typed at the end and deleted: the burst
    // commits (the store's root is a new parse) and changes the document by nothing.
    const text = context.view.text();
    edit(context, { changes: { from: 0, to: text.length, insert: text } });
    type(context, text.length, "x");
    edit(context, { changes: { from: text.length, to: text.length + 1 } });
    context.binding.flush();

    expect(context.store.getState().document.root).not.toBe(opened.root);
    expect(format(context.store.getState().document.root)).toBe(format(root));
    expect(context.store.getState().document.sidecar).toBe(opened.sidecar);
    expect(write(context.store.getState().document.sidecar)).toBe(bytes);
  });
});

/** The rewrite's position after the burst is committed (no save). */
function carried(context: Opened): readonly number[] | undefined {
  context.binding.flush();
  return context.store.getState().document.sidecar.rewrites[0]?.anchor.pos;
}

/** The reproduction's document, rewrite on the second twin, opened in the source view. */
function onSecondTwin(): Opened {
  return open(TWIN_PARAGRAPHS, rewriteOn(sentenceAnchors(parse(TWIN_PARAGRAPHS), "Same line here.")[1], "second"));
}

describe("bindCodeMirror's change log: named guards, one per branch of the diff (task 4.27)", () => {
  it("a burst cut by a flush is carried commit by commit (the parse a commit made is the next one's old tree)", () => {
    const context = onSecondTwin();
    type(context, 0, "Same line");
    context.binding.flush();
    type(context, "Same line".length, " here.\n\n");
    expect(carried(context)).toEqual([3, 0]);
  });

  it("a transaction that leaves the pending text unchanged is still composed into the burst", () => {
    const context = onSecondTwin();
    type(context, 0, "Same line here.\n\n");
    // `S` replaced by `S`: the doc changed by transaction, the text did not.
    edit(context, { changes: { from: 0, to: 1, insert: "S" } });
    expect(carried(context)).toEqual([3, 0]);
  });

  it("the whole-text write a pull makes is not part of the next burst", () => {
    const context = onSecondTwin();
    // A replacement from outside the view (an undo, a reload) is pulled into it.
    const { document, commit } = context.store.getState();
    commit(parse(format(document.root)), document.sidecar);
    expect(context.view.text()).toBe(TWIN_PARAGRAPHS);
    type(context, 0, "Same line here.\n\n");
    expect(carried(context)).toEqual([3, 0]);
  });

  it("a view whose state lost the log carries nothing", () => {
    const context = onSecondTwin();
    context.view.state = CMState.create({ doc: context.view.text() });
    type(context, 0, "Same line here.\n\n");
    expect(carried(context)).toEqual([2, 0]);
  });

  it("a view rewound to a state before the last read carries nothing", () => {
    const context = onSecondTwin();
    const earlier = context.view.state;
    type(context, 0, "x");
    context.binding.flush();
    context.view.state = earlier;
    type(context, 0, "Same line here.\n\n");
    expect(carried(context)).toEqual([2, 0]);
  });

  it("a view whose state is not a CodeMirror state is bound without the log and carries nothing", () => {
    const root = parse(TWIN_PARAGRAPHS);
    const anchor = sentenceAnchors(root, "Same line here.")[1];
    const store = createDocumentStore(root, attach(rewriteOn(anchor, "second"), root).sidecar);
    let text = "";
    const dispatched: TransactionSpec[] = [];
    const view = {
      get state() {
        return { doc: { toString: () => text, length: text.length } } as unknown as BoundSourceView["state"];
      },
      dispatch: (spec: TransactionSpec) => {
        dispatched.push(spec);
        text = (spec.changes as { insert: string }).insert;
      },
    };
    const binding = bindCodeMirror(store, view, { schedule: () => () => undefined });
    expect(dispatched).toHaveLength(1);
    binding.change(`Same line here.\n\n${TWIN_PARAGRAPHS}`);
    binding.flush();
    expect(store.getState().document.sidecar.rewrites[0].anchor.pos).toEqual([2, 0]);
  });

  it("text the view never held commits with the sidecar unchanged", () => {
    const context = onSecondTwin();
    context.binding.change(`Same line here.\n\n${TWIN_PARAGRAPHS}`);
    expect(carried(context)).toEqual([2, 0]);
    expect(format(context.store.getState().document.root)).toBe(`Same line here.\n\n${TWIN_PARAGRAPHS}`);
  });

  it("logged changes that do not lead to the committed text carry nothing", () => {
    const context = onSecondTwin();
    context.view.dispatch({ changes: { from: 0, insert: "Same line here.\n\n" } });
    context.binding.change(`Other.\n\n${TWIN_PARAGRAPHS}`);
    expect(carried(context)).toEqual([2, 0]);
  });

  it("a store tree whose blocks are not the shown text's one for one carries nothing", () => {
    // Two paragraphs the serializer writes as one block: the view's parse has one child, the
    // store's root two, so no index of the one names a block of the other.
    const first = parse("Same line here.\n").children[0];
    const root: Root = { type: "root", children: [first, { type: "paragraph", children: [] }] };
    const anchor = sentenceAnchors(root, "Same line here.")[0];
    const store = createDocumentStore(root, attach(rewriteOn(anchor, "only"), root).sidecar);
    const view = new FakeSourceView();
    const binding = bindCodeMirror(store, view, { schedule: () => () => undefined });
    expect(parse(view.text()).children).toHaveLength(1);
    const before = store.getState().document.sidecar;
    view.dispatch({ changes: { from: 0, insert: "Same line here. " } });
    binding.change(view.text());
    binding.flush();
    expect(store.getState().document.sidecar).toBe(before);
  });
});

/** `before` changed by `spec`, as `sourceEdit` reads it. */
function changed(before: string, spec: ChangeSpec) {
  const changes = ChangeSet.of(spec, before.length);
  const after = changes.apply(Text.of(before.split("\n"))).toString();
  return { after, edit: sourceEdit(parse(before), before, parse(after), after, changes) };
}

describe("sourceEdit: regions and mapBlock (task 4.27)", () => {
  const DOC = "A one.\n\nB two.\n\nC three.\n";

  it("text typed inside a block replaces that block; a block typed between two others is a run of its own edge", () => {
    expect(changed(DOC, { from: 9, insert: "x" }).edit.regions()).toEqual([{ before: [1], after: [1] }]);
    // Typed at the start of block 1: it touches block 1, which is replaced by the new block and itself.
    expect(changed(DOC, { from: 8, insert: "New.\n\n" }).edit.regions()).toEqual([{ before: [1], after: [1, 2] }]);
  });

  it("an untouched document has no runs; a block deleted whole is a run with nothing after it", () => {
    expect(changed(DOC, []).edit.regions()).toEqual([]);
    expect(changed(DOC, { from: 6, to: 14 }).edit.regions()).toEqual([{ before: [0, 1], after: [0] }]);
  });

  it("a block that starts where it did but runs on (the blank line after it deleted) is not kept", () => {
    const { after, edit } = changed(DOC, { from: 7, to: 8 });
    expect(after).toBe("A one.\nB two.\n\nC three.\n");
    expect(edit.regions()).toEqual([{ before: [0, 1], after: [0] }]);
  });

  it("mapBlock follows a block's first byte past text typed before it, and goes nowhere when it was deleted", () => {
    const typed = changed(DOC, { from: 0, insert: "New.\n\n" }).edit;
    expect([0, 1, 2].map((index) => typed.mapBlock(index))).toEqual([1, 2, 3]);
    const deleted = changed(DOC, { from: 8, to: 9 }).edit;
    expect([0, 1, 2].map((index) => deleted.mapBlock(index))).toEqual([0, null, 2]);
    expect(typed.mapBlock(3)).toBeNull();
  });

  it("blocks without offsets are never kept, mapped, or read for characters", () => {
    const bare: Root = { type: "root", children: parse(DOC).children.map((child) => ({ ...child, position: undefined })) as Root["children"] };
    const bareParagraph = bare.children.map((child) =>
      child.type === "paragraph" ? { ...child, children: child.children.map((leaf) => ({ ...leaf, position: undefined })) } : child,
    ) as Root["children"];
    const changes = ChangeSet.of([], DOC.length);
    const fromBare = sourceEdit({ type: "root", children: bareParagraph }, DOC, parse(DOC), DOC, changes);
    expect(fromBare.regions()).toEqual([{ before: [0, 1, 2], after: [0, 1, 2] }]);
    expect(fromBare.mapBlock(0)).toBeNull();
    expect(fromBare.mapOffset(0, 0)).toBeNull();
    // Landing in a tree without offsets: no block holds the mapped byte.
    const intoBare = sourceEdit(parse(DOC), DOC, bare, DOC, changes);
    expect(intoBare.mapBlock(0)).toBeNull();
    expect(intoBare.mapOffset(0, 0)).toBeNull();
  });
});

describe("sourceEdit: mapOffset, one character through the source view (task 4.27)", () => {
  // Each kind of leaf, each spelled as the bytes do not spell it one for one: an escape, emphasis
  // delimiters, a code span, an inline tag, an image, a hard break, a numeric character reference.
  const PARAGRAPH = "a\\*b *c* `d` <i>e</i> ![ff](u) g\\\nh &#42; k\n";
  const PLAIN = "a*b c d <i>e</i> ff g h * k";

  /** The source byte of plain-text character `index`, found by hand from the bytes above. */
  const SOURCE: Record<number, number> = {
    0: 0, // a
    1: 1, // \* — the escape's first byte
    2: 3, // b
    4: 6, // c, inside the emphasis
    6: 10, // d, inside the code span
    8: 13, // <i> — an inline tag's first byte
    17: 22, // ff — the image's first byte
    18: 22, // the alt's second unit is the same atom
    20: 31, // g
    21: 32, // the hard break, one plain unit at its backslash
    22: 34, // h, first of the next line
    24: 36, // * — the reference's first byte
    26: 42, // k, the last character
  };

  it("the plain text is what core segments", () => {
    expect(paragraphText(parse(PARAGRAPH).children[0] as Paragraph)).toBe(PLAIN);
  });

  it("text typed just before a character moves it, just after leaves it: first, middle and last", () => {
    for (const [plain, source] of Object.entries(SOURCE).map(([key, value]) => [Number(key), value])) {
      const before = changed(PARAGRAPH, { from: source, insert: "Z" }).edit.mapOffset(0, plain);
      const atom = plain === 18;
      // A unit inside an atom is mapped to the atom's first unit, so it is moved as the atom is.
      expect(before, `before ${plain}`).toEqual({ index: 0, offset: (atom ? 17 : plain) + 1 });
      const width = PARAGRAPH.slice(source).startsWith("\\*") ? 2 : 1;
      if (!atom && plain !== 17 && plain !== 8 && plain !== 24 && plain !== 21) {
        const after = changed(PARAGRAPH, { from: source + width, insert: "Z" }).edit.mapOffset(0, plain);
        expect(after, `after ${plain}`).toEqual({ index: 0, offset: plain });
      }
    }
  });

  it("an unchanged text maps every character to itself (the identity), an atom's units to its first", () => {
    const { edit } = changed(PARAGRAPH, []);
    for (let plain = 0; plain < PLAIN.length; plain += 1) {
      expect(edit.mapOffset(0, plain), String(plain)).toEqual({ index: 0, offset: plain === 18 ? 17 : plain });
    }
  });

  it("an offset past the paragraph's plain text, a non-paragraph, an index past the document map nowhere", () => {
    const { edit } = changed(`# Head\n\n${PARAGRAPH}`, []);
    expect(edit.mapOffset(1, PLAIN.length)).toBeNull();
    expect(edit.mapOffset(0, 0)).toBeNull();
    expect(edit.mapOffset(2, 0)).toBeNull();
  });

  it("a deleted character maps nowhere; a character that lands outside a paragraph maps nowhere", () => {
    expect(changed(PARAGRAPH, { from: 0, to: 1 }).edit.mapOffset(0, 0)).toBeNull();
    // The paragraph made a heading: its characters are no paragraph's.
    expect(changed(PARAGRAPH, { from: 0, insert: "# " }).edit.mapOffset(0, 0)).toBeNull();
  });

  it("a byte no character spells (a delimiter) belongs to the next character; past the last, to the end", () => {
    // A literal `*` that the edit makes an opening delimiter: it owns no character, `c` is next.
    expect(paragraphText(parse("x *c\n").children[0] as Paragraph)).toBe("x *c");
    expect(changed("x *c\n", { from: 4, insert: "*" }).edit.mapOffset(0, 2)).toEqual({ index: 0, offset: 2 });
    // A literal `*` that the edit makes the closing delimiter: past the last character, the end.
    expect(changed("c*\n", { from: 0, insert: "*" }).edit.mapOffset(0, 1)).toEqual({ index: 0, offset: 1 });
  });

  it("bytes that do not spell their value under the spelling rules map nowhere, in either paragraph", () => {
    // A trailing space before a soft line break is not in the text's value.
    const odd = "a \nb\n";
    expect(paragraphText(parse(odd).children[0] as Paragraph)).toBe("a\nb");
    expect(changed(odd, []).edit.mapOffset(0, 2)).toBeNull();
    // A named character reference: the spelling rules read numeric ones only, so no character of
    // the text holding it is placed.
    const named = "h &amp; k\n";
    expect(paragraphText(parse(named).children[0] as Paragraph)).toBe("h & k");
    expect(changed(named, []).edit.mapOffset(0, 0)).toBeNull();
    expect(changed(named, []).edit.mapOffset(0, 2)).toBeNull();
    // A code span whose value is not in its bytes (hand-built: the parser keeps it verbatim).
    const code = "x `a` y\n";
    const tree = parse(code);
    const span = (tree.children[0] as Paragraph).children[1];
    if (span.type !== "inlineCode") throw new Error("the code span is the second leaf");
    span.value = "q";
    expect(sourceEdit(tree, code, parse(code), code, ChangeSet.of([], code.length)).mapOffset(0, 2)).toBeNull();
    // Landing in such a paragraph: the character is found, its offset there is not.
    expect(changed("q b\n", { from: 0, to: 1, insert: "a \n" }).edit.mapOffset(0, 2)).toBeNull();
  });

  it("a zero-width leaf (an image reference) owns nothing: the offset at it is the next character's", () => {
    const text = "a ![][r] b\n\n[r]: /u\n";
    expect(paragraphText(parse(text).children[0] as Paragraph)).toBe("a  b");
    const { edit } = changed(text, { from: 0, insert: "Z" });
    expect(edit.mapOffset(0, 2)).toEqual({ index: 0, offset: 3 });
    expect(edit.mapOffset(0, 3)).toEqual({ index: 0, offset: 4 });
  });
});
