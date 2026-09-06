import { describe, expect, it } from "vitest";
import type { Root, Yaml } from "mdast";
import { format } from "../src/format.js";
import { parse } from "../src/parse.js";
import {
  FRONT_MATTER_UNSUPPORTED,
  readFrontMatter,
  writeFrontMatter,
  type FrontMatterField,
  type FrontMatterKey,
  type FrontMatterUnsupportedReason,
} from "../src/sidecar.js";

// ---------------------------------------------------------------------------
// The supported grammar of the two app-owned front-matter scalars (PRD §6.1).
//
// DECISIONS #review-0-r0 F2 (Sol findings 3 and 5): the scanner used to accept what it could not
// represent — a malformed plain scalar (`title: bad: mapping`), an unknown escape (`"\q"` read as
// `q`), a misdecoded `\uXXXX` (`"\u0041"` read as `u0041`) — and to write a value carrying a
// newline into a one-line block as two physical lines, reporting success. Every case below asserts
// both halves: the outcome, and that the block's bytes and the root's identity are untouched.
// ---------------------------------------------------------------------------

const withFrontMatter = (...lines: string[]): Root =>
  parse(["---", ...lines, "---", "", "## Nibs", "", "Steel nibs are stiff.", ""].join("\n"));

function yamlOf(root: Root): string {
  const node = root.children.find((child) => child.type === "yaml");
  if (node === undefined) throw new Error("document has no front matter");
  return (node as Yaml).value;
}

/** The `question` field, which this case expects to be readable and writable. */
function writableQuestion(root: Root): FrontMatterField {
  const entry = readFrontMatter(root).question;
  expect(entry).toMatchObject({ writable: true });
  return entry as FrontMatterField;
}

/** A write that must be refused whole: the reason, the same root object, the same bytes. */
function refuse(
  root: Root,
  values: Partial<Record<FrontMatterKey, string>>,
  reason: FrontMatterUnsupportedReason,
): void {
  const before = yamlOf(root);
  const source = format(root);
  const write = writeFrontMatter(root, values);
  expect(write).toMatchObject({ ok: false, error: FRONT_MATTER_UNSUPPORTED, reason });
  expect(write.root).toBe(root);
  expect(yamlOf(write.root)).toBe(before);
  expect(format(write.root)).toBe(source);
}

// ---------------------------------------------------------------------------
// double-quoted: the escapes the grammar lists, decoded and re-encoded
// ---------------------------------------------------------------------------

describe("a double-quoted scalar decodes exactly the escapes of the grammar", () => {
  it.each([
    ["\\u0041", "A", "the acceptance's own case"],
    ["\\u00e9", "\u00e9", "a non-ASCII code point"],
    ["\\ud83d\\ude00", "\u{1f600}", "a surrogate pair"],
    ["\\x41", "A", "the two-digit form"],
    ["\\x7f", "\u007f", "a control character"],
    ["\\\\", "\\", "a backslash"],
    ['\\"', '"', "a quote"],
    ["\\/", "/", "a solidus"],
    ["\\n", "\n", "a newline"],
    ["\\t", "\t", "a tab"],
    ["\\r", "\r", "a carriage return"],
    ["\\b", "\b", "a backspace"],
    ["\\f", "\f", "a form feed"],
    ["\\0", "\0", "a null"],
  ])("reads %s as %j (%s)", (escape, decoded) => {
    const root = withFrontMatter(`question: "a${escape}b"`);
    expect(writableQuestion(root).value).toBe(`a${decoded}b`);
    expect(writableQuestion(root).quote).toBe('"');
  });

  it('reads `"\\u0041"` as `A` and re-encodes it preserving the quoting', () => {
    const root = withFrontMatter("title: The Fountain Pen", 'question: "\\u0041"');
    expect(writableQuestion(root).value).toBe("A");

    // Writing the value it already holds is not a rewrite at all, so every byte survives.
    const same = writeFrontMatter(root, { question: "A" });
    expect(same).toMatchObject({ ok: true, changed: [] });
    expect(same.root).toBe(root);
    expect(yamlOf(same.root)).toBe('title: The Fountain Pen\nquestion: "\\u0041"');

    // A different value keeps the double quoting and is emitted in the same grammar.
    const next = writeFrontMatter(root, { question: 'A "B"' });
    expect(next).toMatchObject({ ok: true, changed: ["question"] });
    expect(yamlOf(next.root)).toBe('title: The Fountain Pen\nquestion: "A \\"B\\""');
    expect(writableQuestion(next.root).value).toBe('A "B"');
  });

  it.each([
    ["a plain letter", "A"],
    ["an embedded quote", 'a "quoted" one'],
    ["a backslash", "a\\b"],
    ["a tab", "a\tb"],
    ["a backspace", "a\bb"],
    ["a form feed", "a\fb"],
    ["a null", "a\0b"],
    ["a C0 control", "a\u001fb"],
    ["a DEL", "a\u007fb"],
    ["a C1 control", "a\u0085b"],
    ["a non-ASCII letter", "caf\u00e9"],
    ["an astral code point", "ink \u{1f58b}"],
    ["a colon-space sequence", "one: two"],
    ["a leading indicator", "#hash"],
    ["a single quote", "it's here"],
  ])("round-trips %s through the double-quoted form", (_name, value) => {
    const root = withFrontMatter('question: "seed"');
    const write = writeFrontMatter(root, { question: value });
    expect(write).toMatchObject({ ok: true, changed: ["question"] });
    expect(writableQuestion(write.root).value).toBe(value);
    // Only the escapes the grammar decodes may appear, so nothing is left for YAML to reinterpret.
    expect(yamlOf(write.root)).toMatch(
      /^question: "(?:[^"\\]|\\(?:[\\"/ntrbf0]|x[0-9a-f]{2}|u[0-9a-f]{4}))*"$/u,
    );
  });
});

describe("a double-quoted scalar outside the grammar is read-only", () => {
  it.each([
    ["an unknown escape", 'question: "\\q"', "malformed"],
    ["an escaped single quote", 'question: "\\\'"', "malformed"],
    ["a \\u with too few digits", 'question: "\\u00"', "malformed"],
    ["a \\u with a non-hex digit", 'question: "\\u12g4"', "malformed"],
    ["a \\x with too few digits", 'question: "\\x"', "malformed"],
    ["a \\x with a non-hex digit", 'question: "\\xZZ"', "malformed"],
    ["junk after the closing quote", 'question: "closed" junk', "malformed"],
    ["a comment with no space before it", 'question: "closed"# c', "malformed"],
    ["an unterminated scalar", 'question: "never closed', "multi-line"],
    ["a dangling backslash", 'question: "dangling \\', "multi-line"],
  ])("%s reports FrontMatterUnsupported and refuses the write", (_name, line, reason) => {
    const root = withFrontMatter("title: The Fountain Pen", line);
    expect(readFrontMatter(root).question).toMatchObject({ writable: false, reason });
    refuse(root, { question: "What now?" }, reason as FrontMatterUnsupportedReason);
    // The other app-owned key is refused with it: nothing is written when one key is unsupported.
    refuse(
      root,
      { title: "Changed", question: "What now?" },
      reason as FrontMatterUnsupportedReason,
    );
  });
});

// ---------------------------------------------------------------------------
// plain and single-quoted
// ---------------------------------------------------------------------------

describe("a plain scalar outside the grammar is read-only", () => {
  it.each([
    ["a mapping-looking value", "question: bad: mapping", "malformed"],
    ["a trailing colon", "question: trailing:", "malformed"],
    ["a leading dash", "question: -leading", "indicator"],
    ["a leading question mark", "question: ?leading", "indicator"],
    ["a leading colon", "question: :leading", "indicator"],
    ["a leading comma", "question: ,leading", "indicator"],
    ["a leading closing bracket", "question: ]leading", "indicator"],
    ["a leading closing brace", "question: }leading", "indicator"],
    ["a leading hash", "question: #leading", "indicator"],
    ["a leading anchor", "question: &anchored yes", "indicator"],
    ["a leading percent", "question: %directive", "indicator"],
    ["a leading backtick", "question: `reserved", "indicator"],
  ])("%s reports FrontMatterUnsupported and refuses the write", (_name, line, reason) => {
    const root = withFrontMatter("title: The Fountain Pen", line);
    expect(readFrontMatter(root).question).toMatchObject({ writable: false, reason });
    refuse(root, { question: "What now?" }, reason as FrontMatterUnsupportedReason);
  });

  it("`title: bad: mapping` is read-only and its whole block survives a write", () => {
    const root = withFrontMatter("title: bad: mapping", "question: What now?");
    expect(readFrontMatter(root).title).toMatchObject({ writable: false, reason: "malformed" });
    refuse(root, { title: "The Fountain Pen" }, "malformed");
    // The key the write does not name is untouched too, because the refusal is whole-block.
    refuse(root, { title: "The Fountain Pen", question: "What next?" }, "malformed");
  });
});

describe("the plain and single-quoted forms the grammar does accept", () => {
  it.each([
    ["a colon with no space after it", "question: 11:00 sharp", "11:00 sharp"],
    ["an interior question mark", "question: what? now", "what? now"],
    ["an interior dash", "question: well-worn", "well-worn"],
    ["an interior hash", "question: C#minor", "C#minor"],
    ["a doubled quote", "question: 'It''s here'", "It's here"],
    ["a single-quoted colon", "question: 'one: two'", "one: two"],
  ])("reads %s", (_name, line, value) => {
    expect(writableQuestion(withFrontMatter(line)).value).toBe(value);
  });

  it("a plain scalar is readable exactly when the writer would emit it plain", () => {
    const seed = withFrontMatter("question: seed");
    for (const value of ["11:00 sharp", "well-worn", "C#minor", "what? now"]) {
      const written = yamlOf(writeFrontMatter(seed, { question: value }).root);
      expect(written).toBe(`question: ${value}`);
      expect(writableQuestion(withFrontMatter(written)).value).toBe(value);
    }
  });
});

// ---------------------------------------------------------------------------
// a replacement value that carries a line break
// ---------------------------------------------------------------------------

describe("a replacement value carrying a line break is refused for every quoting style", () => {
  const MULTILINE: readonly [string, string][] = [
    ["a newline", "Line one\nLine two"],
    ["a carriage return", "Line one\rLine two"],
    ["a CRLF pair", "Line one\r\nLine two"],
  ];
  const TITLES: readonly [string, string][] = [
    ["plain", "title: The Fountain Pen"],
    ["single-quoted", "title: 'The Fountain Pen'"],
    ["double-quoted", 'title: "The Fountain Pen"'],
  ];

  it.each(
    TITLES.flatMap(([style, line]) =>
      MULTILINE.map(([shape, value]) => [style, shape, line, value] as const),
    ),
  )("a %s title refuses %s", (_style, _shape, line, value) => {
    const root = withFrontMatter(line, "question: What now?");
    refuse(root, { title: value }, "multi-line");
    // Refused before any edit, so the key the same call would otherwise have written is untouched.
    refuse(root, { question: "What next?", title: value }, "multi-line");
    expect(writableQuestion(root).value).toBe("What now?");
  });

  it.each(MULTILINE)("refuses %s for a key the block does not carry yet", (_shape, value) => {
    refuse(withFrontMatter("title: The Fountain Pen"), { question: value }, "multi-line");
  });

  it("refuses the line break before it looks at the block at all", () => {
    // A document with no front matter would answer `no-front-matter`; the value is refused first.
    const bare = parse("## Nibs\n\nSteel nibs are stiff.\n");
    const write = writeFrontMatter(bare, { question: "Line one\nLine two" });
    expect(write).toMatchObject({
      ok: false,
      error: FRONT_MATTER_UNSUPPORTED,
      key: "question",
      reason: "multi-line",
    });
    expect(write.root).toBe(bare);
    expect(format(write.root)).toBe(format(bare));
  });
});
