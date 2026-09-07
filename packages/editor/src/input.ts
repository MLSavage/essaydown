import { baseKeymap, chainCommands } from "prosemirror-commands";
import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
  wrappingInputRule,
} from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import type { MarkType, Node as PMNode } from "prosemirror-model";
import { liftListItem, sinkListItem, splitListItem } from "prosemirror-schema-list";
import { TextSelection, type Command, type Plugin } from "prosemirror-state";
import { revealPlugin } from "./reveal.js";
import { schema } from "./schema.js";

/**
 * Typora-style editing for the schema of {@link schema}: the Markdown a writer types is turned
 * into the node or mark it denotes, and the delimiters stop being characters in the document.
 *
 * Two mechanisms, and the split between them is the ProseMirror one, not ours. An **input rule**
 * fires on a typed *character* and sees only the text of the current textblock before the cursor,
 * so every rule here whose trigger is a character lives in {@link markdownInputRules}. A
 * **keymap** entry fires on a key, so the two conversions triggered by Enter, Tab or Backspace
 * live in {@link essaydownKeymap}.
 *
 * **No history plugin.** `prosemirror-history` is not a dependency of this package and
 * {@link editorPlugins} installs nothing that records an undo stack; undo is the store's, in task
 * 1.6 (PRD §4: "ProseMirror's and CodeMirror's built-in histories are disabled"). For the same
 * reason `undoInputRule` — which would make Backspace immediately after a rule put the typed
 * delimiters back — is deliberately not bound: it is a second, invisible undo model, and Backspace
 * already has a job in this keymap.
 */

/** `#` … `######` then a space. Seven or more, or no space, stays literal text. */
const HEADING = /^(#{1,6})\s$/;
/** `- ` at the start of a textblock. Only `-`; `*` and `+` are not the canonical bullet. */
const BULLET_LIST = /^-\s$/;
/** `<n>. ` at the start of a textblock; `<n>` becomes the list's `start`. */
const ORDERED_LIST = /^(\d+)\.\s$/;
/** `> ` at the start of a textblock. */
const BLOCKQUOTE = /^>\s$/;
/** Three backticks alone in a paragraph, i.e. the third backtick is the trigger. */
const CODE_BLOCK = /^```$/;
/** `---` alone in a paragraph. */
const THEMATIC_BREAK = /^---$/;

/**
 * The three "convert on close" mark rules. Each is written so that the whole match is exactly
 * `delimiter + group 1 + delimiter` — no prefix — which is what lets {@link markInputRule} locate
 * the content from `end` alone.
 *
 * The lookbehind is what keeps the pair apart: at the moment `**x**` is closed, the emphasis
 * pattern could otherwise match the inner `*x*`, and at the moment `*x*` is closed the strong
 * pattern must not match half of it. The content is `[^*\s]` or `[^*\s][^*]*[^*\s]`, i.e. non-empty
 * and neither starting nor ending with whitespace, which is CommonMark's flanking rule for the one
 * case it is observable here — `* x *` is not emphasis and must stay literal.
 */
const STRONG = /(?<!\*)\*\*([^*\s]|[^*\s][^*]*[^*\s])\*\*$/;
const EMPHASIS = /(?<!\*)\*([^*\s]|[^*\s][^*]*[^*\s])\*$/;
const INLINE_CODE = /(?<!`)`([^`\s]|[^`\s][^`]*[^`\s])`$/;

/**
 * A rule that replaces `delimiter + text + delimiter` with `text` carrying `markType`.
 *
 * The document the handler sees does **not** yet contain the character that triggered the rule:
 * ProseMirror offers the character to `handleTextInput` before inserting it, and a rule that
 * returns a transaction consumes it. So `[start, end)` holds `match[0]` minus its last character —
 * for `**x**` the document holds `**x*` — and the closing delimiter is only partly there. The
 * three boundaries are therefore measured forward from `start` and the length of group 1, never
 * backwards from `end` and never by searching the document for the delimiter, so a delimiter
 * character inside the content could not move them. Deleting what is left of the closing delimiter
 * first leaves the two earlier positions valid for the mark.
 *
 * `removeStoredMark` is the reason the mark does not leak: the cursor ends up at the end of the
 * marked span, and every mark in this schema is inclusive, so without it the next character typed
 * would join the span.
 */
function markInputRule(regexp: RegExp, markType: MarkType, delimiter: string): InputRule {
  return new InputRule(regexp, (state, match, start, end) => {
    const contentFrom = start + delimiter.length;
    const contentTo = contentFrom + match[1].length;
    return state.tr
      .delete(contentTo, end)
      .addMark(contentFrom, contentTo, markType.create())
      .delete(start, contentFrom)
      .removeStoredMark(markType);
  });
}

/**
 * `---` in a paragraph becomes a thematic break followed by an empty paragraph holding whatever
 * followed the cursor, and the cursor moves into that paragraph — a thematic break is an atom, so
 * without the paragraph there would be nowhere to type next when the rule fires at the end of the
 * document.
 *
 * Restricted to paragraphs: `---` typed into a heading or a code block is text the writer meant.
 * A paragraph only ever sits where `block+` is allowed, so no `canReplaceWith` test is needed —
 * every parent that admits this paragraph admits a thematic break in its place.
 */
function thematicBreakRule(): InputRule {
  return new InputRule(THEMATIC_BREAK, (state, _match, start, end) => {
    const $start = state.doc.resolve(start);
    if ($start.parent.type !== schema.nodes.paragraph) return null;
    const tail = $start.parent.content.cut(end - $start.start());
    const tr = state.tr.replaceWith($start.before(), $start.after(), [
      schema.nodes.thematic_break.create(),
      schema.nodes.paragraph.create(null, tail),
    ]);
    return tr.setSelection(TextSelection.create(tr.doc, $start.before() + 2));
  });
}

/** The input rules of PRD §6.1, in priority order — the first one that matches wins. */
export function markdownInputRules(): InputRule[] {
  const { blockquote, code_block, heading, list } = schema.nodes;
  return [
    // Before the inline-code rule: `` ` `` and ``` share a trigger character, and ``` must not be
    // read as an empty inline-code span.
    textblockTypeInputRule(CODE_BLOCK, code_block),
    textblockTypeInputRule(HEADING, heading, (match) => ({ depth: match[1].length })),
    // The join predicates carry the work the two-node-type schemas do for free: mdast has one
    // `list` node (PRD §6.1), so `wrappingInputRule`'s default join would fuse a new bullet list
    // into the ordered list above it. A list joins only a list of the same flavour, and an
    // ordered one only when the number typed continues its numbering.
    wrappingInputRule(
      BULLET_LIST,
      list,
      { ordered: false },
      (_match, node) => node.attrs.ordered === false,
    ),
    wrappingInputRule(
      ORDERED_LIST,
      list,
      (match) => ({ ordered: true, start: Number(match[1]) }),
      (match, node) =>
        node.attrs.ordered === true &&
        node.childCount + (node.attrs.start as number) === Number(match[1]),
    ),
    wrappingInputRule(BLOCKQUOTE, blockquote),
    thematicBreakRule(),
    // Strong before emphasis: `**x**` ends with the emphasis pattern's closing delimiter too.
    markInputRule(STRONG, schema.marks.strong, "**"),
    markInputRule(EMPHASIS, schema.marks.emphasis, "*"),
    markInputRule(INLINE_CODE, schema.marks.inline_code, "`"),
  ];
}

/**
 * The cells of a Markdown table row, or null if `text` is not one.
 *
 * A row is `|`, then the cells separated by `|`, then `|`; each cell is trimmed. The number of
 * columns is the number of cells the writer typed — `|a|b|` gives the two columns of the task
 * text, and the two is read off the row rather than being a constant in the code.
 */
export function tableRowCells(text: string): string[] | null {
  const trimmed = text.trim();
  if (trimmed.length < 2 || !trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

/**
 * Enter at the end of a paragraph that is a Markdown table row replaces it with a table: the row
 * becomes the header, one empty row is added under it, and the cursor lands in that row's first
 * cell. mdast has no header flag — the first `tableRow` is the header (PRD §6.1) — so nothing is
 * marked; the second row is simply the one the writer will type into.
 */
export const tableFromRow: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty) return false;
  if ($from.parent.type !== schema.nodes.paragraph) return false;
  const cells = tableRowCells($from.parent.textContent);
  if (cells === null) return false;
  if (dispatch) {
    const cell = (text: string): PMNode =>
      schema.nodes.table_cell.create(null, text === "" ? null : schema.text(text));
    const header = schema.nodes.table_row.create(null, cells.map(cell));
    const body = schema.nodes.table_row.create(
      null,
      cells.map(() => schema.nodes.table_cell.create()),
    );
    const table = schema.nodes.table.create({ align: null }, [header, body]);
    const from = $from.before();
    const tr = state.tr.replaceWith(from, $from.after(), table);
    // from → before the table; +1 → inside it; + header.nodeSize → before the body row;
    // +1 → inside the body row; +1 → inside its first cell.
    dispatch(tr.setSelection(TextSelection.create(tr.doc, from + 3 + header.nodeSize)));
  }
  return true;
};

/**
 * Backspace in an empty list item lifts it out of the list, rather than joining it to the item
 * above. Only when the item holds exactly one block and that block is the empty textblock the
 * cursor is in: an item with a second paragraph, or a non-empty one, still deletes backwards.
 */
export const exitEmptyListItem: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty) return false;
  if ($from.parent.content.size !== 0) return false;
  const item = $from.node(-1);
  if (item.type !== schema.nodes.list_item || item.childCount !== 1) return false;
  return liftListItem(schema.nodes.list_item)(state, dispatch);
};

/**
 * The keys this editor binds. Installed *before* `baseKeymap`, so each entry is tried first and
 * falls through to the base behaviour when it returns false: Enter still splits a paragraph, and
 * Backspace still deletes a character.
 *
 * Tab and Shift-Tab are list indentation only. Outside a list they return false and the key keeps
 * its browser meaning (moving focus), which is what keeps the editor keyboard-escapable.
 */
export function essaydownKeymap(): Record<string, Command> {
  const item = schema.nodes.list_item;
  return {
    Enter: chainCommands(tableFromRow, splitListItem(item)),
    Backspace: exitEmptyListItem,
    Tab: sinkListItem(item),
    "Shift-Tab": liftListItem(item),
  };
}

/**
 * The plugins a rendered editor over {@link schema} runs, in order. Nothing here keeps a history:
 * see the module comment.
 *
 * The reveal plugin of task 1.4 is last because it only reads: it contributes decorations and no
 * key binding, no input rule and no state, so nothing above it can be shadowed by it.
 */
export function editorPlugins(): Plugin[] {
  return [
    inputRules({ rules: markdownInputRules() }),
    keymap(essaydownKeymap()),
    keymap(baseKeymap),
    revealPlugin(),
  ];
}
