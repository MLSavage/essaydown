import type { Root } from "mdast";
import type { DocumentState, Sidecar } from "./sidecar.js";

/**
 * The snapshot undo stack of PRD §6.5.
 *
 * The document store owns exactly one stack of `{root, sidecar}` snapshots. Every committed
 * mutation pushes one: a coalesced typing burst, a CodeMirror edit burst, and each mode mutation
 * (rewrite "Use this", reorder drop, outline move/nest, question edit). Undoing "Use this"
 * therefore restores the sentence *and* the sidecar's `chosen` field, because a snapshot holds
 * both halves and they can never come apart.
 *
 * Purity (PRD §9, CLAUDE.md): the stack is a value, not an object with hidden state. The task's
 * `push(root, sidecar, {coalesceKey, at})` is spelled here as
 * `push(stack, root, sidecar, {coalesceKey, at})` — the stack is the injected state the store
 * owns, and every function returns a new stack rather than mutating one.
 *
 * Structural sharing: a snapshot is stored **by reference**. Nothing here clones a tree, so two
 * consecutive snapshots share every subtree the mutation between them did not rebuild, and 500
 * retained snapshots of a long essay cost 500 root objects rather than 500 copies of the essay.
 * The contract that makes this safe is that a pushed `root`/`sidecar` is never mutated in place;
 * every mutation produces a new value (`blocks.ts`, `sidecar.ts`) and pushes that.
 */

/** §6.5: ProseMirror/CodeMirror transactions within 1 s of each other merge into one step. */
export const COALESCE_WINDOW_MS = 1_000;

/** §6.5: the stack is capped at 500 snapshots; the oldest are dropped first. */
export const UNDO_CAP = 500;

/** One snapshot, with the coalescing group it belongs to and the time it was pushed. */
export interface UndoEntry {
  /** The committed document state: both halves, always together. */
  readonly state: DocumentState;
  /** The key its push carried; `null` for a push that may never merge with a neighbour. */
  readonly coalesceKey: string | null;
  /** When the snapshot was pushed (ms). For a coalesced group, the time of its *latest* push. */
  readonly at: number;
}

/**
 * The stack itself. `entries[index]` is the state the document currently shows; everything before
 * it is undo history and everything after it is redo history.
 */
export interface UndoStack {
  /** Oldest first. Never empty: `createUndoStack` seeds the document as it was opened. */
  readonly entries: readonly UndoEntry[];
  /** Index of the present state within {@link entries}. */
  readonly index: number;
  /**
   * The key of the coalescing group still open at `entries[index]`, or `null` when no group is
   * open — after a push with no key, after an undo or a redo, and after
   * {@link endCoalescing} (the source/rendered toggle of §6.5).
   */
  readonly openKey: string | null;
  /** Maximum number of retained snapshots. */
  readonly cap: number;
  /** Two pushes with the same key no further apart than this merge. */
  readonly coalesceWindowMs: number;
}

/** Overrides for {@link createUndoStack}; the defaults are the §6.5 numbers. */
export interface UndoStackOptions {
  readonly cap?: number;
  readonly coalesceWindowMs?: number;
  /** The time recorded for the seed snapshot. */
  readonly at?: number;
}

/** Options for {@link push}. */
export interface PushOptions {
  /**
   * The burst this mutation belongs to — `"typing"` for a ProseMirror burst, `"source"` for a
   * CodeMirror one. A mode mutation passes nothing: a push with no key neither merges into the
   * entry below it nor lets the next push merge into it, so two "Use this" clicks a moment apart
   * are always two undo steps.
   */
  readonly coalesceKey?: string | null;
  /**
   * When the mutation was committed (ms). The clock is injected so the stack stays pure and its
   * tests are not timing-dependent; `Date.now()` is only the default for a caller that has no
   * better time to hand.
   */
  readonly at?: number;
}

function validate(cap: number, coalesceWindowMs: number): void {
  if (!Number.isInteger(cap) || cap < 1) {
    throw new RangeError(`undo cap must be a positive integer, got ${cap}`);
  }
  if (!Number.isFinite(coalesceWindowMs) || coalesceWindowMs < 0) {
    throw new RangeError(`coalesce window must be a non-negative number, got ${coalesceWindowMs}`);
  }
}

/**
 * A stack holding one snapshot: the document as it was opened. That seed is what the first Undo
 * after the first edit restores, so a stack is never empty and `entries[index]` always exists.
 */
export function createUndoStack(
  root: Root,
  sidecar: Sidecar,
  options: UndoStackOptions = {},
): UndoStack {
  const cap = options.cap ?? UNDO_CAP;
  const coalesceWindowMs = options.coalesceWindowMs ?? COALESCE_WINDOW_MS;
  validate(cap, coalesceWindowMs);
  return {
    entries: [{ state: { root, sidecar }, coalesceKey: null, at: options.at ?? Date.now() }],
    index: 0,
    openKey: null,
    cap,
    coalesceWindowMs,
  };
}

/** The state the document currently shows. */
export function current(stack: UndoStack): DocumentState {
  return stack.entries[stack.index].state;
}

/** Whether there is an older snapshot to go back to. */
export function canUndo(stack: UndoStack): boolean {
  return stack.index > 0;
}

/** Whether an undone snapshot is waiting to be redone. */
export function canRedo(stack: UndoStack): boolean {
  return stack.index < stack.entries.length - 1;
}

/**
 * End the open coalescing group without pushing anything (§6.5: a source/rendered toggle is not an
 * edit, so the first Undo after a toggle undoes the last real edit, and the edit after a toggle
 * starts its own step). Returns the same stack when no group is open.
 */
export function endCoalescing(stack: UndoStack): UndoStack {
  return stack.openKey === null ? stack : { ...stack, openKey: null };
}

/**
 * Push a committed mutation.
 *
 * The push merges into the present entry — one undo step instead of two — when it carries a key,
 * that key is the open group's, and it lands no more than `coalesceWindowMs` after the group's
 * latest push. The window slides: §6.5 merges transactions "within 1 s of each other", so an
 * unbroken typing burst stays one step however long it runs, and one second of silence closes it.
 * A key can only ever merge into a group that is still open, and an undo, a redo or an
 * {@link endCoalescing} closes it, so a push never reaches back past one of those.
 *
 * Any redo history is discarded, as it is in every editor: an edit made after an undo is a new
 * branch and the abandoned one is gone. Once the stack is over `cap` the oldest snapshots are
 * dropped; the retained entries keep their identity, so dropping the tail costs no copying.
 */
export function push(
  stack: UndoStack,
  root: Root,
  sidecar: Sidecar,
  options: PushOptions = {},
): UndoStack {
  const coalesceKey = options.coalesceKey ?? null;
  const at = options.at ?? Date.now();
  const present = stack.entries[stack.index];
  const entry: UndoEntry = { state: { root, sidecar }, coalesceKey, at };

  // A clock that went backwards starts a new step rather than merging into an entry it precedes.
  const withinWindow = at >= present.at && at - present.at <= stack.coalesceWindowMs;
  if (coalesceKey !== null && stack.openKey === coalesceKey && withinWindow) {
    // `openKey` is only ever non-null on the newest entry, so there is no redo tail to discard.
    const entries = stack.entries.slice();
    entries[stack.index] = entry;
    return { ...stack, entries };
  }

  const kept = stack.entries.slice(0, stack.index + 1);
  kept.push(entry);
  const overflow = Math.max(0, kept.length - stack.cap);
  const entries = overflow === 0 ? kept : kept.slice(overflow);
  return { ...stack, entries, index: entries.length - 1, openKey: coalesceKey };
}

/**
 * Step back one snapshot, closing any open coalescing group. Returns a stack with the same history
 * when there is nothing left to undo, so the caller can call it unconditionally.
 */
export function undo(stack: UndoStack): UndoStack {
  if (!canUndo(stack)) return endCoalescing(stack);
  return { ...stack, index: stack.index - 1, openKey: null };
}

/** Step forward one snapshot, closing any open coalescing group. A no-op at the newest snapshot. */
export function redo(stack: UndoStack): UndoStack {
  if (!canRedo(stack)) return endCoalescing(stack);
  return { ...stack, index: stack.index + 1, openKey: null };
}
