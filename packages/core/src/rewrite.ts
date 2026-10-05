import type { Paragraph, Root } from "mdast";
import { blocksOf } from "./blocks.js";
import { parse } from "./parse.js";
import {
  replaceSentence,
  sentenceMarkdown,
  sentencesOf,
  type SegmentOptions,
} from "./sentences.js";
import {
  anchorOf,
  attach,
  candidateAt,
  candidatesOf,
  reanchor,
  type Anchor,
  type AnchorCandidate,
  type DocumentState,
  type RewriteEntry,
  type Sidecar,
} from "./sidecar.js";

/**
 * Rewrite mode's document operations (PRD §6.3, task 3.4): the sentence cards its sidebar shows,
 * the "Unattached" list, and the mutations its add-variant field, its "Use this" button and its
 * drag-to-reattach push. Each mutation is a `DocumentState → DocumentState` function the document
 * store's `dispatch` takes as one undo step, so undoing "Use this" restores both the sentence and
 * the entry's `chosen` (§6.5).
 *
 * **Live anchoring.** Typing in the editor commits roots without touching the sidecar, so the
 * store's sidecar holds anchors from the last time something resolved them. Every function here
 * therefore starts from `attach(sidecar, root)` — §6.2's five-step resolution against the document
 * as it stands — which is what keeps a card on its sentence after an edit elsewhere in the
 * paragraph (step 2: same sentence hash, new paragraph hash) and moves it to `orphans` once its
 * sentence has been retyped beyond the Dice threshold. A mutation stores that resolved sidecar, so
 * the store, the sidebar and the next save (`refresh`) agree on where every entry is.
 *
 * A sentence is addressed by its anchor position `[topLevelBlockIndex, sentenceIndex]` (§6.2
 * `pos`), the same pair `candidatesOf` produces.
 */

/** One sentence of a top-level paragraph, as Rewrite's sidebar shows it. */
export interface RewriteCard {
  readonly pos: readonly [number, number];
  /** The sentence's inline Markdown — what "Use this" replaces, and the no-op variant. */
  readonly markdown: string;
  /** Plain-text range of the sentence in its paragraph (`paragraphText` offsets). */
  readonly start: number;
  readonly end: number;
  /** The rewrite entry anchored here, or null when the sentence has none yet. */
  readonly entry: RewriteEntry | null;
  /** Another sentence of the document has the same text (§6.2's duplicate badge). */
  readonly duplicate: boolean;
}

/** An orphaned rewrite entry, with its index in the resolved sidecar's `orphans`. */
export interface UnattachedRewrite {
  readonly index: number;
  readonly entry: RewriteEntry;
}

function samePos(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** The sidecar with every anchor resolved against `root` (§6.2), and nothing else changed. */
export function resolvedSidecar(state: DocumentState, options: SegmentOptions = {}): Sidecar {
  return attach(state.sidecar, state.root, options).sidecar;
}

/** The top-level paragraph at `at`, with its contentId, or null for any other block. */
function paragraphAt(root: Root, at: number): { node: Paragraph; contentId: string } | null {
  const block = blocksOf(root).find((one) => one.path.length === 1 && one.path[0] === at);
  if (block === undefined || block.node.type !== "paragraph") return null;
  return { node: block.node, contentId: block.contentId };
}

/**
 * The cards of the top-level paragraph at root index `at`, one per sentence in order, or null when
 * that block is not a top-level paragraph (§6.1's Rewrite scope: nothing nested, nothing else).
 */
export function rewriteCards(
  state: DocumentState,
  at: number,
  options: SegmentOptions = {},
): RewriteCard[] | null {
  const paragraph = paragraphAt(state.root, at);
  if (paragraph === null) return null;
  const sidecar = resolvedSidecar(state, options);
  const candidates = candidatesOf(state.root, options).filter((one) => one.kind === "sentence");
  const counts = new Map<string, number>();
  for (const candidate of candidates) counts.set(candidate.hash, (counts.get(candidate.hash) ?? 0) + 1);
  return sentencesOf(paragraph.node, { ...options, blockId: paragraph.contentId }).map((sentence) => {
    const pos = [at, sentence.index] as const;
    // Every sentence of a top-level paragraph is a candidate, so both lookups find one.
    const candidate = candidateAt(candidates, "sentence", pos) as AnchorCandidate;
    return {
      pos,
      markdown: sentenceMarkdown(paragraph.node, sentence.index, options),
      start: sentence.start,
      end: sentence.end,
      entry: sidecar.rewrites.find((entry) => samePos(entry.anchor.pos, pos)) ?? null,
      duplicate: (counts.get(candidate.hash) as number) > 1,
    };
  });
}

/** The rewrite entries that no longer resolve (§6.2 step 5), for the "Unattached" section. */
export function unattachedRewrites(
  state: DocumentState,
  options: SegmentOptions = {},
): UnattachedRewrite[] {
  const result: UnattachedRewrite[] = [];
  resolvedSidecar(state, options).orphans.forEach((orphan, index) => {
    if (orphan.list === "rewrites") result.push({ index, entry: orphan.entry });
  });
  return result;
}

/** The sentence anchor at `pos`, or a thrown RangeError naming the position. */
function sentenceAnchorAt(
  operation: string,
  root: Root,
  pos: readonly number[],
  options: SegmentOptions,
): Anchor {
  const candidate = candidateAt(candidatesOf(root, options), "sentence", pos);
  if (candidate === null) {
    throw new RangeError(`${operation}: no top-level sentence at [${pos.join(", ")}]`);
  }
  return anchorOf(candidate);
}

/** `text`, trimmed, if it is non-empty inline Markdown; throws otherwise. */
function inlineVariant(text: string): string {
  const trimmed = text.trim();
  const root = parse(trimmed);
  if (root.children.length !== 1 || root.children[0].type !== "paragraph") {
    throw new Error(`a variant must be one line of inline Markdown, not ${JSON.stringify(text)}`);
  }
  return trimmed;
}

/**
 * Add `text` as a variant of the sentence at `pos`, creating the sentence's rewrite entry if it
 * has none. The Markdown is untouched (the root is returned by reference); `chosen` is untouched —
 * a variant is in use only after "Use this".
 *
 * @throws RangeError if `pos` is not a top-level sentence; Error if `text` is not inline Markdown.
 */
export function applyAddVariant(
  state: DocumentState,
  pos: readonly number[],
  text: string,
  createdAt: string,
  options: SegmentOptions = {},
): DocumentState {
  const anchor = sentenceAnchorAt("applyAddVariant", state.root, pos, options);
  const variant = { text: inlineVariant(text), createdAt };
  const sidecar = resolvedSidecar(state, options);
  const at = sidecar.rewrites.findIndex((entry) => samePos(entry.anchor.pos, pos));
  const rewrites =
    at === -1
      ? [...sidecar.rewrites, { anchor, variants: [variant], chosen: null, history: [] }]
      : sidecar.rewrites.map((entry, index) =>
          index === at ? { ...entry, variants: [...entry.variants, variant] } : entry,
        );
  return { root: state.root, sidecar: { ...sidecar, rewrites } };
}

/**
 * "Use this": replace the sentence at `pos` with its entry's variant `variant` (`replaceSentence`,
 * so marks outside the sentence survive and the variant's own Markdown decides the marks inside),
 * record the replaced Markdown in the entry's `history` and the variant's index in `chosen`, and
 * keep every anchor on its logical item — the entry stays on the sentence it rewrote, and the
 * sentences after it in the paragraph shift by however many sentences the variant added.
 *
 * **The no-op** — a variant equal to the sentence's own Markdown — leaves the root by reference
 * (`replaceSentence`'s own no-op) and records only `chosen`: nothing was replaced, so there is no
 * history entry.
 *
 * @throws RangeError if `pos` has no rewrite entry or `variant` is not one of its variants.
 */
export function applyUseVariant(
  state: DocumentState,
  pos: readonly number[],
  variant: number,
  replacedAt: string,
  options: SegmentOptions = {},
): DocumentState {
  const sidecar = resolvedSidecar(state, options);
  const at = sidecar.rewrites.findIndex((entry) => samePos(entry.anchor.pos, pos));
  const paragraph = paragraphAt(state.root, pos[0]);
  if (at === -1 || paragraph === null) {
    throw new RangeError(`applyUseVariant: no rewrite entry at [${pos.join(", ")}]`);
  }
  const entry = sidecar.rewrites[at];
  if (!Number.isInteger(variant) || variant < 0 || variant >= entry.variants.length) {
    throw new RangeError(
      `applyUseVariant: variant ${variant} is outside 0..${entry.variants.length - 1}`,
    );
  }
  const [block, index] = pos;
  const original = sentenceMarkdown(paragraph.node, index, options);
  const root = replaceSentence(
    state.root,
    paragraph.contentId,
    index,
    entry.variants[variant].text,
    options,
  );
  const used: RewriteEntry =
    root === state.root
      ? { ...entry, chosen: variant }
      : { ...entry, chosen: variant, history: [...entry.history, { text: original, replacedAt }] };
  const rewrites = sidecar.rewrites.map((one, i) => (i === at ? used : one));
  if (root === state.root) return { root, sidecar: { ...sidecar, rewrites } };

  const after = paragraphAt(root, block) as NonNullable<ReturnType<typeof paragraphAt>>;
  const shift =
    sentencesOf(after.node, options).length - sentencesOf(paragraph.node, options).length;
  return {
    root,
    sidecar: reanchor(
      { ...sidecar, rewrites },
      root,
      (anchor) =>
        anchor.kind === "sentence" && anchor.pos[0] === block && anchor.pos[1] > index
          ? [block, anchor.pos[1] + shift]
          : anchor.pos,
      options,
    ),
  };
}

function orphanAt(operation: string, sidecar: Sidecar, orphan: number): RewriteEntry {
  const found = sidecar.orphans[orphan];
  if (found === undefined || found.list !== "rewrites") {
    throw new RangeError(`${operation}: orphan ${orphan} is not an unattached rewrite`);
  }
  return found.entry;
}

/**
 * Drag-to-reattach (§6.2 step 5, "drag onto a sentence"): move unattached rewrite `orphan` (its
 * index in the resolved sidecar's `orphans`, {@link UnattachedRewrite.index}) onto the sentence at
 * `pos`. A sentence that already has an entry keeps it and gains the orphan's variants and history
 * after its own; its `chosen` stands, since the sentence's text is that choice's.
 *
 * @throws RangeError if `orphan` is not an unattached rewrite or `pos` is not a top-level sentence.
 */
export function applyReattach(
  state: DocumentState,
  orphan: number,
  pos: readonly number[],
  options: SegmentOptions = {},
): DocumentState {
  const sidecar = resolvedSidecar(state, options);
  const entry = orphanAt("applyReattach", sidecar, orphan);
  const anchor = sentenceAnchorAt("applyReattach", state.root, pos, options);
  const orphans = sidecar.orphans.filter((_, index) => index !== orphan);
  const at = sidecar.rewrites.findIndex((one) => samePos(one.anchor.pos, pos));
  const rewrites =
    at === -1
      ? [...sidecar.rewrites, { ...entry, anchor }]
      : sidecar.rewrites.map((one, index) =>
          index === at
            ? {
                ...one,
                variants: [...one.variants, ...entry.variants],
                history: [...one.history, ...entry.history],
              }
            : one,
        );
  return { root: state.root, sidecar: { ...sidecar, rewrites, orphans } };
}

/**
 * Delete unattached rewrite `orphan` (§6.2 step 5, "or delete").
 *
 * @throws RangeError if `orphan` is not an unattached rewrite.
 */
export function applyDeleteOrphan(
  state: DocumentState,
  orphan: number,
  options: SegmentOptions = {},
): DocumentState {
  const sidecar = resolvedSidecar(state, options);
  orphanAt("applyDeleteOrphan", sidecar, orphan);
  return {
    root: state.root,
    sidecar: { ...sidecar, orphans: sidecar.orphans.filter((_, index) => index !== orphan) },
  };
}
