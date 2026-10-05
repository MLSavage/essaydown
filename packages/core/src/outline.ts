import type { Heading, Root } from "mdast";
import { sectionsOf, normalizedText, moveSectionTo } from "./blocks.js";
import {
  anchorOf,
  candidatesOf,
  carryTopLevelMove,
  readFrontMatter,
  resolveAnchor,
  writeFrontMatter,
  type AnchorCandidate,
  type DocumentState,
  type HeadingEntry,
} from "./sidecar.js";
import type { SegmentOptions } from "./sentences.js";

/**
 * Outline mode's document operations (PRD §6.3, task 3.2): the section tree it shows, and the
 * mutations its drags, question fields, topic field and "New question" push. Each mutation is a
 * `DocumentState → DocumentState` function the document store's `dispatch` takes as one undo step
 * (§6.5: "outline move/nest, question edit"), and each returns the state it was given, by
 * reference, when it would change nothing — so a no-op pushes nothing.
 *
 * **A question is not its heading** (DECISIONS #002-outline-feel: "if they stay as headings then
 * the questions they came from serve no further purpose"). A section's question lives in the
 * sidecar's `headings` list, anchored to the heading (§6.2), and never in the Markdown; the
 * heading's text is the writer's to change. "New question" starts the heading with the question's
 * text and keeps the question beside it, so renaming the heading later leaves the question where
 * it was.
 */

/** One row of the Outline: a section of {@link sectionsOf}, with what the Outline shows for it. */
export interface OutlineItem {
  /** The section's index in {@link sectionsOf} — the index every mutation below takes. */
  readonly index: number;
  readonly depth: number;
  /** The heading's plain text (§6.1 normalization). */
  readonly text: string;
  /** The section's question from the sidecar, or `""` when it has none. */
  readonly question: string;
}

/**
 * The heading entry whose anchor resolves to the heading candidate `target`, with its index in
 * `sidecar.headings`, or null. Resolved through §6.2's own resolution rather than read off `pos`,
 * because typing in the editor moves top-level indices without refreshing the sidecar.
 */
function entryFor(
  state: DocumentState,
  target: AnchorCandidate,
  candidates: readonly AnchorCandidate[],
  options: SegmentOptions,
): { entry: HeadingEntry; at: number } | null {
  const headings = state.sidecar.headings;
  for (let at = 0; at < headings.length; at += 1) {
    const resolved = resolveAnchor(headings[at].anchor, state.root, { ...options, candidates });
    if (resolved !== null && resolved.anchor.pos[0] === target.pos[0]) {
      return { entry: headings[at], at };
    }
  }
  return null;
}

/** The heading candidate of section `index`, or a RangeError. */
function headingCandidate(
  root: Root,
  index: number,
  candidates: readonly AnchorCandidate[],
): AnchorCandidate {
  const sections = sectionsOf(root);
  if (!Number.isInteger(index) || index < 0 || index >= sections.length) {
    throw new RangeError(`outline: section ${index} is outside 0..${sections.length - 1}`);
  }
  const start = sections[index].start;
  // Every top-level heading is a candidate (`candidatesOf`), so the find cannot miss.
  return candidates.find(
    (one) => one.kind === "heading" && one.pos[0] === start,
  ) as AnchorCandidate;
}

/** The Outline's rows, in document order. Pure. */
export function outlineOf(state: DocumentState, options: SegmentOptions = {}): OutlineItem[] {
  const candidates = candidatesOf(state.root, options);
  return sectionsOf(state.root).map((section, index) => {
    const found = entryFor(state, headingCandidate(state.root, index, candidates), candidates, options);
    return {
      index,
      depth: section.depth,
      text: normalizedText(section.heading),
      question: found === null ? "" : found.entry.question,
    };
  });
}

/**
 * Set section `index`'s question. The entry anchored to that heading is updated (its anchor
 * rebuilt at the heading's current position) or created; an empty question removes it, which is
 * what an empty question field means. The Markdown is never touched: `root` is returned by
 * reference.
 *
 * @throws RangeError if `index` is not a section of the document.
 */
export function applySetQuestion(
  state: DocumentState,
  index: number,
  question: string,
  options: SegmentOptions = {},
): DocumentState {
  const candidates = candidatesOf(state.root, options);
  const target = headingCandidate(state.root, index, candidates);
  const found = entryFor(state, target, candidates, options);
  const headings = [...state.sidecar.headings];
  if (question === "") {
    if (found === null) return state;
    headings.splice(found.at, 1);
  } else if (found === null) {
    headings.push({ anchor: anchorOf(target), question });
  } else {
    if (found.entry.question === question) return state;
    headings[found.at] = { anchor: anchorOf(target), question };
  }
  return { root: state.root, sidecar: { ...state.sidecar, headings } };
}

/**
 * Whether the topic question can be edited in-app (§6.1's supported boundary): no front-matter
 * `question:` key, or one the writer can rewrite. A read-only key makes the Outline show the value
 * greyed with 'Edit this in the source view'.
 */
export function topicQuestionEditable(root: Root): boolean {
  const entry = readFrontMatter(root).question;
  return entry === null || entry.writable;
}

/**
 * Set the topic question (§6.1, §6.2): the sidecar's `topicQuestion`, mirrored into the front
 * matter's `question:` line when the document has a front-matter block — the one in-app edit
 * §6.1 lets rewrite that line, and only that line. A document without front matter keeps its
 * Markdown (creating a block is not the app's job, `writeFrontMatter`'s `no-front-matter`). An
 * empty field clears the sidecar's value; a front-matter line that exists is rewritten to the
 * empty scalar, and a block without one gains none.
 *
 * @returns `state` itself when nothing changes, or when the front-matter key is read-only (the
 * field is not offered then, and this refuses rather than letting the sidecar and the block
 * disagree).
 */
export function applySetTopicQuestion(state: DocumentState, question: string): DocumentState {
  if (!topicQuestionEditable(state.root)) return state;
  // An empty field never adds a `question:` line the block did not have.
  const absent = question === "" && readFrontMatter(state.root).question === null;
  const written = absent ? { ok: true as const, root: state.root } : writeFrontMatter(state.root, { question });
  // A value with a line break is the one refusal left once the key is editable; the field is one
  // line, so this only guards a caller that is not the field.
  if (!written.ok && written.reason !== "no-front-matter") return state;
  const topicQuestion = question === "" ? null : question;
  if (written.root === state.root && state.sidecar.topicQuestion === topicQuestion) return state;
  return { root: written.root, sidecar: { ...state.sidecar, topicQuestion } };
}

/** The depth "New question" gives a heading: a supporting question is an H2 (§6.1, "H2/H3/…"). */
export const NEW_QUESTION_DEPTH = 2;

/**
 * "New question" (§6.3): append a heading whose text is the question, with the question anchored
 * to it in the sidecar. §6.3's "+ empty paragraph" has no Markdown spelling — an empty paragraph
 * serialises to nothing and does not survive a parse — so the document gains the heading alone and
 * the writer starts its first paragraph from the heading in the editor.
 *
 * @returns `state` itself for a question that is empty after trimming.
 */
export function applyNewQuestion(
  state: DocumentState,
  question: string,
  options: SegmentOptions = {},
): DocumentState {
  const text = question.trim();
  if (text === "") return state;
  const heading: Heading = {
    type: "heading",
    depth: NEW_QUESTION_DEPTH,
    children: [{ type: "text", value: text }],
  };
  const root: Root = { ...state.root, children: [...state.root.children, heading] };
  const appended: DocumentState = { root, sidecar: state.sidecar };
  return applySetQuestion(appended, sectionsOf(root).length - 1, text, options);
}

/**
 * Where an Outline drop puts the dragged section, as `moveSectionTo`'s boundary and depth, or null
 * for a drop that is refused. `over` is the row the drag ended on; `nest` says the drag ended in
 * that row's nesting zone (offset to the right).
 *
 * - **Nest**: the section becomes the last child of `over`, one level deeper.
 * - **Reorder**: the section becomes `over`'s sibling at `over`'s depth — in front of `over` when
 *   dragged up, after `over`'s whole section when dragged down (the way `moveSection` lands).
 *
 * Refused: a drop on the dragged row itself or on a row inside the dragged section (a section
 * cannot go inside itself), and a depth the dragged section's deepest heading cannot take.
 */
export function outlineDrop(
  root: Root,
  from: number,
  over: number,
  nest: boolean,
): { readonly index: number; readonly depth: number } | null {
  const sections = sectionsOf(root);
  const source = sections[from];
  const target = sections[over];
  if (source === undefined || target === undefined) return null;
  if (target.start >= source.start && target.start < source.end) return null;
  let deepest = source.depth;
  for (const node of source.nodes) {
    if (node.type === "heading") deepest = Math.max(deepest, node.depth);
  }
  const depth = nest ? target.depth + 1 : target.depth;
  if (deepest - source.depth + depth > 6) return null;
  if (nest) return { index: target.end, depth };
  return { index: over < from ? target.start : target.end, depth };
}

/**
 * An Outline drop (see {@link outlineDrop}) with the sidecar carried along: every anchor inside the
 * dragged section travels with it, and the depths and enclosing sections its anchors record are
 * rebuilt. A refused drop, and one that changes neither place nor depth, returns `state`.
 */
export function applyOutlineDrop(
  state: DocumentState,
  from: number,
  over: number,
  nest: boolean,
  options: SegmentOptions = {},
): DocumentState {
  const drop = outlineDrop(state.root, from, over, nest);
  if (drop === null) return state;
  const source = sectionsOf(state.root)[from];
  const stays = drop.index === source.start || drop.index === source.end;
  if (stays && drop.depth === source.depth) return state;
  return carryTopLevelMove(
    state,
    (root) => moveSectionTo(root, from, drop.index, drop.depth),
    options,
  );
}
