import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Root } from "mdast";
import { format, parse } from "@essaydown/core";
import { Mark, type Node as PMNode } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import {
  CELL_LINE_ENDING,
  LINE_ENDING,
  keptCharacters,
  mdastToPM,
  pmToMdast,
  schema,
} from "../src/schema.js";
import { cursorMap, type CursorMap } from "../src/toggle.js";
import { blockAlone, type BlockAlone } from "./block-alone";
import { deleteAtEveryBlockStart, deleteBesideEveryMarkedRun } from "./typing-legs.js";

/**
 * Task 3.12 (DECISIONS #review-1-r9 O7, O8, O9; the "stuck in italics" class of Michael's 1.9.r1
 * note). **The rendered view's typed marks are the reference**: a character typed at a caret takes
 * `storedMarks ?? $pos.marks()` (`Transaction.insertText`, prosemirror-state 1.4.4), and the
 * toggle's `toSource` puts the source caret where a character typed there takes the same marks.
 * Every assertion below is that one sentence, made as bytes: `X` inserted at `pos` with those
 * marks in the rendered view, through `pmToMdast` and `format`, against `X` written into the
 * source at `toSource(pos, storedMarks)` and reparsed — equal with `toBe`.
 *
 * The three position classes the task names, and the clause of `toggle.ts` each one reaches:
 *
 * - **an interior boundary** — two kept inline nodes meet at the caret. Where the typed marks are
 *   one neighbour's, `innermostAt` decides as before (task 1.53); where they match **neither**,
 *   `interiorBoundary` resolves the boundary per carried mark (O7);
 * - **a dropped-whitespace position** — the caret settled right after whitespace the conversion
 *   dropped: a stripped lead (the block's `"start"` edge in kept terms) or a gap a line start took
 *   between two kept nodes (`inDroppedGap`, resolved by `interiorBoundary`; O8);
 * - **a leaf-start position** — the block's start in kept terms where the first kept node is an
 *   inline leaf that is not text (`isLeafStart`, O9; an atom answers its own start anyway).
 */

type Doc = PMNode;

function fixtureIndex(): Record<string, unknown> {
  return JSON.parse(readFileSync("fixtures/markdown/index.json", "utf8")) as Record<string, unknown>;
}

function fixture(name: string): string {
  return readFileSync(`fixtures/markdown/${name}`, "utf8");
}

/** `X` at `pos` with the marks the rendered view gives it: `storedMarks ?? $pos.marks()`. */
function typedInRendered(doc: Doc, pos: number, storedMarks: readonly Mark[] | null): string {
  const marks = storedMarks ?? doc.resolve(pos).marks();
  const tr = EditorState.create({ doc }).tr.replaceWith(pos, pos, schema.text("X", marks));
  return format(pmToMdast({ doc: tr.doc, frontMatter: null }));
}

/** `X` at `at` in `text`, reparsed and formatted: what the source view's keystroke yields. */
function typedInSource(text: string, at: { line: number; ch: number }): string {
  const lines = text.split("\n");
  const line = lines[at.line - 1];
  lines[at.line - 1] = `${line.slice(0, at.ch)}X${line.slice(at.ch)}`;
  return format(parse(lines.join("\n")));
}

function childrenOf(node: Doc): Doc[] {
  const out: Doc[] = [];
  node.forEach((child) => out.push(child));
  return out;
}

/** The kept-character map the conversion builds for `block` (`schema.ts`). */
function keptIn(block: Doc): ReturnType<typeof keptCharacters> {
  return keptCharacters(
    childrenOf(block),
    block.type === schema.nodes.table_cell ? CELL_LINE_ENDING : LINE_ENDING,
  );
}

/** Whether `pos` sits between the two UTF-16 units of one code point: no caret can be there. */
function insideSurrogatePair(doc: Doc, pos: number): boolean {
  const $pos = doc.resolve(pos);
  const before = $pos.nodeBefore;
  const after = $pos.nodeAfter;
  return (
    before !== null &&
    after !== null &&
    before.isText &&
    after.isText &&
    /[\uD800-\uDBFF]$/.test(before.text as string) &&
    /^[\uDC00-\uDFFF]/.test(after.text as string)
  );
}

/** The three classes of position this task's leg asserts at. */
type Klass = "interior boundary" | "dropped whitespace" | "leaf start";

interface Classified {
  readonly pos: number;
  readonly klass: Klass;
  /** For an interior boundary: whether the click route's marks match neither neighbour (O7). */
  readonly neither: boolean;
  /** For a dropped-whitespace position: whether it is a gap between two kept nodes (O8). */
  readonly gap: boolean;
}

/**
 * Every position of the textblock whose content starts at `start` that belongs to one of the
 * three classes, in the document `doc`. A position the map does not return to (inside dropped
 * whitespace — the ownership rule of `keptCharacters`) is never one of them: typing there writes
 * bytes the source cannot hold, which task 1.64's leg owns.
 */
function classify(doc: Doc, block: Doc, start: number): Classified[] {
  const chars = keptIn(block);
  const out: Classified[] = [];
  for (let live = 0; live <= chars.liveWidth; live += 1) {
    const pos = start + live;
    if (insideSurrogatePair(doc, pos)) continue;
    const offset = chars.offsetOf(live);
    if (chars.liveOf(offset) !== live) continue;
    const droppedBefore = live > 0 && !chars.keeps(live - 1);
    const coveredBefore =
      droppedBefore && chars.ranges.some((range) => range.start <= live - 1 && live - 1 < range.end);
    const $pos = doc.resolve(pos);
    if (offset === 0 && offset < chars.width) {
      const first = chars.nodes[0];
      if (droppedBefore) out.push({ pos, klass: "dropped whitespace", neither: false, gap: false });
      if (first !== undefined && !first.isText) {
        out.push({ pos, klass: "leaf start", neither: false, gap: false });
      } else if (first !== undefined && first.marks.some((m) => m.type === schema.marks.inline_code)) {
        out.push({ pos, klass: "leaf start", neither: false, gap: false });
      }
      continue;
    }
    if (offset <= 0 || offset >= chars.width) continue;
    if (droppedBefore && !coveredBefore) {
      out.push({ pos, klass: "dropped whitespace", neither: false, gap: true });
      continue;
    }
    if ($pos.textOffset !== 0 || $pos.nodeBefore === null || $pos.nodeAfter === null) continue;
    const marks = $pos.marks();
    const neither =
      !Mark.sameSet(marks, $pos.nodeBefore.marks) && !Mark.sameSet(marks, $pos.nodeAfter.marks);
    out.push({ pos, klass: "interior boundary", neither, gap: false });
  }
  return out;
}

/** The routes a class is asserted on: the click route everywhere, `[]` where the edge allows it. */
function routesOf(klass: Klass): (readonly Mark[] | null)[] {
  // An input rule's `[]` (and a Delete's) reaches a block's start; inside a block a mark common to
  // both neighbours cannot be left by one keystroke in the source view, so the interior classes are
  // asserted on the click route a caret placed there takes.
  return klass === "leaf start" ? [null, []] : [null];
}

/** `X` written into `text` at `at`, raw — the source view's bytes before any reparse. */
function insertX(text: string, at: { line: number; ch: number }): string {
  const lines = text.split("\n");
  const line = lines[at.line - 1];
  lines[at.line - 1] = `${line.slice(0, at.ch)}X${line.slice(at.ch)}`;
  return lines.join("\n");
}

/**
 * Two spellings of one document made comparable: every hexadecimal character reference decoded
 * (the serializer writes them where the raw bytes do not, and the reverse), then table padding and
 * delimiter-row widths taken out (a cell's width follows its content's spelling).
 */
function unpadded(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/ +/g, " ")
    .replace(/-+/g, "-");
}

/**
 * What one comparison found. **`agree`** is the invariant. The other two are the two classes in
 * which no caret could make the views agree, each asserted to be what it says (DECISIONS #032:
 * positively bounded, never a narrowing):
 *
 * - **`encoded`** — `[1.53, a raw source keystroke before a punctuation-edged run]`: the rendered
 *   view keeps a run by writing the letter as a character reference (`&#x58;`), the raw keystroke
 *   dissolves it. Asserted: the raw bytes at the mapped column are the rendered bytes with the
 *   reference decoded, so the caret is the rendered view's own and only the spelling differs.
 * - **`unrepresentable`** — the typed marks are a set no single source keystroke can give a
 *   character (a mark the caret drops that continues on both sides, or `inline_code` carried
 *   outside every code span). Asserted: **no** column of any line of the source yields the
 *   rendered bytes, so the map cannot be the reason the views part.
 */
type Outcome = "agree" | "encoded" | "unrepresentable";

function compare(
  text: string,
  at: { line: number; ch: number },
  rendered: string,
  where: string,
): Outcome {
  const typed = typedInSource(text, at);
  if (typed === rendered) return "agree";
  if (rendered.includes("&#x58;") && !typed.includes("&#x58;")) {
    expect(unpadded(insertX(text, at)), `${where}: the encoded neighbour's column`).toBe(
      unpadded(rendered),
    );
    return "encoded";
  }
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    for (let ch = 0; ch <= line.length; ch += 1) {
      const other = typedInSource(text, { line: index + 1, ch });
      expect(other, `${where}: no column agrees (${index + 1}:${ch})`).not.toBe(rendered);
    }
  });
  return "unrepresentable";
}

/** One seed of the leg: how the document handed to the views is made from a fixture. */
interface Seed {
  readonly name: string;
  readonly make: (doc: Doc) => Doc;
  readonly destructive: boolean;
}

const SEEDS: Seed[] = [
  { name: "parse(fixture)", make: (doc) => doc, destructive: false },
  {
    name: "the first character of every block deleted (deleteAtEveryBlockStart)",
    make: (doc) => deleteAtEveryBlockStart(doc).doc,
    destructive: true,
  },
  {
    name: "the space beside every marked run deleted (deleteBesideEveryMarkedRun)",
    make: (doc) => deleteBesideEveryMarkedRun(doc).doc,
    destructive: true,
  },
];

/** The whole document's textblocks this leg sweeps: every one but a fenced code block's. */
function sweptBlocks(doc: Doc): { pos: number; node: Doc }[] {
  const out: { pos: number; node: Doc }[] = [];
  doc.descendants((node, pos) => {
    if (node.type === schema.nodes.code_block) return false;
    if (node.isTextblock) {
      if (node.content.size > 0) out.push({ pos, node });
      return false;
    }
    return true;
  });
  return out;
}

describe("the two-view corpus leg: at every interior boundary, dropped-whitespace and leaf-start position, a character typed after the toggle takes the rendered view's marks (task 3.12)", () => {
  const names = Object.keys(fixtureIndex());
  const reach = new Map<string, Record<string, number>>();
  const excluded: string[] = [];

  function bump(seed: string, key: string): void {
    const counts = reach.get(seed) ?? {};
    counts[key] = (counts[key] ?? 0) + 1;
    reach.set(seed, counts);
  }

  /** DECISIONS #review-1-r7 M6: the family's 30_000 ms budget, the block-alone oracle keeps it. */
  const LEG_TIMEOUT_MS = 30_000;

  for (const seed of SEEDS) {
    it.each(names)(`${seed.name}, %s: the two views write the same bytes`, (name) => {
      const parsed = parse(fixture(name));
      const editor = mdastToPM(parsed);
      const doc = seed.make(editor.doc);
      const root: Root = pmToMdast({ doc, frontMatter: editor.frontMatter });
      const map: CursorMap = cursorMap(root, doc);
      bump(seed.name, "fixtures");
      for (const { pos: blockPos, node } of sweptBlocks(doc)) {
        const positions = classify(doc, node, blockPos + 1);
        if (positions.length === 0) continue;
        const alone: BlockAlone = blockAlone(doc, blockPos, node);
        const shifts = new Map<number, { line: number; ch: number }>();
        for (const { pos, klass, neither, gap } of positions) {
          for (const storedMarks of routesOf(klass)) {
            const route = storedMarks === null ? "click" : "[]";
            const at = alone.map.toSource(pos + alone.offset, storedMarks);
            const where = `${seed.name} ${name} ${klass} ${route} @${pos} ${at.line}:${at.ch}`;
            // The bridge: the whole document's column is the block's own, shifted by one
            // constant per line of the block (the container's prefix).
            const whole = map.toSource(pos, storedMarks);
            const shift = { line: whole.line - at.line, ch: whole.ch - at.ch };
            const first = shifts.get(at.line);
            if (first === undefined) shifts.set(at.line, shift);
            else expect(shift, `${where}: one shift per block line`).toEqual(first);

            const rendered = typedInRendered(alone.doc, pos + alone.offset, storedMarks);
            const outcome = compare(alone.text, at, rendered, where);
            if (outcome !== "agree") {
              excluded.push(`${outcome} ${where}`);
              continue;
            }
            bump(seed.name, `${klass} ${route}`);
            if (neither) bump(seed.name, "interior boundary, neither neighbour (O7)");
            if (gap) bump(seed.name, "dropped gap between kept nodes (O8)");
          }
        }
      }
    }, LEG_TIMEOUT_MS);
  }

  it("ran every seed over every fixture in the index, and reached every class on every seed that can hold it", () => {
    expect(names.length).toBeGreaterThan(40);
    for (const seed of SEEDS) {
      const counts = reach.get(seed.name) ?? {};
      expect(counts.fixtures, seed.name).toBe(names.length);
      expect(counts["interior boundary click"], seed.name).toBeGreaterThan(0);
      expect(counts["leaf start click"], seed.name).toBeGreaterThan(0);
      expect(counts["leaf start []"], seed.name).toBeGreaterThan(0);
      expect(counts["interior boundary, neither neighbour (O7)"], seed.name).toBeGreaterThan(0);
    }
    // The dropped-whitespace classes exist only where an edit left whitespace the conversion
    // drops: a parse never does (absence), the block-start deletion does (presence).
    const parsed = reach.get(SEEDS[0].name) ?? {};
    expect(parsed["dropped whitespace click"] ?? 0).toBe(0);
    const deleted = reach.get(SEEDS[1].name) ?? {};
    expect(deleted["dropped whitespace click"]).toBeGreaterThan(0);
    // The exclusions are the `[1.53]` class only, a small minority of what was asserted.
    expect(excluded.every((member) => member.startsWith("encoded "))).toBe(true);
    const asserted = [...reach.values()]
      .flatMap((counts) => Object.entries(counts))
      .filter(([key]) => key.endsWith(" click") || key.endsWith(" []"))
      .reduce((sum, [, count]) => sum + count, 0);
    expect(excluded.length).toBeLessThan(asserted / 10);
    console.info(
      `[3.12] two-view corpus leg: ${JSON.stringify(Object.fromEntries(reach))}, excluded ${excluded.length}`,
    );
  });
});

/* ------------------------------------------------------------------ the guard enumeration -- */

/**
 * **The guard enumeration** (CLAUDE.md's cursor rule, DECISIONS #review-1-r8 N1): every mark kind
 * the schema declares (`emphasis`, `strong`, `delete`, `link`, `inline_code`) × both routes (the
 * click route, `storedMarks` `null`; the input-rule/Delete route, `storedMarks` `[]`) × both
 * edges × every textblock kind (paragraph, heading, list item, blockquote, table cell) × the
 * content (ASCII, a non-BMP symbol, a non-BMP letter — held inside the run, away from its
 * delimiters, where an astral neighbour would be the `[1.53]` punctuation class), for each of the
 * three findings. Each cell is a seed, a destructive transaction where the finding's native route
 * has one, and a caret; it asserts the two views' bytes with `toBe`, that the rendered bytes are a
 * fixed point of `parse ∘ format`, and the inverse at the caret.
 *
 * - **O7** — a link beside a run of kind K, the caret at the boundary between them: edge `start`
 *   is `q [ab](u)<K>` (the link's end is the run's start), edge `end` is `<K>[ab](u) r` (the run's
 *   end is the link's start). On the click route the link drops out of `$pos.marks()` (`inclusive:
 *   false`), so at the `start` edge the typed marks match neither neighbour. Its carried-subset
 *   twin, for the three kinds that can hold a link, is `q <K x [ab](u)> r` at the link's end
 *   (edge `end`) and `q <K [ab](u) x> r` at the link's start (edge `start`).
 * - **O8** — `<K x Y>` with the `x` deleted, so K's own first character is a space the conversion
 *   drops and the caret sits past it: edge `start` is the block's start (a stripped lead), edge
 *   `end` is a line start after a hard break (a gap between two kept nodes), held only by the
 *   kinds whose Markdown can put a hard break in one block. Y is a code span, so the space is its
 *   own node; for K `inline_code` itself, whose content the conversion never trims, the space is
 *   plain and the code span is the kept node after it.
 * - **O9** — a leaf beside the block's edge with the neighbouring character deleted: edge `start`
 *   is `a<K code>` with `a` deleted, edge `end` is `<K code>a` with `a` deleted (the block-end
 *   twin of 1.60). K wraps the code span; K `inline_code` is the bare span.
 */
describe("the guard enumeration: every mark kind × both routes × both edges × every textblock kind, ASCII and astral, for O7, O8 and O9 (task 3.12)", () => {
  type Kind = "emphasis" | "strong" | "delete" | "link" | "inline_code";
  const KINDS: Kind[] = ["emphasis", "strong", "delete", "link", "inline_code"];

  /** The Markdown for a run of kind K around `content`. A K `link` takes the url `v`. */
  function wrap(kind: Kind, content: string): string {
    switch (kind) {
      case "emphasis":
        return `*${content}*`;
      case "strong":
        return `**${content}**`;
      case "delete":
        return `~~${content}~~`;
      case "link":
        return `[${content}](v)`;
      case "inline_code":
        return `\`${content}\``;
    }
  }

  /** The textblock kinds, each spelling one block of one or more lines. */
  const BLOCKS: Record<string, { lines: number; spell: (lines: string[]) => string }> = {
    paragraph: { lines: 2, spell: (ls) => `${ls.join("\n")}\n` },
    heading: { lines: 1, spell: (ls) => `# ${ls[0]}\n` },
    "list item": { lines: 2, spell: (ls) => `- ${ls.join("\n  ")}\n` },
    blockquote: { lines: 2, spell: (ls) => `> ${ls.join("\n> ")}\n` },
    "table cell": { lines: 1, spell: (ls) => `| h |\n| - |\n| ${ls[0]} |\n` },
  };

  const CONTENTS: Record<string, string> = {
    ASCII: "cd",
    "a non-BMP symbol": "c\u{1F600}d",
    "a non-BMP letter": "c\u{10400}d",
  };

  const ROUTES: Record<string, readonly Mark[] | null> = {
    "the click route": null,
    "the input-rule route ([])": [],
  };

  /** The last textblock that holds content: the block every cell's caret is in. */
  function target(doc: Doc): { node: Doc; start: number } {
    let found: { node: Doc; start: number } | null = null;
    doc.descendants((node, pos) => {
      if (node.isTextblock && node.content.size > 0) found = { node, start: pos + 1 };
      return true;
    });
    expect(found, "the seed holds a textblock").not.toBeNull();
    return found as unknown as { node: Doc; start: number };
  }

  /** The live extent of the first child of the target block that `test` accepts. */
  function child(doc: Doc, test: (node: Doc) => boolean): { from: number; to: number } {
    const block = target(doc);
    let found: { from: number; to: number } | null = null;
    block.node.forEach((node, offset) => {
      if (found === null && test(node))
        found = { from: block.start + offset, to: block.start + offset + node.nodeSize };
    });
    expect(found, "the target block holds the child the cell names").not.toBeNull();
    return found as unknown as { from: number; to: number };
  }

  const linkTo = (href: string) => (node: Doc) =>
    node.marks.some((mark) => mark.type === schema.marks.link && mark.attrs.url === href);

  /** The first character of the target block's line that follows its first hard break, or its start. */
  function deleteFirstOfLine(doc: Doc, afterBreak: boolean): Doc {
    const block = target(doc);
    let at = block.start;
    if (afterBreak) {
      let found = -1;
      block.node.forEach((node, offset) => {
        if (found < 0 && node.type === schema.nodes.hard_break)
          found = block.start + offset + node.nodeSize;
      });
      expect(found, "the seed holds a hard break").toBeGreaterThan(0);
      at = found;
    }
    return EditorState.create({ doc }).tr.delete(at, at + 1).doc;
  }

  function deleteLast(doc: Doc): Doc {
    const block = target(doc);
    const end = block.start + block.node.content.size;
    return EditorState.create({ doc }).tr.delete(end - 1, end).doc;
  }

  interface Cell {
    readonly title: string;
    readonly lines: string[];
    readonly needs: number;
    readonly transact: (doc: Doc) => Doc;
    readonly caret: (doc: Doc) => number;
  }

  /** Every cell of the three findings for kind K, edge and content (block and route outside). */
  function cells(kind: Kind, content: string): Cell[] {
    const out: Cell[] = [];
    const run = wrap(kind, content);
    // O7: a link beside the run.
    out.push({
      title: `O7, the link's end is the run's start (\`q [ab](u)${run} r\`)`,
      lines: [`q [ab](u)${run} r`],
      needs: 1,
      transact: (doc) => doc,
      caret: (doc) => child(doc, linkTo("u")).to,
    });
    out.push({
      title: `O7, the run's end is the link's start (\`q ${run}[ab](u) r\`)`,
      lines: [`q ${run}[ab](u) r`],
      needs: 1,
      transact: (doc) => doc,
      caret: (doc) => child(doc, linkTo("u")).from,
    });
    if (kind === "emphasis" || kind === "strong" || kind === "delete") {
      const end = wrap(kind, `x${content} [ab](u)`);
      const start = wrap(kind, `[ab](u) x${content}`);
      out.push({
        title: `O7's carried subset, a link at the run's end (\`q ${end} r\`)`,
        lines: [`q ${end} r`],
        needs: 1,
        transact: (doc) => doc,
        caret: (doc) => child(doc, linkTo("u")).to,
      });
      out.push({
        title: `O7's carried subset, a link at the run's start (\`q ${start} r\`)`,
        lines: [`q ${start} r`],
        needs: 1,
        transact: (doc) => doc,
        caret: (doc) => child(doc, linkTo("u")).from,
      });
    }
    // O8: the run's own first character a space the conversion drops, the caret past it.
    const gapped =
      kind === "inline_code" ? `x ${wrap("inline_code", content)}` : wrap(kind, `x \`${content}\``);
    out.push({
      title: `O8, a stripped lead at the block's start (\`${gapped}\`, \`x\` deleted)`,
      lines: [gapped],
      needs: 1,
      transact: (doc) => deleteFirstOfLine(doc, false),
      caret: (doc) => target(doc).start + 1,
    });
    out.push({
      title: `O8, a gap at a line start after a hard break (\`a\\\\\` + \`${gapped}\`, \`x\` deleted)`,
      lines: ["a\\", gapped],
      needs: 2,
      transact: (doc) => deleteFirstOfLine(doc, true),
      caret: (doc) => child(doc, (node) => node.type === schema.nodes.hard_break).to + 1,
    });
    // O9: a code leaf at the block's edge, the neighbouring character deleted.
    const leaf =
      kind === "inline_code" ? wrap("inline_code", content) : wrap(kind, wrap("inline_code", content));
    out.push({
      title: `O9, the leaf at the block's start (\`a${leaf}\`, \`a\` deleted)`,
      lines: [`a${leaf}`],
      needs: 1,
      transact: (doc) => deleteFirstOfLine(doc, false),
      caret: (doc) => target(doc).start,
    });
    out.push({
      title: `O9's block-end twin, the leaf at the block's end (\`${leaf}a\`, \`a\` deleted)`,
      lines: [`${leaf}a`],
      needs: 1,
      transact: deleteLast,
      caret: (doc) => target(doc).start + target(doc).node.content.size,
    });
    return out;
  }

  let guards = 0;
  const reachedFindings = new Set<string>();
  const outcomes: Record<Outcome, string[]> = { agree: [], encoded: [], unrepresentable: [] };

  for (const kind of KINDS) {
    for (const [contentName, content] of Object.entries(CONTENTS)) {
      for (const cell of cells(kind, content)) {
        for (const [blockName, block] of Object.entries(BLOCKS)) {
          if (block.lines < cell.needs) continue;
          for (const [routeName, storedMarks] of Object.entries(ROUTES)) {
            it(`${kind}, ${contentName}, ${cell.title}, in a ${blockName}, ${routeName}: the two views write the same bytes`, () => {
              const editor = mdastToPM(parse(block.spell(cell.lines)));
              const doc = cell.transact(editor.doc);
              const root = pmToMdast({ doc, frontMatter: editor.frontMatter });
              const text = format(root);
              const map = cursorMap(root, doc);
              const pos = cell.caret(doc);
              const at = map.toSource(pos, storedMarks);
              const rendered = typedInRendered(doc, pos, storedMarks);
              const where = `${JSON.stringify(text)} at ${at.line}:${at.ch}`;
              const outcome = compare(text, at, rendered, where);
              outcomes[outcome].push(`${kind} | ${cell.title.slice(0, 2)} | ${routeName}`);
              expect(format(parse(rendered))).toBe(rendered);
              expect(map.toRendered(map.toSource(pos))).toBe(pos);
              guards += 1;
              reachedFindings.add(cell.title.slice(0, 2));
            });
          }
        }
      }
    }
  }

  it("ran every cell of the enumeration", () => {
    // The count is read from the run and recorded in the journal, never asserted as a literal:
    // five kinds × three contents × each kind's cells × the blocks that can hold them × two routes.
    expect(guards).toBeGreaterThan(0);
    expect([...reachedFindings].sort()).toEqual(["O7", "O8", "O9"]);
    expect(outcomes.agree.length + outcomes.encoded.length + outcomes.unrepresentable.length).toBe(
      guards,
    );
    // Every finding agrees on both routes for every kind but where a bounded class says why not.
    for (const finding of ["O7", "O8", "O9"]) {
      for (const route of Object.keys(ROUTES)) {
        expect(
          outcomes.agree.some((key) => key.includes(`| ${finding} | ${route}`)),
          `${finding} ${route}`,
        ).toBe(true);
      }
    }
    // The unrepresentable cells are a link's: `link` is the one mark `$pos.marks()` drops at an
    // edge while it keeps the code span's `inline_code` (or drops a link both neighbours hold), so
    // the typed character is code outside the link — no single source keystroke spells that.
    expect(outcomes.unrepresentable.every((key) => key.startsWith("link |"))).toBe(true);
    expect(outcomes.agree.length).toBeGreaterThan(
      outcomes.encoded.length + outcomes.unrepresentable.length,
    );
    const tally = (keys: string[]) =>
      Object.fromEntries(
        [...new Set(keys)].map((key) => [key, keys.filter((other) => other === key).length]),
      );
    console.info(
      `[3.12] guard enumeration: ${guards} cells; agree ${outcomes.agree.length}, encoded ${outcomes.encoded.length} ${JSON.stringify(tally(outcomes.encoded))}, unrepresentable ${outcomes.unrepresentable.length} ${JSON.stringify(tally(outcomes.unrepresentable))}`,
    );
  });
});

/* ------------------------------------------------------------------ one guard per branch ---- */

/**
 * **One test per guard the diff adds** (CLAUDE.md), enumerated from `toggle.ts`'s new branches
 * rather than from the acceptance sentences; the journal names the test that discharges each.
 * Every one is seeded from the editor's own document (a parse, then the transaction that reaches
 * the branch), and asserts the column, the two views' bytes and the inverse.
 */
describe("one guard per branch of task 3.12's diff (`interiorBoundary`, `inDroppedGap`, `isLeafStart`)", () => {
  interface Seeded {
    doc: Doc;
    text: string;
    map: CursorMap;
  }

  function seeded(source: string, transact: (doc: Doc) => Doc = (doc) => doc): Seeded {
    const editor = mdastToPM(parse(source));
    const doc = transact(editor.doc);
    const root = pmToMdast({ doc, frontMatter: editor.frontMatter });
    return { doc, text: format(root), map: cursorMap(root, doc) };
  }

  /** The position right after the first node of the first textblock that `test` accepts. */
  function after(doc: Doc, test: (node: Doc) => boolean): number {
    let found = -1;
    doc.descendants((node, pos) => {
      if (found >= 0) return false;
      if (test(node)) found = pos + node.nodeSize;
      return true;
    });
    expect(found, "the seed holds the node the guard names").toBeGreaterThan(0);
    return found;
  }

  /** `text` typed at `pos` with stored marks `[]`: an input rule's own route, as task 1.64's legs. */
  function typeAt(doc: Doc, pos: number, text: string): Doc {
    return EditorState.create({ doc }).tr.setStoredMarks([]).insertText(text, pos).doc;
  }

  const isBreak = (node: Doc) => node.type === schema.nodes.hard_break;

  function assertGuard(
    { doc, text, map }: Seeded,
    pos: number,
    storedMarks: readonly Mark[] | null,
    expected: { at: { line: number; ch: number }; bytes: string },
  ): void {
    const at = map.toSource(pos, storedMarks);
    expect(at).toEqual(expected.at);
    const rendered = typedInRendered(doc, pos, storedMarks);
    expect(rendered).toBe(expected.bytes);
    expect(typedInSource(text, at)).toBe(rendered);
    expect(map.toRendered(map.toSource(pos))).toBe(pos);
  }

  const em = () => [schema.marks.emphasis.create()];

  it("interiorBoundary, the typed marks match a neighbour: the boundary is left to innermostAt (`*cd* r` at the run's end on the click route is inside the `*`)", () => {
    const s = seeded("q *cd* r\n");
    const pos = after(s.doc, (node) => node.isText && node.text === "cd");
    assertGuard(s, pos, null, { at: { line: 1, ch: "q *cd".length }, bytes: "q *cdX* r\n" });
  });

  it("interiorBoundary, the opening side, a leading carried mark then one not carried: after the carried opening delimiter, before the first uncarried one (stored `[emphasis]` at `q [ab](u)***cd** e* r`)", () => {
    const s = seeded("q [ab](u)***cd** e* r\n");
    const pos = after(s.doc, (node) => node.isText && node.text === "ab");
    assertGuard(s, pos, em(), {
      at: { line: 1, ch: "q [ab](u)*".length },
      bytes: "q [ab](u)*X**cd** e* r\n",
    });
  });

  it("interiorBoundary, the opening side, every starting mark carried: the following leaf's own start (a gap before an image inside a run, `a\\` + `*x ![i](p)*`, `x` deleted)", () => {
    const s = seeded("a\\\n*x ![i](p)*\n", (doc) => {
      const at = after(doc, isBreak);
      return EditorState.create({ doc }).tr.delete(at, at + 1).doc;
    });
    expect(s.text).toBe("a\\\n*![i](p)*\n");
    const pos = after(s.doc, isBreak) + 1;
    expect(s.doc.resolve(pos).marks().map((mark) => mark.type.name)).toEqual(["emphasis"]);
    assertGuard(s, pos, null, { at: { line: 2, ch: 1 }, bytes: "a\\\n*X![i](p)*\n" });
  });

  it("interiorBoundary, the closing side, a run of uncarried ending marks: past the outermost one's closing delimiter (O7's native route, `q [ab](u)*cd* r` on the click route)", () => {
    const s = seeded("q [ab](u)*cd* r\n");
    const pos = after(s.doc, (node) => node.isText && node.text === "ab");
    assertGuard(s, pos, null, { at: { line: 1, ch: "q [ab](u)".length }, bytes: "q [ab](u)X*cd* r\n" });
  });

  it("interiorBoundary, the closing side, the innermost ending mark carried: the earlier leaf's own end, inside that mark's closing delimiter (stored `[emphasis, strong]` at `q *cd*[ab](u) r`, a set no keystroke spells)", () => {
    const s = seeded("q *cd*[ab](u) r\n");
    const pos = after(s.doc, (node) => node.isText && node.text === "cd");
    const stored = [schema.marks.emphasis.create(), schema.marks.strong.create()];
    const at = s.map.toSource(pos, stored);
    expect(at).toEqual({ line: 1, ch: "q *cd".length });
    // The caret keeps the one carried mark that ends here; the strong the stored set adds is
    // nowhere in the source, so no column of it spells the rendered bytes.
    const rendered = typedInRendered(s.doc, pos, stored);
    expect(compare(s.text, at, rendered, "stored [emphasis, strong]")).toBe("unrepresentable");
  });

  it("interiorBoundary, no leaf ends at the caret (stored marks inside one text node): answers nothing, and the text's own table places the caret as before", () => {
    const s = seeded("q *abc* r\n");
    const pos = after(s.doc, (node) => node.isText && node.text === "q ") + 2;
    expect(s.doc.textBetween(pos - 2, pos)).toBe("ab");
    expect(s.map.toSource(pos, [])).toEqual({ line: 1, ch: "q *ab".length });
    expect(s.map.toSource(pos, [])).toEqual(s.map.toSource(pos, null));
  });

  it("interiorBoundary, the closing side, nothing ends at the boundary: before the first starting mark's opening delimiter (a plain space typed after a break, before `*cd*`)", () => {
    const s = seeded("a\\\n*cd* e\n", (doc) => typeAt(doc, after(doc, isBreak), " "));
    expect(s.text).toBe("a\\\n*cd* e\n");
    const pos = after(s.doc, isBreak) + 1;
    assertGuard(s, pos, null, { at: { line: 2, ch: 0 }, bytes: "a\\\nX*cd* e\n" });
  });

  it("interiorBoundary, a gap with no mark on either side: answers nothing, and innermostAt gives the following leaf's own start (a plain space typed after a break, before an image)", () => {
    const s = seeded("a\\\n![i](p) e\n", (doc) => typeAt(doc, after(doc, isBreak), " "));
    expect(s.text).toBe("a\\\n![i](p) e\n");
    const pos = after(s.doc, isBreak) + 1;
    assertGuard(s, pos, null, { at: { line: 2, ch: 0 }, bytes: "a\\\nX![i](p) e\n" });
  });

  it("interiorBoundary, the same gap in a list item: the following node's start is after the continuation prefix, where the rendered view types", () => {
    const s = seeded("- a\\\n  *cd* e\n", (doc) => typeAt(doc, after(doc, isBreak), " "));
    expect(s.text).toBe("- a\\\n  *cd* e\n");
    const pos = after(s.doc, isBreak) + 1;
    assertGuard(s, pos, null, { at: { line: 2, ch: 2 }, bytes: "- a\\\n  X*cd* e\n" });
  });

  it("interiorBoundary, neither neighbour and no mark node on either side: answers nothing and leaves the boundary to innermostAt (stored `[emphasis]` between plain text and an image)", () => {
    const s = seeded("ab![i](p) c\n");
    const pos = after(s.doc, (node) => node.isText && node.text === "ab");
    // The typed set is one no keystroke spells (an emphasised letter between two plain nodes);
    // the branch's whole statement is that the old answer — the earlier node's end — stands.
    expect(s.map.toSource(pos, em())).toEqual({ line: 1, ch: 2 });
    expect(s.map.toSource(pos, em())).toEqual(s.map.toSource(pos, null));
  });

  it("inDroppedGap, a stripped lead at the block's start is not a gap: it is the block's start edge, and the edge rules answer it inside the carried run (O8's native route, `*x `+backtick+`bc`+backtick+`*`)", () => {
    const s = seeded("*x `bc`*\n", (doc) => EditorState.create({ doc }).tr.delete(1, 2).doc);
    expect(s.text).toBe("*`bc`*\n");
    assertGuard(s, 2, null, { at: { line: 1, ch: 1 }, bytes: "*X`bc`*\n" });
  });

  it("inDroppedGap, a lead inside a kept text node after a break is not a gap: the caret is inside that node, after the prefix", () => {
    const s = seeded("- a\\\n  bc d\n", (doc) => typeAt(doc, after(doc, isBreak), " "));
    expect(s.text).toBe("- a\\\n  bc d\n");
    const pos = after(s.doc, isBreak) + 1;
    assertGuard(s, pos, null, { at: { line: 2, ch: 2 }, bytes: "- a\\\n  Xbc d\n" });
  });

  it("isLeafStart, the typed marks carry `inline_code`: the span's own table, past the opening fence (O9 on the click route)", () => {
    const s = seeded("a`bc`\n", (doc) => EditorState.create({ doc }).tr.delete(1, 2).doc);
    assertGuard(s, 1, null, { at: { line: 1, ch: 1 }, bytes: "`Xbc`\n" });
  });

  it("isLeafStart, the typed marks do not carry `inline_code`: the span's start, before the opening fence (O9's native route, stored `[]` after a Delete)", () => {
    const s = seeded("a`bc`\n", (doc) => EditorState.create({ doc }).tr.delete(1, 2).doc);
    assertGuard(s, 1, [], { at: { line: 1, ch: 0 }, bytes: "X`bc`\n" });
  });

  it("isLeafStart, an atom at the block's start has no table: its own start on both routes, as before", () => {
    const s = seeded("a![i](p) c\n", (doc) => EditorState.create({ doc }).tr.delete(1, 2).doc);
    expect(s.text).toBe("![i](p) c\n");
    assertGuard(s, 1, [], { at: { line: 1, ch: 0 }, bytes: "X![i](p) c\n" });
    assertGuard(s, 1, null, { at: { line: 1, ch: 0 }, bytes: "X![i](p) c\n" });
  });
});
