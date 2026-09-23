import type { Nodes, Root } from "mdast";
import type { Options } from "remark-stringify";
import type { Data, Processor } from "unified";
import { createFormatter, wideningGiveUps, type RecordedGiveUp } from "./format.js";

type ToMarkdownExtensions = NonNullable<Data["toMarkdownExtensions"]>;
type StringifyHandlers = NonNullable<Options["handlers"]>;
type Handle = NonNullable<StringifyHandlers[keyof StringifyHandlers]>;
type ToMarkdownState = Parameters<Handle>[2];
type IndentLines = ToMarkdownState["indentLines"];

/** The path of the root node. Child `i` of the root is `"i"`, its child `j` is `"i.j"`. */
export const ROOT_PATH = "";

/** A half-open range in the canonical string: 1-based lines, 1-based columns, end exclusive. */
export interface NodeRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

/** One mdast node's place in the canonical string, keyed by its path from the root. */
export interface PositionEntry extends NodeRange {
  path: string;
  node: Nodes;
}

/**
 * The position map of one canonical string.
 *
 * `ranges` is the acceptance's map: every mdast node, by path, to its range. `entries` carries
 * the same ranges in document (pre-)order with the node itself attached, and is what
 * {@link nodeAt} searches. `unresolved` lists the paths of nodes that could not be placed —
 * empty for every fixture in the corpus, and the check that keeps "every node" honest.
 *
 * `unresolved` carries a second kind of entry, of the same shape and with the same meaning — this
 * node's place in the canonical string is not known to be right (DECISIONS #review-1-r8 N3). The
 * serializer's per-child widening walk (`widenSplitSurrogateReferences` in format.ts) stops at a
 * child whose bytes none of its enumerated forms match, leaving that child and every later
 * sibling unwidened; that child and those siblings are reported here, as is the one child whose
 * edit the walk had to drop as an overlap. The walk's own enumeration is stricter than
 * {@link locateEmission}'s, so this is the only guard that can go red when it gives up: a path
 * appears here whether or not the node was placed.
 */
export interface PositionMap {
  ranges: Record<string, NodeRange>;
  entries: PositionEntry[];
  unresolved: string[];
}

/**
 * Where each character of one `text` node's `value` is written.
 *
 * A node's range says where the node is; this says where its *characters* are, which is not the
 * same thing wherever the serializer writes a character as more than itself. `starts[i]` and
 * `ends[i]` are the half-open offsets of the spelling of value character `i`, and
 * `starts[value.length]` is the offset one past the last spelling, so the cursor at the end of the
 * value has an answer too.
 *
 * **Ownership rule.** The spellings are adjacent half-open slices, one per character, in order:
 * character `i` owns its whole spelling, the escaping backslash of `\*` and every byte of a
 * character reference `&#x20;` included, so a cursor anywhere inside one is *before* that
 * character and never inside its escape. What lies between two spellings — `ends[i]` up to
 * `starts[i + 1]`, which is a continuation prefix (`> `, a list item's indentation) and nothing
 * else — is owned by no character; {@link spellingIndex} gives it to the character after it,
 * because that character is the first on the prefix's own line.
 *
 * Exactly one character has an empty spelling: the trailing UTF-16 unit of a surrogate pair the
 * serializer wrote as one character reference (`&#x1F600;` for 😀 — the neighbour of an attention
 * run, task 1.45's whole-scalar form). `value` counts the pair as two characters and the bytes
 * hold one indivisible spelling, so the leading unit owns the whole reference (`starts[i]` at
 * `&`, `ends[i]` one past `;`) and the trailing unit is a zero-width item at the reference's end
 * (`starts[i + 1]` and `ends[i + 1]` both equal to `ends[i]`). {@link spellingPoint} of the
 * position between the two units — a position ProseMirror can name, counting units, but the
 * editor never offers — is therefore the reference's end, and every other position of the node is
 * monotone; {@link spellingIndex} never answers the trailing unit (an offset at the reference's
 * end is past both, and belongs to the character after). A raw surrogate pair in plain text keeps
 * its two one-unit spellings. Every other rule in {@link spellingOffsets} consumes at least one
 * character.
 *
 * **Line ending as space.** A `text` value ending in a line ending whose next sibling is `html`
 * has that line ending written as one space by the parent (`container-phrasing.js` 66–75, the
 * third branch {@link rewrittenEmissions} names). The line ending is one UTF-16 unit (`\n`, the
 * only one `parse` leaves in a value) and the space is one unit, so the space is recorded as the
 * line ending's spelling at the same offset — one unit for one unit — and every offset before and
 * after it is unchanged. A `\r\n` value ending (never produced by `parse`, but a tree is any
 * `Root`) follows the surrogate rule above: `\r` owns the space, `\n` is zero width at its end.
 *
 * **Inline code.** An `inlineCode` node's characters are its `value`, written one UTF-16 unit per
 * unit between the fence and its optional padding (`lib/handle/inline-code.js`: the fence is as
 * many backticks as it takes to differ from every backtick run in the value, lines 19–24; one
 * space of padding on each side when the value starts *and* ends with a space or line ending, or
 * starts or ends with a backtick, lines 26–33; a line ending followed by something that would open
 * a block is written as a space, lines 42–66, one unit for one unit). The fence and the padding are
 * owned by no character: the position before the first character maps to the offset after the
 * opening fence and padding (`starts[0]`), and the position after the last character to the offset
 * before the closing padding and fence (`starts[value.length]`), so `spellingPoint` and
 * `spellingIndex` read the table exactly as they read a `text` node's, and an offset on the fence
 * or the padding belongs to the character after it (the opening side) or to the end of the value
 * (the closing side).
 *
 * **Inline code inside a table cell.** The handler this serializer dispatches for `inlineCode` is
 * not that base handler but `inlineCodeWithTable`, which `mdast-util-gfm-table` (2.0.0) installs
 * at `lib/index.js` lines 291–298: it calls `defaultHandlers.inlineCode` and then, and only when
 * `state.stack` includes `tableCell`, rewrites every `|` of that output as `\\|`
 * (`value.replace(/\|/g, '\\$&')`, line 296). The rule is read from those two branches and never
 * from the base handler (DECISIONS #review-1-r4 J2). Below a `table` emission — and nowhere else,
 * because the extension dispatches no `tableRow` or `tableCell` through `state.handle`, so every
 * node dispatched there was written with `tableCell` on the stack — a `|` of the value is
 * therefore written as the two units `\\|`, and **the pipe owns both of them**: `starts[i]` at the
 * backslash, `ends[i]` one past the pipe, the shape the character-reference rule above already
 * has, so no position of the value lands between the two units and the backslash is never a
 * character of the value. The length and padding checks count those extra units. Outside a table
 * the wrapper does nothing and a `\\|` in the bytes is two characters of the value, one unit each.
 * The wrapper touches only `|`: the fence and the padding are the base handler's in both cases.
 * See {@link inlineCodeSpelling}.
 */
export interface SpellingTable {
  /** `starts[i]` is where value character `i`'s spelling begins; `starts[n]` is the last end. */
  readonly starts: readonly number[];
  /** `ends[i]` is one past the end of value character `i`'s spelling. */
  readonly ends: readonly number[];
}

/** {@link formatWithMap}'s result: the canonical string, its position map and its spellings. */
export interface FormatWithMapResult {
  text: string;
  map: PositionMap;
  /**
   * One {@link SpellingTable} per `text` and `inlineCode` node of the tree, by path — the node's
   * characters in `text`'s own offsets. A node the serializer wrote in a way
   * {@link spellingOffsets} or {@link inlineCodeSpelling} cannot account for has no entry, and so
   * does every node of any other type: only a `text` node's and an `inlineCode` node's bytes are
   * its characters (see {@link formatWithMap}).
   */
  spellings: Record<string, SpellingTable>;
  /** The offset each line of `text` starts at: 1-based line `n` is at index `n - 1`. */
  lineStarts: readonly number[];
}

/** A half-open character span `[start, end)` of the canonical string. */
interface Span {
  start: number;
  end: number;
}

/** The `state.indentLines` call one node made: what went in, and what came out. */
interface Indent {
  source: string;
  result: string;
}

/** What one wrapped handler emitted, and what its own dispatched descendants emitted. */
interface Emission {
  node: Nodes;
  value: string;
  indent?: Indent;
  children: Emission[];
}

/** Instrumentation shared by every wrapped handler of one `formatWithMap` call. */
interface Instrumentation {
  stack: Emission[];
  patched: boolean;
  /**
   * The `State` `mdast-util-to-markdown` built for this call, captured by {@link wrapHandle} on
   * the first dispatched node — the same "first moment a `State` is in reach" the two installers
   * of format.ts use. It is what {@link wideningGiveUps} is read off; `undefined` only for a tree
   * that dispatches nothing at all, which is a tree with no child for a walk to give up on.
   */
  state?: ToMarkdownState;
}

/** Maps an offset in some intermediate string to its offset in a string built out of it. */
export type OffsetMap = (offset: number) => number;

/** One line of a string: its text without the line ending, and the offset it starts at. */
interface Line {
  text: string;
  start: number;
}

/**
 * Format `root` and record where every node landed.
 *
 * The map is built by instrumenting the serializer rather than by re-parsing its output: every
 * `mdast-util-to-markdown` handler is wrapped so that each dispatched node's own output string
 * is captured, and `state.indentLines` — the one funnel through which `blockquote` and
 * `listItem` prefix their children's lines — is wrapped so that the prefixes it inserts are
 * known exactly. Each node's string is then located inside its parent's, from a cursor that only
 * moves forward, so a node's range is always inside its parent's and siblings never overlap.
 *
 * Ownership rule for zero-width items: a node whose output is the empty string owns no
 * character. Its range is empty (`start === end`) and sits at the cursor, i.e. immediately after
 * the end of the previous sibling that produced output — so it is never returned by
 * {@link nodeAt}, and the character at that position belongs to whatever else covers it.
 *
 * Some nodes get their range from something other than their own output. The root spans the whole
 * string, trailing newline included. `tableRow` and `tableCell` are never dispatched by
 * `mdast-util-gfm-table` (it serializes a table's cells into a matrix and lets `markdown-table`
 * align them), so they are placed from the grid the serializer wrote — see
 * {@link placeTableGrid}, which is also where the zero-width rule above applies to an empty cell.
 * Any node still without a range after all that takes the hull of the descendants that were
 * dispatched, and one with no dispatched descendant either is reported in `unresolved`.
 *
 * The serializer this runs is `createFormatter()`'s, so the app's own `root` handler runs and
 * installs the per-child widening walk and the autolink fallback exactly as `format` does — the
 * instrumented handlers are pushed as one more extension and `root` is not among them. Every
 * give-up that walk records on the `State` is therefore this call's own, and is reported in
 * `map.unresolved` as the path of the child it names (DECISIONS #review-1-r8 N3, see
 * {@link PositionMap}).
 *
 * `formatWithMap(root).text` is `format(root)`, and the map is a pure function of `root`: the
 * tree is never mutated and nothing is carried between calls.
 */
export function formatWithMap(root: Root): FormatWithMapResult {
  const rootEmission: Emission = { node: root, value: "", children: [] };
  const instrumentation: Instrumentation = { stack: [rootEmission], patched: false };
  const giveUpsOfThisCall = (): readonly RecordedGiveUp[] =>
    instrumentation.state === undefined ? [] : wideningGiveUps(instrumentation.state);
  const handlers = wrapHandlers(configuredHandlers(), instrumentation);
  const text = createFormatter()
    .use(function instrument(this: Processor) {
      const data = this.data();
      const extensions: ToMarkdownExtensions = (data.toMarkdownExtensions ??= []);
      extensions.push({ handlers });
    })
    .stringify(root);
  rootEmission.value = text;

  const spans = new Map<Nodes, Span>();
  const written = new Map<Nodes, SpellingTable>();
  spans.set(root, { start: 0, end: text.length });
  placeChildren(rootEmission, (offset) => offset, spans, written, false);
  const map = buildMap(root, text, spans, giveUpsOfThisCall());
  const spellings: Record<string, SpellingTable> = {};
  for (const entry of map.entries) {
    const table = written.get(entry.node);
    if (table !== undefined) spellings[entry.path] = table;
  }
  return { text, map, spellings, lineStarts: lineStartsOf(text) };
}

/**
 * The innermost node whose range contains (`line`, `column`), or `null` when no node does — a
 * blank line between two blocks belongs to neither of them. The root is never returned: it spans
 * the whole string by construction, so it would answer every query.
 */
export function nodeAt(map: PositionMap, line: number, column: number): PositionEntry | null {
  let best: PositionEntry | null = null;
  let bestDepth = -1;
  for (const entry of map.entries) {
    if (entry.path === ROOT_PATH) continue;
    if (!rangeContains(entry, line, column)) continue;
    const depth = pathDepth(entry.path);
    if (depth > bestDepth) {
      best = entry;
      bestDepth = depth;
    }
  }
  return best;
}

/** Whether the half-open `range` covers (`line`, `column`). An empty range covers nothing. */
export function rangeContains(range: NodeRange, line: number, column: number): boolean {
  if (line < range.startLine || line > range.endLine) return false;
  if (line === range.startLine && column < range.startCol) return false;
  if (line === range.endLine && column >= range.endCol) return false;
  return true;
}

/** The number of steps from the root to `path`: `ROOT_PATH` is 0, `"3.1"` is 2. */
export function pathDepth(path: string): number {
  return path === ROOT_PATH ? 0 : path.split(".").length;
}

/* ------------------------------------------------------------------ character spellings -- */

/**
 * Line up `value`, a `text` node's characters, with `written`, the Markdown that spells them,
 * starting at offset `from`. The result is in `written`'s own offsets; `undefined` when `written`
 * does not spell `value` under the rules below, so a caller is never handed a wrong alignment.
 *
 * One source character per character is exactly what does *not* hold here, which is the whole
 * reason this exists: a character is written either as itself, or escaped with a backslash
 * (`\*`), or as a numeric character reference (`&#x20;`, `&#42;` — what `mdast-util-to-markdown`
 * emits where a backslash would not be read as an escape). The escape rule is tried first, so the
 * two characters of `\\` are read as the one escaped backslash they spell rather than as a
 * backslash that happens to precede one.
 *
 * Between two characters there may also be something that spells no character at all: the
 * continuation prefix a blockquote (`> `) or a list item (indentation) puts at the start of every
 * line after the first. It is skipped, but only immediately after a line ending and only over
 * characters that can *be* a prefix, so a real mismatch is still a refusal rather than a silent
 * resynchronisation. {@link SpellingTable} states which character owns it.
 *
 * `eolAsSpace` is set by {@link placeChildren} exactly when the child was found in the form the
 * parent rewrote before an `html` sibling ({@link rewrittenEmissions}' fourth candidate): the
 * value's trailing line ending is then spelled by the one space at its offset, the rule
 * {@link SpellingTable} states. It is never tried otherwise, so a space in the bytes is not read
 * as a line ending anywhere else.
 *
 * Pure: it reads two strings and allocates two arrays.
 */
export function spellingOffsets(
  value: string,
  written: string,
  from = 0,
  eolAsSpace = false,
): SpellingTable | undefined {
  const starts: number[] = [];
  const ends: number[] = [];
  let at = from;
  let afterLineEnding = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    // The trailing line ending the parent wrote as one space: the first unit owns the space, a
    // second unit (`\r\n`) is the zero-width item at its end, as for a surrogate pair.
    if (eolAsSpace && written.charAt(at) === SPACE && isTrailingLineEnding(value, index)) {
      starts.push(at);
      ends.push(at + 1);
      if (index + 1 < value.length) {
        starts.push(at + 1);
        ends.push(at + 1);
      }
      at += 1;
      break;
    }
    // The direct match is tried first, so a prefix character is only ever skipped where it does
    // not spell the character being placed.
    while (
      afterLineEnding &&
      spellingEnd(written, at, character) === undefined &&
      CONTINUATION.has(written.charAt(at))
    ) {
      at += 1;
    }
    let end = spellingEnd(written, at, character);
    // A surrogate pair written as one reference: the leading unit takes the whole reference and
    // the trailing unit is the zero-width item {@link SpellingTable}'s ownership rule names. The
    // raw pair was tried first (one unit at a time), so it keeps its two one-unit spellings.
    const trailing = value[index + 1];
    const pair =
      end === undefined && isHighSurrogate(character) && trailing !== undefined && isLowSurrogate(trailing);
    if (pair) end = referenceEnd(written, at, character + trailing);
    if (end === undefined) return undefined;
    starts.push(at);
    ends.push(end);
    if (pair) {
      starts.push(end);
      ends.push(end);
      index += 1;
    }
    at = end;
    afterLineEnding = character === "\n";
  }
  starts.push(at);
  return { starts, ends };
}

/** The characters a continuation prefix is made of: a blockquote's marker and indentation. */
const CONTINUATION = new Set([" ", "\t", ">"]);

/** The one space `container-phrasing.js` writes for a line ending before `html`. */
const SPACE = " ";

/** The line endings `container-phrasing.js` replaces: `/(\r?\n|\r)$/`, read at line 72. */
const TRAILING_LINE_ENDING = /(\r?\n|\r)$/;

/** Whether the rest of `value` from `index` is exactly its trailing line ending. */
function isTrailingLineEnding(value: string, index: number): boolean {
  const rest = value.slice(index);
  return rest === "\n" || rest === "\r" || rest === "\r\n";
}

/** A numeric character reference, hexadecimal or decimal — the two spellings `safe` can emit. */
const REFERENCE = /^&#(?:x([0-9a-f]+)|([0-9]+));/i;

/**
 * One past the end of `character`'s spelling at `at` in `written`, or `undefined` for no match.
 * `character` is one UTF-16 unit: a reference is read here only for a BMP character, and
 * {@link spellingOffsets} asks {@link referenceEnd} about a whole surrogate pair itself.
 */
function spellingEnd(written: string, at: number, character: string): number | undefined {
  if (written.startsWith(`\\${character}`, at)) return at + 2;
  if (written.startsWith(character, at)) return at + 1;
  return referenceEnd(written, at, character);
}

/**
 * One past the end of the numeric character reference at `at` in `written` that decodes to
 * `spelled` (one code point, as one or two UTF-16 units), or `undefined` when none does.
 */
function referenceEnd(written: string, at: number, spelled: string): number | undefined {
  const reference = REFERENCE.exec(written.slice(at, at + REFERENCE_LIMIT));
  if (reference === null) return undefined;
  const [hexadecimal, decimal] = [reference[1], reference[2]];
  const code = hexadecimal === undefined ? Number(decimal) : Number.parseInt(hexadecimal, 16);
  return String.fromCodePoint(code) === spelled ? at + reference[0].length : undefined;
}

/** Whether `unit` (one UTF-16 unit) is the leading half of a surrogate pair. */
function isHighSurrogate(unit: string): boolean {
  const code = unit.charCodeAt(0);
  return code >= 0xd800 && code <= 0xdbff;
}

/** Whether `unit` (one UTF-16 unit) is the trailing half of a surrogate pair. */
function isLowSurrogate(unit: string): boolean {
  const code = unit.charCodeAt(0);
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Longer than any reference `safe` writes (`&#x10FFFF;`), so the match never scans the rest. */
const REFERENCE_LIMIT = 12;

/** A spelling table's offsets carried from one string into the string it was written into. */
function absoluteSpelling(table: SpellingTable, toAbsolute: OffsetMap): SpellingTable {
  const ends = table.ends.map((offset) => toAbsolute(offset - 1) + 1);
  // The last entry of `starts` is one past the last spelling, so it is mapped like an end.
  const starts = table.starts.map((offset, index) =>
    index < ends.length ? toAbsolute(offset) : toAbsolute(offset - 1) + 1,
  );
  return { starts, ends };
}

/** The offset each line of `text` starts at. `text` is canonical, so LF is the only terminator. */
export function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === LINE_FEED) starts.push(index + 1);
  }
  return starts;
}

const LINE_FEED = 10;

/** The offset of (`line`, `column`) in the string `lineStarts` describes, clamped into it. */
export function offsetOf(lineStarts: readonly number[], line: number, column: number): number {
  const index = Math.min(Math.max(line, 1), lineStarts.length) - 1;
  return lineStarts[index] + Math.max(column - 1, 0);
}

/** The 1-based (line, column) where value character `index`'s spelling begins, `index` clamped. */
export function spellingPoint(
  lineStarts: readonly number[],
  table: SpellingTable,
  index: number,
): { line: number; column: number } {
  const clamped = Math.min(Math.max(index, 0), table.starts.length - 1);
  return pointOf(lineStarts, table.starts[clamped]);
}

/**
 * Which character of the value owns (`line`, `column`), by the ownership rule of
 * {@link SpellingTable}: the first whose spelling has not ended yet, and the end of the value for
 * a position past the last spelling.
 */
export function spellingIndex(
  lineStarts: readonly number[],
  table: SpellingTable,
  line: number,
  column: number,
): number {
  const offset = offsetOf(lineStarts, line, column);
  for (let index = 0; index < table.ends.length; index += 1) {
    if (offset < table.ends[index]) return index;
  }
  return table.ends.length;
}

/** The 1-based (line, column) of `offset` in the string `lineStarts` describes. */
function pointOf(lineStarts: readonly number[], offset: number): { line: number; column: number } {
  let index = lineStarts.length - 1;
  while (index > 0 && lineStarts[index] > offset) index -= 1;
  return { line: index + 1, column: offset - lineStarts[index] + 1 };
}

/** The path of child `index` of the node at `path`. */
export function childPath(path: string, index: number): string {
  return path === ROOT_PATH ? String(index) : `${path}.${index}`;
}

/**
 * The handler set the formatter of `format.ts` actually runs with: the `mdast-util-to-markdown`
 * defaults, plus everything `remark-stringify` and the GFM and opaque extensions install on top.
 * Read off a real `State` rather than re-composed here, so a change to `createFormatter` cannot
 * leave a handler unwrapped. `root` is this probe's own handler and is dropped: the root is not
 * instrumented, its range is the whole string.
 */
function configuredHandlers(): StringifyHandlers {
  const captured: StringifyHandlers = {};
  createFormatter()
    .use(function capture(this: Processor) {
      const data = this.data();
      const extensions: ToMarkdownExtensions = (data.toMarkdownExtensions ??= []);
      extensions.push({
        handlers: {
          root: (_node, _parent, state) => {
            Object.assign(captured, state.handlers);
            return "";
          },
        },
      });
    })
    .stringify({ type: "root", children: [] });
  delete captured.root;
  return captured;
}

/** Wrap every configured handler so each dispatched node records what it emitted. */
function wrapHandlers(
  originals: StringifyHandlers,
  instrumentation: Instrumentation,
): StringifyHandlers {
  const wrapped: StringifyHandlers = {};
  // `configuredHandlers` reads a real `State.handlers`, which is a total record: every entry is
  // a function, so the `Partial` of the options type never has a hole here.
  for (const [type, original] of Object.entries(originals) as [keyof StringifyHandlers, Handle][]) {
    wrapped[type] = wrapHandle(original, instrumentation);
  }
  return wrapped;
}

/**
 * One handler, wrapped. The wrapper is transparent — it returns exactly what the original
 * returned and carries the original's `peek` — because `containerPhrasing` reads `peek` off the
 * installed handler and, for a handler that has none, calls the handler itself to look ahead at
 * the next sibling. Those speculative calls record an emission that is thrown away again by
 * {@link lastPerNode}.
 */
function wrapHandle(original: Handle, instrumentation: Instrumentation): Handle {
  const handle: Handle = (node, parent, state, info) => {
    instrumentation.state ??= state;
    patchIndentLines(state, instrumentation);
    const emission: Emission = { node, value: "", children: [] };
    const { stack } = instrumentation;
    stack.push(emission);
    let value: string;
    try {
      value = original(node, parent, state, info);
    } finally {
      stack.pop();
    }
    emission.value = value;
    stack[stack.length - 1].children.push(emission);
    return value;
  };
  const peek = (original as Handle & { peek?: Handle }).peek;
  if (peek) (handle as Handle & { peek?: Handle }).peek = peek;
  return handle;
}

/**
 * Record the line prefixes `blockquote` and `listItem` add to their children. `state` is created
 * per serialization, so this patches nothing that outlives the call; it is applied on the first
 * dispatched node because that is the first moment a `State` is in reach.
 */
function patchIndentLines(state: ToMarkdownState, instrumentation: Instrumentation): void {
  if (instrumentation.patched) return;
  instrumentation.patched = true;
  const original = state.indentLines;
  const indentLines: IndentLines = (value, map) => {
    const result = original(value, map);
    const { stack } = instrumentation;
    stack[stack.length - 1].indent = { source: value, result };
    return result;
  };
  state.indentLines = indentLines;
}

/**
 * Locate each of `emission`'s dispatched children inside the string `emission` produced, and
 * recurse. `toAbsolute` maps an offset of that string to an offset of the canonical string; for
 * a node that indented its children, the children live in the string that went *into*
 * `indentLines`, and {@link indentOffsetMap} maps that string's offsets to the indented one's.
 *
 * A child whose output cannot be found from the cursor is skipped with its subtree; it surfaces
 * as an `unresolved` path rather than as a wrong range. The lookup lives here, in one place
 * ({@link locateEmission}); {@link wrapHandle} stays transparent and records only what the
 * handler returned, which for a `text` child beside an attention run is not always what the parent
 * wrote (DECISIONS #review-1-r5 K2) — see {@link rewrittenEmissions} for the forms retried.
 *
 * A `text` child also has its characters placed one by one into `spellings`, from the string it
 * was found in and the same `local` map, so the escapes the serializer added, the references the
 * parent wrote and the prefixes its ancestors added are all carried (see {@link SpellingTable}).
 */
function placeChildren(
  emission: Emission,
  toAbsolute: OffsetMap,
  spans: Map<Nodes, Span>,
  spellings: Map<Nodes, SpellingTable>,
  insideTable: boolean,
): void {
  const indent = emission.indent;
  const shift = indent ? indentOffsetMap(indent.source, emission.value) : undefined;
  const container = indent && shift ? indent.source : emission.value;
  const local: OffsetMap = shift ? (offset) => toAbsolute(shift(offset)) : toAbsolute;
  let cursor = 0;
  const children = lastPerNode(emission.children);
  children.forEach((child, index) => {
    // The sibling `containerPhrasing` looks at before rewriting this child's trailing line ending
    // is the next *dispatched* child. `lib/handle/text.js` has no `peek`, so the look-ahead of
    // `container-phrasing.js` 43-55 calls the child's handler a second time off
    // `state.handle.handlers` and {@link wrapHandle} records that call too; `lastPerNode` is what
    // keeps one emission per node, and it is why `children[index + 1]` is the next *dispatched*
    // child and not the look-ahead's duplicate. `lastPerNode` keeps document order.
    const beforeHtml = children[index + 1]?.node.type === "html";
    const found = locateEmission(container, child, cursor, beforeHtml);
    if (found === undefined) return;
    const { at, length } = found;
    const start = local(at);
    spans.set(child.node, { start, end: length === 0 ? start : local(at + length - 1) + 1 });
    cursor = at + length;
    const inside: OffsetMap = (offset) => local(at + offset);
    if (child.node.type === "text") {
      const table = spellingOffsets(child.node.value, container, at, found.eolAsSpace);
      if (table !== undefined) spellings.set(child.node, absoluteSpelling(table, local));
    }
    if (child.node.type === "inlineCode") {
      const table = inlineCodeSpelling(child.node.value, child.value, insideTable);
      if (table !== undefined) spellings.set(child.node, absoluteSpelling(table, inside));
    }
    // A `table` emission's children are the cells' own inline nodes: `mdast-util-gfm-table` never
    // dispatches `tableRow` or `tableCell` through `state.handle` (see {@link placeTableGrid}), so
    // everything dispatched below a `table` was written with `tableCell` on `state.stack` and is
    // subject to the configured `inlineCode` handler's pipe escape.
    placeChildren(child, inside, spans, spellings, insideTable || child.node.type === "table");
    // After the recursion, so the cells' own contents are already placed and a cell's explicit
    // range can be widened to cover them.
    if (child.node.type === "table") placeTableGrid(child.node, child.value, inside, spans);
  });
}

/** Where one child's emission was found in its parent's string, and how long it is there. */
interface Located {
  at: number;
  length: number;
  /** Whether the form found is one whose trailing line ending the parent wrote as a space. */
  eolAsSpace: boolean;
}

/** One form a child's emission can take in its parent's string (see {@link rewrittenEmissions}). */
interface Candidate {
  text: string;
  /** Whether this form's trailing line ending was replaced by one space. */
  eolAsSpace: boolean;
}

/**
 * Locate `child`'s emission in `container`, searching forward from `cursor` — the emission as the
 * handler returned it, or, for a `text` child, as the parent rewrote it afterwards (see
 * {@link rewrittenEmissions}; `beforeHtml` says whether the child's next sibling is `html`).
 * Every candidate is searched from `cursor` and the earliest match wins, so a later repeated
 * literal is never mistaken for this child: the child's own bytes start at the cursor or right
 * after the parent's own delimiters, and nothing the parent writes there spells a candidate. Two
 * candidates cannot start at the same offset (they differ in their first or last bytes), so the
 * tie-break is never reached; the span's length is the matched string's.
 */
function locateEmission(
  container: string,
  child: Emission,
  cursor: number,
  beforeHtml: boolean,
): Located | undefined {
  const candidates: Candidate[] =
    child.node.type === "text"
      ? [{ text: child.value, eolAsSpace: false }, ...rewrittenEmissions(child.value, beforeHtml)]
      : [{ text: child.value, eolAsSpace: false }];
  let best: Located | undefined;
  for (const candidate of candidates) {
    const at = container.indexOf(candidate.text, cursor);
    if (at < 0 || (best !== undefined && at >= best.at)) continue;
    best = { at, length: candidate.text.length, eolAsSpace: candidate.eolAsSpace };
  }
  return best;
}

/**
 * The forms a `text` child's emission can take in its parent's string after the parent rewrote
 * an edge of it, in the order they are tried. The enumeration is derived from the branches of
 * `mdast-util-to-markdown/lib/util/container-phrasing.js` (2.1.2, read in `node_modules`) that
 * touch a child's string after its handler returned — three, and nothing else in that function
 * rewrites a result (`safe()` runs inside the handler, and punctuation is never encoded):
 *
 * 1. Lines 88–94, `encodeAfter`: the first UTF-16 unit of the child after an attention run is
 *    replaced by `encodeCharacterReference(unit.charCodeAt(0))` when the run asked for it.
 * 2. Lines 100–115, `encodingInfo.before`: the last unit of the child before an attention run is
 *    replaced the same way. The `emphasis`, `strong` and `delete` handlers do the same to the
 *    inner edge of their own `containerPhrasing` result.
 * 3. Lines 60–80, the line ending before `html`: when the next child is `html` and the previous
 *    child's string ends in a line ending (`before === '\r' || before === '\n'`), that line
 *    ending is replaced by one space — `results[results.length - 1].replace(/(\r?\n|\r)$/, ' ')`,
 *    line 71 — so that the html is not read as flow html on a line of its own.
 *
 * Task 1.45's wrapper (`format.ts`, `widenSplitSurrogateReferences`) then widens a unit of a
 * surrogate pair that branches 1 and 2 encoded to the pair's code point, in three forms: a
 * reference beside its raw mate, in both orders (a leading unit encoded before its raw trailing
 * unit, and a raw leading unit before its encoded trailing unit), and two adjacent references
 * (one character between two runs, both branches on the same pair). So what reaches the bytes
 * from branches 1 and 2 is one code point replaced by its numeric character reference at the
 * value's first position, at its last, or at both — the first three candidates: the value with
 * its first code point replaced, with its last replaced, and with both, collapsing, for a value of
 * one code point, to the whole value as the reference. The reference is spelled the way
 * `encode-character-reference.js` and the wrapper spell it: `&#x`, the code point in upper-case
 * hexadecimal without padding, `;`.
 *
 * Branch 3 gives the fourth candidate, tried only when `beforeHtml` says the child's next
 * sibling is `html` (the flag is passed from {@link placeChildren}, which sees the siblings): the
 * value with its trailing line ending replaced by one space. Branch 3 can combine with branch 1
 * (a child after a run *and* before html), so the head form gets its line ending replaced too;
 * the tail and both forms end in a reference, never a line ending, because a line ending before
 * an attention run is never encoded and a child before html is not before a run.
 *
 * A `break` child before `html` is rewritten by the same branch, and what reaches the bytes there
 * is `format.ts`'s answer, not branch 3's (task 1.58, DECISIONS #review-1-r7 M2) — a new encoding
 * in a handler is a change to this map (DECISIONS #review-1-r5 K2), and so is a new repair of
 * one. When the pair reparses to a `break` followed by an `html` — an inline tag, CommonMark §4.6
 * condition 7 — the break is written with its line ending kept, which is exactly the bytes its
 * handler returned, so {@link locateEmission} finds it among the candidates it already has (the
 * plain emission, the only one a non-`text` child gets) and the break is resolved and ranged.
 * When the html value can open an html block (conditions 1–6) the break is written as one space
 * instead; one space is not the spelling of any value, so that form is no candidate here and the
 * break stays unresolved, with no characters for the map to spell — the case named in
 * `positions-html-eol-inline-code.test.ts` and in `positions.test.ts`. No `text` child's
 * candidates change either way.
 */
function rewrittenEmissions(value: string, beforeHtml: boolean): Candidate[] {
  const points = [...value];
  if (points.length === 0) return [];
  const first = points[0];
  const last = points[points.length - 1];
  const encoded: string[] = [];
  if (points.length === 1) {
    encoded.push(characterReference(first));
  } else {
    const head = characterReference(first) + value.slice(first.length);
    const tail = value.slice(0, value.length - last.length) + characterReference(last);
    const both =
      characterReference(first) +
      value.slice(first.length, value.length - last.length) +
      characterReference(last);
    encoded.push(head, tail, both);
  }
  const candidates: Candidate[] = encoded.map((text) => ({ text, eolAsSpace: false }));
  if (beforeHtml) {
    for (const text of [value, ...encoded]) {
      if (!TRAILING_LINE_ENDING.test(text)) continue;
      candidates.push({ text: text.replace(TRAILING_LINE_ENDING, SPACE), eolAsSpace: true });
    }
  }
  return candidates;
}

/**
 * The spelling table of an `inlineCode` node whose *configured* handler emitted `written` — the
 * fence, the optional padding, the value one UTF-16 unit per unit, the padding, the fence, the
 * ownership rule {@link SpellingTable} states. `undefined` when `written` is not of that shape (a
 * fence that does not close, an inner string of a length the value, the padding and the escapes
 * below do not account for), so a caller is never handed a wrong alignment. The inner string is
 * compared unit by unit against the value, a line ending in the value allowed to be the space the
 * handler swaps it for.
 *
 * The handler is the *configured* one — `mdast-util-gfm-table`'s `inlineCodeWithTable`, not
 * `mdast-util-to-markdown`'s base `inlineCode` — and inside a table cell it escapes every `|`.
 * {@link SpellingTable}'s inline-code paragraph states that rule, with the extension's file and
 * lines, and it is what the `insideTable` mode implements here; {@link placeChildren} threads the
 * flag down from a `table` emission.
 */
export function inlineCodeSpelling(
  value: string,
  written: string,
  insideTable = false,
): SpellingTable | undefined {
  let fence = 0;
  while (fence < written.length && written[fence] === FENCE) fence += 1;
  if (fence === 0 || written.length < 2 * fence || !written.endsWith(FENCE.repeat(fence))) {
    return undefined;
  }
  const inner = written.slice(fence, written.length - fence);
  const escapes = insideTable ? countPipes(value) : 0;
  const spelled = value.length + escapes;
  const padding = inner.length === spelled + 2 ? 1 : 0;
  if (inner.length !== spelled + 2 * padding) return undefined;
  if (padding === 1 && (inner[0] !== SPACE || inner[inner.length - 1] !== SPACE)) return undefined;
  const starts: number[] = [];
  const ends: number[] = [];
  let at = fence + padding;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value[index];
    if (insideTable && unit === PIPE) {
      if (written[at] !== BACKSLASH || written[at + 1] !== PIPE) return undefined;
      starts.push(at);
      ends.push(at + 2);
      at += 2;
      continue;
    }
    const wrote = written[at];
    if (wrote !== unit && !(wrote === SPACE && (unit === "\n" || unit === "\r"))) return undefined;
    starts.push(at);
    ends.push(at + 1);
    at += 1;
  }
  starts.push(at);
  return { starts, ends };
}

/** How many `|` units `value` holds — one extra unit each once the table wrapper escapes them. */
function countPipes(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) if (value[index] === PIPE) count += 1;
  return count;
}

/** The character an inline code fence is made of. */
const FENCE = "`";

/** The column delimiter `mdast-util-gfm-table`'s `inlineCode` wrapper escapes inside a cell. */
const PIPE = "|";

/** The escape character that wrapper writes before a `|`. */
const BACKSLASH = "\\";

/** The numeric character reference `encode-character-reference.js` writes for `point`. */
function characterReference(point: string): string {
  return `&#x${(point.codePointAt(0) as number).toString(16).toUpperCase()};`;
}

/**
 * Place a table's rows and cells from the grid `markdown-table` wrote.
 *
 * `mdast-util-gfm-table` never dispatches `tableRow` or `tableCell` through `state.handle`: it
 * collects each cell's phrasing content into a matrix and lets `markdown-table` align the whole
 * grid at once. The only emissions inside a table are therefore the cells' *contents*, and a row
 * or a cell with no content of its own — an empty cell, or the wholly empty body row the editor's
 * table input rule creates — had no range at all. The layout says where they are: one line per
 * row, a delimiter line under the header, and one `|` before, between and after the columns.
 *
 * **Ownership rule.** A row owns its whole line, both outer delimiters included. That line is
 * partitioned by the delimiters into adjacent half-open slices `(delimiter, next delimiter)`, one
 * per column of the widest row — the delimiters themselves belong to the row, not to either cell
 * beside them. A cell owns its slice with `markdown-table`'s padding spaces removed from both
 * ends. A cell whose whole slice is padding is empty and owns no character: like every other
 * zero-width node here its range is empty, and it sits where the cell's first character would be
 * written — one column past the single padding space that follows its opening delimiter, so two
 * columns past the delimiter itself (or on the delimiter's own next column, for the degenerate
 * slice with no room for the padding). Being zero width it is
 * never returned by {@link nodeAt} — a cursor on those padding spaces is in the row — and it is
 * what a caret inside that cell maps to when the source view opens (task 1.7's cursor map reads
 * `ranges` by path, not by position).
 *
 * Nothing is placed from a grid that does not match the tree: a table whose output does not have
 * exactly one line per row plus the delimiter line, and a row whose line the delimiters do not
 * divide into one slice per column, both fall back to the hull of their dispatched descendants
 * rather than being given a wrong range.
 */
function placeTableGrid(
  table: Nodes,
  value: string,
  toAbsolute: OffsetMap,
  spans: Map<Nodes, Span>,
): void {
  const rows = childrenOf(table);
  const lines = splitLines(value);
  if (lines.length !== rows.length + 1) return;
  const columns = rows.reduce((most, row) => Math.max(most, childrenOf(row).length), 0);
  rows.forEach((row, index) => {
    // The delimiter line sits between the header row and the first body row and is no node's, so
    // row 0 is line 0 and row `i > 0` is line `i + 1`.
    const line = lines[index === 0 ? 0 : index + 1];
    const slices = cellSlices(line.text, columns);
    if (slices === null) return;
    setPlacedSpan(
      row,
      { start: line.start, end: line.start + line.text.length },
      toAbsolute,
      spans,
    );
    childrenOf(row).forEach((cell, column) => {
      const content = contentSlice(line.text, slices[column]);
      const span = { start: line.start + content.start, end: line.start + content.end };
      setPlacedSpan(cell, span, toAbsolute, spans);
    });
  });
}

/**
 * Record `local`, a span of the string `toAbsolute` maps, as `node`'s span in the canonical
 * string, widened to cover any descendant already placed outside it.
 *
 * The widening is what keeps the map's containment invariant true when the serializer padded a
 * cell in a way the trim above does not predict — a cell whose content itself begins with a space
 * is written `|  c |` and its `text` node was placed on the space, one column left of the content
 * slice. The node's range must contain its children's, so the hull wins where they disagree.
 */
function setPlacedSpan(
  node: Nodes,
  local: Span,
  toAbsolute: OffsetMap,
  spans: Map<Nodes, Span>,
): void {
  const start = toAbsolute(local.start);
  const placed: Span =
    local.end === local.start
      ? { start, end: start }
      : { start, end: toAbsolute(local.end - 1) + 1 };
  const hull = descendantHull(node, spans);
  spans.set(node, hull === undefined ? placed : union(placed, hull));
}

/** The hull of the spans already recorded for `node`'s descendants, or `undefined` for none. */
function descendantHull(node: Nodes, spans: Map<Nodes, Span>): Span | undefined {
  let hull: Span | undefined;
  for (const child of childrenOf(node)) {
    const span = spans.get(child) ?? descendantHull(child, spans);
    if (span) hull = hull ? union(hull, span) : span;
  }
  return hull;
}

/**
 * One row line's `columns` cell slices, or `null` when its delimiters do not describe that many
 * columns — a cell holding raw HTML with a `|` in it puts a delimiter the grid does not own on
 * the line, and a wrong grid is worse than no grid.
 */
function cellSlices(line: string, columns: number): Span[] | null {
  const delimiters = delimiterOffsets(line);
  if (delimiters.length !== columns + 1) return null;
  return delimiters
    .slice(0, -1)
    .map((start, index) => ({ start: start + 1, end: delimiters[index + 1] }));
}

/**
 * The offsets of the cell delimiters of one row line: every `|` that is not escaped.
 * `mdast-util-gfm-table` writes a `|` inside a cell as `\|` and a literal backslash as `\\`, so a
 * `|` is a delimiter exactly when the run of backslashes immediately before it has even length.
 */
function delimiterOffsets(line: string): number[] {
  const offsets: number[] = [];
  for (let index = 0; index < line.length; index++) {
    if (line[index] !== "|") continue;
    let backslashes = 0;
    while (index - backslashes - 1 >= 0 && line[index - backslashes - 1] === "\\") backslashes++;
    if (backslashes % 2 === 0) offsets.push(index);
  }
  return offsets;
}

/** The padding character `markdown-table` puts around a cell's content. */
const PADDING = " ";

/**
 * `slice` without the padding `markdown-table` put around the cell's content, and the zero-width
 * point one column after the opening delimiter when the slice is all padding (an empty cell).
 */
function contentSlice(line: string, slice: Span): Span {
  let start = slice.start;
  let end = slice.end;
  while (start < end && line[start] === PADDING) start++;
  while (end > start && line[end - 1] === PADDING) end--;
  if (start < end) return { start, end };
  const point = Math.min(slice.start + 1, slice.end);
  return { start: point, end: point };
}

/**
 * Drop the speculative emissions `containerPhrasing` produces when it looks ahead at a sibling
 * whose handler has no `peek`: the same node is emitted twice, and only the later emission is
 * the one that reached the output. Keeping the last per node preserves document order.
 */
function lastPerNode(emissions: Emission[]): Emission[] {
  const lastIndex = new Map<Nodes, number>();
  emissions.forEach((emission, index) => lastIndex.set(emission.node, index));
  return emissions.filter((emission, index) => lastIndex.get(emission.node) === index);
}

/**
 * Map an offset of `source` to the corresponding offset of `result`, where `result` is `source`
 * with a prefix added to the front of each of its lines — what `blockquote` and `listItem` do to
 * their children through `state.indentLines`.
 *
 * Returns `undefined` when `result` is not of that shape (a different number of lines, or a line
 * that is not the source line with something in front of it), so a serializer that pads its
 * children some other way loses their positions instead of being given wrong ones.
 */
export function indentOffsetMap(source: string, result: string): OffsetMap | undefined {
  const sourceLines = splitLines(source);
  const resultLines = splitLines(result);
  if (sourceLines.length !== resultLines.length) return undefined;
  const prefixes: number[] = [];
  for (let index = 0; index < sourceLines.length; index++) {
    const source = sourceLines[index];
    const result = resultLines[index];
    if (!result.text.endsWith(source.text)) return undefined;
    prefixes.push(result.text.length - source.text.length);
  }
  return (offset) => {
    let index = sourceLines.length - 1;
    while (index > 0 && sourceLines[index].start > offset) index--;
    return resultLines[index].start + prefixes[index] + (offset - sourceLines[index].start);
  };
}

/** Split on the line endings `indentLines` splits on, keeping each line's start offset. */
function splitLines(value: string): Line[] {
  const lines: Line[] = [];
  const eol = /\r\n|\r|\n/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = eol.exec(value))) {
    lines.push({ text: value.slice(start, match.index), start });
    start = match.index + match[0].length;
  }
  lines.push({ text: value.slice(start), start });
  return lines;
}

/**
 * Walk the tree, filling in the nodes the serializer never dispatched, and key it by path.
 *
 * `giveUps` are the serializer's own (see {@link PositionMap}): each names a parent node and the
 * index of the child the widening walk could not account for. An `unlocatable-child` give-up
 * reports that child and every later sibling — the walk stops there, so children `index`…n were
 * all left as the parent wrote them — and an `overlapping-edit` give-up reports the one child
 * whose edit was dropped. The lookup is done here, on the one walk that already knows every
 * node's path, and a path a node's missing span has already reported is not repeated.
 */
function buildMap(
  root: Root,
  text: string,
  spans: Map<Nodes, Span>,
  giveUps: readonly RecordedGiveUp[],
): PositionMap {
  completeSpans(root, spans);
  const starts = splitLines(text);
  const ranges: Record<string, NodeRange> = {};
  const entries: PositionEntry[] = [];
  const unresolved: string[] = [];
  // One path at most once: a node with no span and a give-up naming it can both report it.
  const report = (path: string): void => {
    if (!unresolved.includes(path)) unresolved.push(path);
  };
  const visit = (node: Nodes, path: string): void => {
    const span = spans.get(node);
    if (span) {
      const range = toRange(span, starts);
      ranges[path] = range;
      entries.push({ path, node, ...range });
    } else {
      report(path);
    }
    for (const giveUp of giveUps) {
      if (giveUp.parent !== node) continue;
      // An unlocatable child stops the walk, so that child *and every later sibling* were left as
      // the parent wrote them and none of their positions is known to be right; a dropped
      // overlapping edit is one child's own bytes and stops nothing.
      const last =
        giveUp.reason === "unlocatable-child" ? childrenOf(node).length - 1 : giveUp.index;
      for (let index = giveUp.index; index <= last; index += 1) report(childPath(path, index));
    }
    childrenOf(node).forEach((child, index) => visit(child, childPath(path, index)));
  };
  visit(root, ROOT_PATH);
  return { ranges, entries, unresolved };
}

/** Give every node the serializer did not dispatch the hull of its descendants that it did. */
function completeSpans(node: Nodes, spans: Map<Nodes, Span>): Span | undefined {
  const own = spans.get(node);
  let hull: Span | undefined;
  for (const child of childrenOf(node)) {
    const span = completeSpans(child, spans);
    if (span) hull = hull ? union(hull, span) : span;
  }
  if (!own && hull) spans.set(node, hull);
  return spans.get(node);
}

/** The smallest span covering both. */
function union(left: Span, right: Span): Span {
  return { start: Math.min(left.start, right.start), end: Math.max(left.end, right.end) };
}

/** A node's children, or none when it is a leaf. */
function childrenOf(node: Nodes): Nodes[] {
  return "children" in node ? (node.children as Nodes[]) : [];
}

/** Convert a character span to 1-based line/column coordinates. */
function toRange(span: Span, lines: Line[]): NodeRange {
  const start = toPoint(span.start, lines);
  const end = toPoint(span.end, lines);
  return { startLine: start.line, startCol: start.column, endLine: end.line, endCol: end.column };
}

/** Convert one offset to a 1-based line/column point. */
function toPoint(offset: number, lines: Line[]): { line: number; column: number } {
  let index = lines.length - 1;
  while (index > 0 && lines[index].start > offset) index--;
  return { line: index + 1, column: offset - lines[index].start + 1 };
}
