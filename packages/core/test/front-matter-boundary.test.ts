import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Root, Yaml } from "mdast";
import { describe, expect, it } from "vitest";
import { format } from "../src/format.js";
import { parse } from "../src/parse.js";
import {
  FRONT_MATTER_KEYS,
  FRONT_MATTER_UNSUPPORTED,
  readFrontMatter,
  writeFrontMatter,
  type FrontMatterEntry,
  type FrontMatterField,
  type FrontMatterKey,
} from "../src/sidecar.js";

// ---------------------------------------------------------------------------
// The boundary the front-matter reader and writer must agree on (PRD §6.1).
//
// DECISIONS #review-0-r1:
//   G1 (blocker) — `KEY_LINE` compared literal key spellings, so `"question":` was neither a
//                  duplicate of `question:` nor found on its own: the writer rewrote the plain line
//                  beside the quoted duplicate, or appended a second spelling, and reported ok.
//   G2 (blocker) — `needsQuoting` tested five characters by hand and the single-quoted branch of
//                  `serializeScalar` escaped only the apostrophe, so U+0000, another C0 or C1
//                  control, DEL, U+2028, U+2029 or a lone surrogate went into the block raw;
//                  invariant A then failed on the written document, and `KEY_LINE` read the block
//                  back as malformed.
//   G7           — the newline refusal ran before the unchanged-value skip, so a no-op write of a
//                  value the reader had accepted and classified writable was refused.
//   G8           — the rule promoted into CLAUDE.md names an unchanged front-matter value as a
//                  corpus-wide identity case and no test carried it.
//
// Every case asserts both halves: the outcome, and that the block's bytes and the root's identity
// are untouched whenever the write does not rewrite something.
// ---------------------------------------------------------------------------

const withFrontMatter = (...lines: string[]): Root =>
  parse(["---", ...lines, "---", "", "## Nibs", "", "Steel nibs are stiff.", ""].join("\n"));

function yamlOf(root: Root): string {
  const node = root.children.find((child) => child.type === "yaml");
  if (node === undefined) throw new Error("document has no front matter");
  return (node as Yaml).value;
}

/** A write that must change nothing: the same root object and the same bytes, whatever it answered. */
function expectUntouched(root: Root, write: { readonly root: Root }, source: string): void {
  expect(write.root).toBe(root);
  expect(yamlOf(write.root)).toBe(yamlOf(root));
  expect(format(write.root)).toBe(source);
}

// ---------------------------------------------------------------------------
// G1 — a quoted spelling of an app-owned key
// ---------------------------------------------------------------------------

/** Spellings of `question` this line-oriented writer cannot address, so it must refuse the key. */
const QUOTED_SPELLINGS: readonly [string, string][] = [
  ["double-quoted", '"question"'],
  ["single-quoted", "'question'"],
  ["escaped", '"questio\\u006e"'],
];

describe("a quoted spelling of an app-owned key makes that key unsupported", () => {
  it.each(QUOTED_SPELLINGS)(
    "a %s spelling standing alone is refused and nothing is appended beside it",
    (_name, spelling) => {
      const root = withFrontMatter("title: The Fountain Pen", `${spelling}: What now?`);
      const source = format(root);
      const front = readFrontMatter(root);

      // Not a duplicate of anything, and the block is a flat mapping — but the key is still one
      // this writer cannot rewrite in place, so it is not writable.
      expect(front.malformed).toBe(false);
      expect(front.question).toMatchObject({ writable: false });

      const write = writeFrontMatter(root, { question: "What next?" });
      expect(write).toMatchObject({ ok: false, error: FRONT_MATTER_UNSUPPORTED, key: "question" });
      expectUntouched(root, write, source);
      // The bug this closes: the key looked absent, so the writer appended a second spelling.
      expect(yamlOf(write.root)).not.toContain("\nquestion:");
    },
  );

  it.each(QUOTED_SPELLINGS)(
    "a %s spelling beside the plain one is a duplicate and is refused",
    (_name, spelling) => {
      const root = withFrontMatter(
        "title: The Fountain Pen",
        "question: What now?",
        `${spelling}: What else?`,
      );
      const source = format(root);

      expect(readFrontMatter(root).question).toMatchObject({
        writable: false,
        reason: "duplicate",
      });

      const write = writeFrontMatter(root, { question: "What next?" });
      expect(write).toMatchObject({
        ok: false,
        error: FRONT_MATTER_UNSUPPORTED,
        key: "question",
        reason: "duplicate",
      });
      expectUntouched(root, write, source);
      // The bug this closes: the plain line was rewritten beside the quoted duplicate, ok:true.
      expect(yamlOf(write.root)).toContain("question: What now?");
    },
  );

  it.each(QUOTED_SPELLINGS)(
    "leaves the block's other keys readable beside a %s spelling",
    (_name, spelling) => {
      for (const lines of [
        ["title: The Fountain Pen", `${spelling}: What now?`],
        ["title: The Fountain Pen", "question: What now?", `${spelling}: What else?`],
      ]) {
        const root = withFrontMatter(...lines);
        expect(readFrontMatter(root).title).toMatchObject({
          writable: true,
          value: "The Fountain Pen",
        });
        // A write of only that key still goes through: the refusal is the quoted key's, not the block's.
        const write = writeFrontMatter(root, { title: "The Dip Pen" });
        expect(write).toMatchObject({ ok: true, changed: ["title"] });
        expect(yamlOf(write.root)).toContain("title: The Dip Pen");
      }
    },
  );

  it("a key that opens on a quote it never closes makes the block malformed", () => {
    const root = withFrontMatter("title: The Fountain Pen", '"question: never closed');
    const source = format(root);
    const front = readFrontMatter(root);
    expect(front.malformed).toBe(true);
    expect(front.title).toMatchObject({ writable: false, reason: "malformed" });
    const write = writeFrontMatter(root, { question: "What now?" });
    expect(write).toMatchObject({ ok: false, error: FRONT_MATTER_UNSUPPORTED, reason: "malformed" });
    expectUntouched(root, write, source);
  });
});

// ---------------------------------------------------------------------------
// G2 — one predicate owns every quoting decision
// ---------------------------------------------------------------------------

/** Values carrying a code point with no raw representation in any scalar style this writer emits. */
const UNWRITABLE: readonly [string, string][] = [
  ["U+0000", "a\u0000b"],
  ["U+0007", "a\u0007b"],
  ["U+007F", "a\u007fb"],
  ["U+0085", "a\u0085b"],
  ["U+2028", "a\u2028b"],
  ["U+2029", "a\u2029b"],
  ["a lone surrogate", "a\ud800b"],
];

/** The three quoting styles a seed line can already be in; the rule must hold for all three. */
const SEEDS: readonly [string, string][] = [
  ["plain", "question: seed"],
  ["single-quoted", "question: 'seed'"],
  ["double-quoted", 'question: "seed"'],
];

/**
 * The first code unit of `text` that `serializeScalar` must never emit raw, named for the failure
 * message, or `null`. Derived here from the ranges rather than imported, so the test states the
 * boundary independently of the predicate under test. `\n` is left out: it is the block's own
 * separator between key lines, never part of a scalar.
 */
function firstRawForbidden(text: string): string | null {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const paired =
      code <= 0xdbff
        ? text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff
        : text.charCodeAt(i - 1) >= 0xd800 && text.charCodeAt(i - 1) <= 0xdbff;
    const forbidden =
      (code < 0x20 && code !== 0x0a) ||
      code === 0x7f ||
      (code >= 0x80 && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      (code >= 0xd800 && code <= 0xdfff && !paired);
    if (forbidden) return `U+${code.toString(16).padStart(4, "0").toUpperCase()} at ${i}`;
  }
  return null;
}

describe("a value with no raw representation is escaped or refused, never written raw", () => {
  it.each(
    SEEDS.flatMap(([style, line]) =>
      UNWRITABLE.map(([name, value]) => [style, name, line, value] as const),
    ),
  )("a %s seed takes %s through a double-quoted scalar", (_style, _name, line, value) => {
    const root = withFrontMatter("title: The Fountain Pen", line);
    const source = format(root);
    const write = writeFrontMatter(root, { question: value });

    if (!write.ok) {
      // The other half of the acceptance: refused before any edit, nothing touched.
      expect(write.error).toBe(FRONT_MATTER_UNSUPPORTED);
      expectUntouched(root, write, source);
      return;
    }

    const block = yamlOf(write.root);
    // Never raw — neither the code unit itself nor any other the writer may not emit literally.
    expect(block).not.toContain(value.slice(1, 2));
    expect(firstRawForbidden(block)).toBeNull();
    // Only escapes the reader decodes, so nothing is left for YAML to reinterpret.
    expect(block).toMatch(
      /^question: "(?:[^"\\]|\\(?:[\\"/ntrbf0]|x[0-9a-f]{2}|u[0-9a-f]{4}))*"$/mu,
    );

    // The reader takes back exactly what was written.
    expect(readFrontMatter(write.root).question).toMatchObject({ writable: true, value });

    // Invariant A holds on the written document: formatting it again is a no-op.
    const written = format(write.root);
    expect(format(parse(written))).toBe(written);
    expect(readFrontMatter(parse(written)).question).toMatchObject({ writable: true, value });
  });
});

describe("the reader accepts a plain scalar exactly when the writer would emit it plain", () => {
  /** `!needsQuoting(v)`, observed through the writer: it left the value as a plain scalar. */
  function emittedPlain(value: string): boolean {
    const write = writeFrontMatter(withFrontMatter("question: seed"), { question: value });
    return write.ok && yamlOf(write.root) === `question: ${value}`;
  }

  /** `readable(v)`: the value put on the line raw reads back as this exact string. */
  function readable(value: string): boolean {
    const entry = readFrontMatter(withFrontMatter(`question: ${value}`)).question;
    return entry !== null && entry.writable && entry.value === value;
  }

  it.each([
    ...UNWRITABLE,
    // The four printable strings the 0.15 grammar test uses, so the table carries both answers.
    ["a colon with no space after it", "11:00 sharp"],
    ["an interior dash", "well-worn"],
    ["an interior hash", "C#minor"],
    ["an interior question mark", "what? now"],
  ] as readonly [string, string][])("readable(v) === !needsQuoting(v) for %s", (_name, value) => {
    expect(readable(value)).toBe(emittedPlain(value));
  });

  it("the table carries both answers, so the equality is not vacuous", () => {
    expect(emittedPlain("11:00 sharp")).toBe(true);
    expect(readable("11:00 sharp")).toBe(true);
    expect(emittedPlain("a\u0000b")).toBe(false);
    expect(readable("a\u0000b")).toBe(false);
  });
});

describe("a line carrying a line terminator that is not `\\n` is still a mapping line", () => {
  it("does not make the block malformed, and does not take the other key down with it", () => {
    // `KEY_LINE`'s `.` under the `u` flag without `s` excluded U+2028/U+2029, so this whole block
    // read as malformed and `title` became unwritable with it (#review-0-r1 G2).
    const root = withFrontMatter("title: The Fountain Pen", "question: a\u2028b");
    const front = readFrontMatter(root);
    expect(front.malformed).toBe(false);
    expect(front.title).toMatchObject({ writable: true, value: "The Fountain Pen" });
    // The value itself is still not one this writer can emit plain, so that key stays read-only.
    expect(front.question).toMatchObject({ writable: false, reason: "malformed" });
    expect(writeFrontMatter(root, { title: "The Dip Pen" })).toMatchObject({
      ok: true,
      changed: ["title"],
    });
  });

  it("keeps a full-line comment carrying one a comment", () => {
    const root = withFrontMatter("# a comment\u2028still a comment", "title: The Fountain Pen");
    const front = readFrontMatter(root);
    expect(front.malformed).toBe(false);
    expect(front.title).toMatchObject({ writable: true, value: "The Fountain Pen" });
  });
});

// ---------------------------------------------------------------------------
// G7 — the unchanged-value skip runs before the refusal
// ---------------------------------------------------------------------------

describe("a write that would not rewrite a key is never refused for that key", () => {
  it("a no-op write of a double-quoted value with a decoded newline is the identity", () => {
    const root = withFrontMatter("title: The Fountain Pen", 'question: "one\\ntwo"');
    const source = format(root);
    expect(readFrontMatter(root).question).toMatchObject({ writable: true, value: "one\ntwo" });

    const write = writeFrontMatter(root, { question: "one\ntwo" });
    expect(write).toMatchObject({ ok: true, changed: [] });
    expectUntouched(root, write, source);
  });

  it("skips the no-op key and writes the other one in the same call", () => {
    const root = withFrontMatter("title: The Fountain Pen", 'question: "one\\ntwo"');
    const write = writeFrontMatter(root, { question: "one\ntwo", title: "The Dip Pen" });
    expect(write).toMatchObject({ ok: true, changed: ["title"] });
    expect(yamlOf(write.root)).toBe('title: The Dip Pen\nquestion: "one\\ntwo"');
  });

  it("still refuses a value carrying a line break that it would actually write", () => {
    const root = withFrontMatter("title: The Fountain Pen", 'question: "one\\ntwo"');
    const source = format(root);
    const write = writeFrontMatter(root, { question: "one\nthree" });
    expect(write).toMatchObject({
      ok: false,
      error: FRONT_MATTER_UNSUPPORTED,
      key: "question",
      reason: "multi-line",
    });
    expectUntouched(root, write, source);
  });
});

// ---------------------------------------------------------------------------
// G8 — the corpus-wide identity case for an unchanged front-matter value
// ---------------------------------------------------------------------------

const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));

interface IndexEntry {
  nodeTypes: string[];
}

const index = JSON.parse(readFileSync(`${FIXTURES}/index.json`, "utf8")) as Record<
  string,
  IndexEntry
>;

/** Every fixture the index says carries a yaml node — the list, never a count, comes from there. */
const YAML_FIXTURES = Object.keys(index)
  .filter((name) => index[name].nodeTypes.includes("yaml"))
  .sort();

function entriesOf(root: Root): [FrontMatterKey, FrontMatterEntry][] {
  const front = readFrontMatter(root);
  return FRONT_MATTER_KEYS.flatMap((key): [FrontMatterKey, FrontMatterEntry][] => {
    const entry = front[key];
    return entry === null ? [] : [[key, entry]];
  });
}

const fixtureRoot = (name: string): Root => parse(readFileSync(`${FIXTURES}/${name}`, "utf8"));

describe("writing an app-owned front-matter value back unchanged is the identity, corpus-wide", () => {
  it("the index names at least one fixture carrying a yaml node", () => {
    expect(YAML_FIXTURES.length).toBeGreaterThan(0);
  });

  it.each(YAML_FIXTURES)("%s", (name) => {
    const root = fixtureRoot(name);
    const source = format(root);
    const entries = entriesOf(root);

    for (const [key, entry] of entries) {
      if (entry.writable) {
        // The no-op argument: the value just read, written straight back.
        const write = writeFrontMatter(root, { [key]: entry.value });
        expect(write).toMatchObject({ ok: true, changed: [] });
        expectUntouched(root, write, source);
      } else {
        const write = writeFrontMatter(root, { [key]: "A replacement." });
        expect(write).toMatchObject({
          ok: false,
          error: FRONT_MATTER_UNSUPPORTED,
          key,
          reason: entry.reason,
        });
        expectUntouched(root, write, source);
      }
    }

    // And every writable key at once, in one call, is the same identity.
    const writable = entries.filter(([, entry]) => entry.writable);
    if (writable.length > 0 && writable.length === entries.length) {
      const values = Object.fromEntries(
        writable.map(([key, entry]) => [key, (entry as FrontMatterField).value]),
      );
      const write = writeFrontMatter(root, values);
      expect(write).toMatchObject({ ok: true, changed: [] });
      expectUntouched(root, write, source);
    }
  });

  it.each(
    Object.keys(index)
      .filter((name) => !index[name].nodeTypes.includes("yaml"))
      .sort(),
  )("%s has no block to write into, and is left alone", (name) => {
    // The absence case of the same corpus-wide rule: creating a block is not the app's job.
    const root = fixtureRoot(name);
    const source = format(root);
    const write = writeFrontMatter(root, { question: "A replacement." });
    expect(write).toMatchObject({
      ok: false,
      error: FRONT_MATTER_UNSUPPORTED,
      reason: "no-front-matter",
    });
    expect(write.root).toBe(root);
    expect(format(write.root)).toBe(source);
  });

  it("the corpus carries both a writable app-owned key and one that is not", () => {
    const seen = YAML_FIXTURES.flatMap((name) =>
      entriesOf(fixtureRoot(name)).map(([, entry]) => entry.writable),
    );
    expect(seen).toContain(true);
    expect(seen).toContain(false);
  });
});
