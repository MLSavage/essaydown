import type { Nodes, Root } from "mdast";
import type { Options } from "remark-stringify";
import type { Data, Processor } from "unified";
import { createFormatter } from "./format.js";

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
 * because that character is the first on the prefix's own line. A character whose spelling is
 * empty cannot arise: every rule in {@link spellingOffsets} consumes at least one character.
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
   * One {@link SpellingTable} per `text` node of the tree, by path — the node's characters in
   * `text`'s own offsets. A `text` node the serializer wrote in a way {@link spellingOffsets}
   * cannot account for has no entry, and so does every node that is not `text`: only a `text`
   * node's bytes are its characters (see {@link formatWithMap}).
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
 * `formatWithMap(root).text` is `format(root)`, and the map is a pure function of `root`: the
 * tree is never mutated and nothing is carried between calls.
 */
export function formatWithMap(root: Root): FormatWithMapResult {
  const rootEmission: Emission = { node: root, value: "", children: [] };
  const instrumentation: Instrumentation = { stack: [rootEmission], patched: false };
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
  placeChildren(rootEmission, (offset) => offset, spans, written);
  const map = buildMap(root, text, spans);
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
 * Pure: it reads two strings and allocates two arrays.
 */
export function spellingOffsets(
  value: string,
  written: string,
  from = 0,
): SpellingTable | undefined {
  const starts: number[] = [];
  const ends: number[] = [];
  let at = from;
  let afterLineEnding = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    // The direct match is tried first, so a prefix character is only ever skipped where it does
    // not spell the character being placed.
    while (
      afterLineEnding &&
      spellingEnd(written, at, character) === undefined &&
      CONTINUATION.has(written.charAt(at))
    ) {
      at += 1;
    }
    const end = spellingEnd(written, at, character);
    if (end === undefined) return undefined;
    starts.push(at);
    ends.push(end);
    at = end;
    afterLineEnding = character === "\n";
  }
  starts.push(at);
  return { starts, ends };
}

/** The characters a continuation prefix is made of: a blockquote's marker and indentation. */
const CONTINUATION = new Set([" ", "\t", ">"]);

/** A numeric character reference, hexadecimal or decimal — the two spellings `safe` can emit. */
const REFERENCE = /^&#(?:x([0-9a-f]+)|([0-9]+));/i;

/** One past the end of `character`'s spelling at `at` in `written`, or `undefined` for no match. */
function spellingEnd(written: string, at: number, character: string): number | undefined {
  if (written.startsWith(`\\${character}`, at)) return at + 2;
  if (written.startsWith(character, at)) return at + 1;
  const reference = REFERENCE.exec(written.slice(at, at + REFERENCE_LIMIT));
  if (reference === null) return undefined;
  const [hexadecimal, decimal] = [reference[1], reference[2]];
  const code = hexadecimal === undefined ? Number(decimal) : Number.parseInt(hexadecimal, 16);
  return String.fromCodePoint(code) === character ? at + reference[0].length : undefined;
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
 * as an `unresolved` path rather than as a wrong range.
 *
 * A `text` child also has its characters placed one by one into `spellings`, from the string it
 * was found in and the same `local` map, so the escapes the serializer added and the prefixes its
 * ancestors added are both carried (see {@link SpellingTable}).
 */
function placeChildren(
  emission: Emission,
  toAbsolute: OffsetMap,
  spans: Map<Nodes, Span>,
  spellings: Map<Nodes, SpellingTable>,
): void {
  const indent = emission.indent;
  const shift = indent ? indentOffsetMap(indent.source, emission.value) : undefined;
  const container = indent && shift ? indent.source : emission.value;
  const local: OffsetMap = shift ? (offset) => toAbsolute(shift(offset)) : toAbsolute;
  let cursor = 0;
  for (const child of lastPerNode(emission.children)) {
    const at = container.indexOf(child.value, cursor);
    if (at < 0) continue;
    const length = child.value.length;
    const start = local(at);
    spans.set(child.node, { start, end: length === 0 ? start : local(at + length - 1) + 1 });
    cursor = at + length;
    const inside: OffsetMap = (offset) => local(at + offset);
    if (child.node.type === "text") {
      const table = spellingOffsets(child.node.value, container, at);
      if (table !== undefined) spellings.set(child.node, absoluteSpelling(table, local));
    }
    placeChildren(child, inside, spans, spellings);
    // After the recursion, so the cells' own contents are already placed and a cell's explicit
    // range can be widened to cover them.
    if (child.node.type === "table") placeTableGrid(child.node, child.value, inside, spans);
  }
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

/** Walk the tree, filling in the nodes the serializer never dispatched, and key it by path. */
function buildMap(root: Root, text: string, spans: Map<Nodes, Span>): PositionMap {
  completeSpans(root, spans);
  const starts = splitLines(text);
  const ranges: Record<string, NodeRange> = {};
  const entries: PositionEntry[] = [];
  const unresolved: string[] = [];
  const visit = (node: Nodes, path: string): void => {
    const span = spans.get(node);
    if (span) {
      const range = toRange(span, starts);
      ranges[path] = range;
      entries.push({ path, node, ...range });
    } else {
      unresolved.push(path);
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
