import { describe, expect, it } from "vitest";
import type { Root, Yaml } from "mdast";
import { blocksOf } from "../src/blocks.js";
import { format } from "../src/format.js";
import { parse } from "../src/parse.js";
import { reorderSentences } from "../src/sentences.js";
import {
  applyMoveSection,
  applyReorderSentences,
  attach,
  candidatesOf,
  DICE_THRESHOLD,
  emptySidecar,
  FRONT_MATTER_UNSUPPORTED,
  mirrorFrontMatter,
  parseSidecar,
  readFrontMatter,
  refresh,
  resolveAnchor,
  sorensenDice,
  writeFrontMatter,
  type Anchor,
  type DocumentState,
  type FrontMatterField,
  type Sidecar,
} from "../src/sidecar.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const AT = "2026-09-06T00:00:00Z";

/** The contentId of the n-th top-level paragraph, which is what sentence operations address. */
function paragraphId(root: Root, n = 0): string {
  const paragraphs = blocksOf(root).filter(
    (block) => block.path.length === 1 && block.node.type === "paragraph",
  );
  return paragraphs[n].contentId;
}

/** An anchor for the candidate the predicate picks, exactly as the document currently holds it. */
function anchorFor(
  root: Root,
  kind: Anchor["kind"],
  predicate: (text: string, occurrence: number) => boolean,
): Anchor {
  const candidate = candidatesOf(root).find(
    (one) => one.kind === kind && predicate(one.text, one.occurrence),
  );
  if (candidate === undefined) throw new Error(`no ${kind} candidate matched`);
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

function rewriteFor(root: Root, sentence: string, variant: string) {
  return {
    anchor: anchorFor(root, "sentence", (text) => text === sentence),
    variants: [{ text: variant, createdAt: AT }],
    chosen: 0,
    history: [],
  };
}

function samePos(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** The single variant of the rewrite entry sitting at `pos`, or undefined when nothing is there. */
function variantAt(sidecar: Sidecar, pos: readonly number[]): string | undefined {
  return sidecar.rewrites.find((entry) => samePos(entry.anchor.pos, pos))?.variants[0].text;
}

/** The question of the heading entry sitting at `pos`. */
function questionAt(sidecar: Sidecar, pos: readonly number[]): string | undefined {
  return sidecar.headings.find((entry) => samePos(entry.anchor.pos, pos))?.question;
}

function yamlOf(root: Root): string {
  const node = root.children.find((child) => child.type === "yaml");
  if (node === undefined) throw new Error("document has no front matter");
  return (node as Yaml).value;
}

// ---------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------

const NIB_SENTENCE = "A steel nib flexes less than gold.";

const PARAGRAPH_DOC = [
  "## Why the fountain pen endures",
  "",
  `The nib is the part that matters most in daily use. ${NIB_SENTENCE} Ink flow depends on the feed.`,
  "",
].join("\n");

/** Two byte-identical sentences around a third that tells them apart in the assertions. */
const TWIN_SENTENCE = "The nib is the point.";
const TWIN_SENTENCE_DOC = [
  "## Ink",
  "",
  `${TWIN_SENTENCE} ${TWIN_SENTENCE} Everything else is the handle.`,
  "",
].join("\n");

const TWIN_HEADING_DOC = [
  "## Notes on nibs",
  "",
  "Steel nibs are stiff.",
  "",
  "## Notes on nibs",
  "",
  "Gold nibs have some spring.",
  "",
].join("\n");

/** The same two sections, swapped by something that is not this app (§6.2, external edit). */
const TWIN_HEADING_DOC_SWAPPED = [
  "## Notes on nibs",
  "",
  "Gold nibs have some spring.",
  "",
  "## Notes on nibs",
  "",
  "Steel nibs are stiff.",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// schema (§6.2)
// ---------------------------------------------------------------------------

describe("sidecar schema", () => {
  const anchor = (over: Partial<Anchor> = {}): Anchor => ({
    kind: "sentence",
    hash: "0000000000000",
    occurrence: 0,
    text: "A sentence.",
    sectionHash: null,
    blockHash: "1111111111111",
    depth: null,
    pos: [0, 0],
    ...over,
  });

  it("rejects a sidecar with no version with the message the acceptance names", () => {
    const result = parseSidecar.bind(null, { topicQuestion: "What?" });
    expect(result).toThrow(/sidecar version missing/);

    const issues = sidecarIssues({ topicQuestion: "What?" });
    expect(issues).toContainEqual({ path: "version", message: "sidecar version missing" });
  });

  it("rejects a version that is present but not 1, with a different message", () => {
    expect(sidecarIssues({ version: 2 })).toContainEqual({
      path: "version",
      message: "sidecar version must be 1",
    });
    expect(sidecarIssues({ version: 2 })).not.toContainEqual({
      path: "version",
      message: "sidecar version missing",
    });
  });

  it("fills every list and both mirrored keys with defaults", () => {
    expect(emptySidecar()).toEqual({
      version: 1,
      title: null,
      topicQuestion: null,
      headings: [],
      rewrites: [],
      coach: [],
      orphans: [],
    });
  });

  it("round-trips the §6.2 example shape through JSON", () => {
    const sidecar = parseSidecar({
      version: 1,
      topicQuestion: "What should wrap the editor?",
      headings: [
        {
          anchor: anchor({ kind: "heading", blockHash: null, depth: 2, pos: [0] }),
          question: "What should wrap the editor?",
        },
      ],
      rewrites: [
        { anchor: anchor(), variants: [{ text: "…", createdAt: AT }], chosen: 0, history: [] },
      ],
      coach: [{ anchor: anchor(), scope: "sentence", question: "Why?", askedAt: AT }],
      orphans: [],
    });
    expect(parseSidecar(JSON.parse(JSON.stringify(sidecar)))).toEqual(sidecar);
  });

  it("enforces that a coach entry's anchor kind equals its scope, both ways", () => {
    const ok = { anchor: anchor({ kind: "paragraph", blockHash: null, pos: [3] }) };
    expect(() =>
      parseSidecar({
        version: 1,
        coach: [{ ...ok, scope: "paragraph", question: "Why?", askedAt: AT }],
      }),
    ).not.toThrow();
    expect(() =>
      parseSidecar({
        version: 1,
        coach: [{ ...ok, scope: "sentence", question: "Why?", askedAt: AT }],
      }),
    ).toThrow(/coach entry anchor kind must equal its scope/);
    // There is no essay scope in v1 (§6.2).
    expect(() =>
      parseSidecar({
        version: 1,
        coach: [{ anchor: anchor(), scope: "essay", question: "Why?", askedAt: AT }],
      }),
    ).toThrow();
  });

  it("enforces the anchor kind of heading and rewrite entries", () => {
    expect(() =>
      parseSidecar({ version: 1, headings: [{ anchor: anchor(), question: "Why?" }] }),
    ).toThrow(/heading entry must carry a heading anchor/);
    expect(() =>
      parseSidecar({
        version: 1,
        rewrites: [{ anchor: anchor({ kind: "heading", blockHash: null, pos: [0] }) }],
      }),
    ).toThrow(/rewrite entry must carry a sentence anchor/);
  });

  it("rejects a hash that is not a 13-character content id", () => {
    expect(() =>
      parseSidecar({ version: 1, rewrites: [{ anchor: anchor({ hash: "abc" }) }] }),
    ).toThrow();
  });

  it("keeps an orphan tagged with the list it came from", () => {
    const sidecar = parseSidecar({
      version: 1,
      orphans: [{ list: "rewrites", entry: { anchor: anchor() } }],
    });
    expect(sidecar.orphans[0].list).toBe("rewrites");
    expect(() =>
      parseSidecar({ version: 1, orphans: [{ list: "sentences", entry: { anchor: anchor() } }] }),
    ).toThrow();
  });
});

function sidecarIssues(value: unknown): { path: string; message: string }[] {
  try {
    parseSidecar(value);
  } catch (error) {
    return (error as { issues: { path: (string | number)[]; message: string }[] }).issues.map(
      (issue) => ({ path: issue.path.join("."), message: issue.message }),
    );
  }
  throw new Error("expected the sidecar to be rejected");
}

// ---------------------------------------------------------------------------
// candidates and similarity
// ---------------------------------------------------------------------------

describe("candidatesOf", () => {
  it("collects headings, top-level paragraphs and their sentences with nested section hashes", () => {
    const root = parse(
      ["# Essay", "", "## Nibs", "", "One. Two.", "", "### Steel", "", "Three.", ""].join("\n"),
    );
    const candidates = candidatesOf(root);
    const kinds = candidates.map((one) => one.kind);
    expect(kinds.filter((kind) => kind === "heading")).toHaveLength(3);
    expect(kinds.filter((kind) => kind === "paragraph")).toHaveLength(2);
    expect(kinds.filter((kind) => kind === "sentence")).toHaveLength(3);

    const essay = candidates.find((one) => one.text === "Essay");
    const nibs = candidates.find((one) => one.text === "Nibs");
    const steel = candidates.find((one) => one.text === "Steel");
    expect(essay?.sectionHash).toBeNull();
    expect(nibs?.sectionHash).toBe(essay?.hash);
    expect(steel?.sectionHash).toBe(nibs?.hash);
    expect([essay?.depth, nibs?.depth, steel?.depth]).toEqual([1, 2, 3]);

    // A sentence is scoped by its paragraph and positioned by [blockIndex, sentenceIndex].
    const two = candidates.find((one) => one.kind === "sentence" && one.text === "Two.");
    const paragraph = candidates.find((one) => one.kind === "paragraph" && one.text === "One. Two.");
    expect(two?.blockHash).toBe(paragraph?.hash);
    expect(two?.pos).toEqual([paragraph?.pos[0], 1]);
    expect(two?.sectionHash).toBe(nibs?.hash);
  });

  it("numbers repeated items by occurrence in document order", () => {
    const root = parse(TWIN_SENTENCE_DOC);
    const twins = candidatesOf(root).filter(
      (one) => one.kind === "sentence" && one.text === TWIN_SENTENCE,
    );
    expect(twins.map((one) => one.occurrence)).toEqual([0, 1]);
    expect(twins.map((one) => one.pos[1])).toEqual([0, 1]);
  });

  it("does not offer sentences of nested paragraphs (§6.1 v1 scope)", () => {
    const root = parse(["> A quoted sentence.", "", "- A list sentence.", ""].join("\n"));
    expect(candidatesOf(root).filter((one) => one.kind === "sentence")).toHaveLength(0);
  });
});

describe("sorensenDice", () => {
  it("is 1 for the same text, 0 for disjoint text, and symmetric", () => {
    expect(sorensenDice("the nib is the point", "the nib is the point")).toBe(1);
    expect(sorensenDice("aaaa", "bbbb")).toBe(0);
    expect(sorensenDice("the nib", "the pen")).toBe(sorensenDice("the pen", "the nib"));
  });

  it("ignores case and whitespace shape, because §6.1 normalization does", () => {
    expect(sorensenDice("The Nib", "  the   nib  ")).toBe(1);
  });

  it("compares texts too short to have bigrams by equality", () => {
    expect(sorensenDice("a", "a")).toBe(1);
    expect(sorensenDice("a", "b")).toBe(0);
    expect(sorensenDice("a", "ab")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// the five-step resolution order (§6.2)
// ---------------------------------------------------------------------------

describe("resolveAnchor walks the five steps of §6.2", () => {
  it("step 1: exact hash and occurrence inside the same scope", () => {
    const root = parse(PARAGRAPH_DOC);
    const anchor = anchorFor(root, "sentence", (text) => text === NIB_SENTENCE);
    const resolution = resolveAnchor(anchor, root);
    expect(resolution?.step).toBe(1);
    expect(resolution?.anchor).toEqual(anchor);
    expect(resolution?.duplicate).toBe(false);
  });

  it("step 2: the scope moved but the hash and occurrence did not", () => {
    const root = parse(PARAGRAPH_DOC);
    const anchor = anchorFor(root, "sentence", (text) => text === NIB_SENTENCE);
    const edited = parse(PARAGRAPH_DOC.replace("daily use", "regular use"));

    const resolution = resolveAnchor(anchor, edited);
    expect(resolution?.step).toBe(2);
    expect(resolution?.anchor.hash).toBe(anchor.hash);
    expect(resolution?.anchor.blockHash).not.toBe(anchor.blockHash);
  });

  it("step 3: same text, different ordinal — the one nearest to pos wins", () => {
    const root = parse(
      ["Alpha. Beta.", "", "Alpha. Gamma.", "", "Alpha. Delta.", ""].join("\n"),
    );
    const candidates = candidatesOf(root).filter(
      (one) => one.kind === "sentence" && one.text === "Alpha.",
    );
    expect(candidates).toHaveLength(3);
    // An occurrence the document no longer has, remembered at the last paragraph's position.
    const anchor: Anchor = {
      kind: "sentence",
      hash: candidates[0].hash,
      occurrence: 9,
      text: "Alpha.",
      sectionHash: null,
      blockHash: "0000000000000",
      depth: null,
      pos: [...candidates[2].pos],
    };
    const resolution = resolveAnchor(anchor, root);
    expect(resolution?.step).toBe(3);
    expect(resolution?.anchor.pos).toEqual(candidates[2].pos);
    expect(resolution?.duplicate).toBe(true);

    // Move the remembered position to the middle paragraph and the answer moves with it.
    const nearer = resolveAnchor({ ...anchor, pos: [...candidates[1].pos] }, root);
    expect(nearer?.anchor.pos).toEqual(candidates[1].pos);
  });

  it("step 4: no exact hash anywhere, but a near-enough text in the same section", () => {
    const root = parse(PARAGRAPH_DOC);
    const anchor = anchorFor(root, "sentence", (text) => text === NIB_SENTENCE);
    const edited = parse(
      PARAGRAPH_DOC.replace(NIB_SENTENCE, "A steel nib flexed less then gold."),
    );

    const resolution = resolveAnchor(anchor, edited);
    expect(resolution?.step).toBe(4);
    expect(resolution?.anchor.text).toBe("A steel nib flexed less then gold.");
    expect(resolution?.score).toBeGreaterThanOrEqual(DICE_THRESHOLD);
  });

  it("step 4 prefers the same section over a better score elsewhere only when one is close enough", () => {
    const original = parse(
      [
        "## One",
        "",
        "The nib is the part that matters most in daily use.",
        "",
        "## Two",
        "",
        "Ink flow depends on the feed of the pen.",
        "",
      ].join("\n"),
    );
    const anchor = anchorFor(original, "sentence", (text) => text.startsWith("The nib is the part"));
    // Section One's sentence is edited; section Two grows a sentence that is closer to the
    // original than the edit is. §6.2 restricts to the same section first, so the edit wins.
    const edited = parse(
      [
        "## One",
        "",
        "The nib is the part that matters most in normal use.",
        "",
        "## Two",
        "",
        "The nib is the part that matters most in daily usage.",
        "",
      ].join("\n"),
    );
    const resolution = resolveAnchor(anchor, edited);
    expect(resolution?.step).toBe(4);
    expect(resolution?.anchor.pos[0]).toBe(1);
    expect(resolution?.anchor.text).toBe(
      "The nib is the part that matters most in normal use.",
    );
  });

  it("step 5: nothing close enough is null", () => {
    const root = parse(PARAGRAPH_DOC);
    const anchor = anchorFor(root, "sentence", (text) => text === NIB_SENTENCE);
    const rewritten = parse(
      PARAGRAPH_DOC.replace(NIB_SENTENCE, "Cartridges are convenient when travelling."),
    );
    expect(resolveAnchor(anchor, rewritten)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// attach / refresh — the acceptance's sentence-variant cases
// ---------------------------------------------------------------------------

describe("attach keeps a variant on its sentence", () => {
  const start = (): DocumentState => {
    const root = parse(PARAGRAPH_DOC);
    return {
      root,
      sidecar: parseSidecar({
        version: 1,
        rewrites: [rewriteFor(root, NIB_SENTENCE, "A steel nib gives less than gold.")],
      }),
    };
  };

  it("survives changing one word elsewhere in the paragraph", () => {
    const { sidecar } = start();
    const edited = parse(PARAGRAPH_DOC.replace("daily use", "regular use"));

    const result = attach(sidecar, edited);
    expect(result.sidecar.orphans).toEqual([]);
    expect(result.sidecar.rewrites).toHaveLength(1);
    expect(result.sidecar.rewrites[0].anchor.text).toBe(NIB_SENTENCE);
    expect(result.resolutions).toEqual([
      { list: "rewrites", index: 0, step: 2, score: null, duplicate: false },
    ]);
  });

  it("survives a two-character change in the sentence itself", () => {
    const { sidecar } = start();
    const twoCharacters = "A steel nib flexed less then gold.";
    const edited = parse(PARAGRAPH_DOC.replace(NIB_SENTENCE, twoCharacters));

    const result = attach(sidecar, edited);
    expect(result.sidecar.orphans).toEqual([]);
    expect(result.sidecar.rewrites[0].anchor.text).toBe(twoCharacters);
    expect(result.sidecar.rewrites[0].variants[0].text).toBe("A steel nib gives less than gold.");
    expect(result.resolutions[0].step).toBe(4);
    expect(result.resolutions[0].score).toBeGreaterThanOrEqual(DICE_THRESHOLD);
  });

  it("orphans after a complete rewrite, keeping the text it was written against", () => {
    const { sidecar } = start();
    const rewritten = parse(
      PARAGRAPH_DOC.replace(NIB_SENTENCE, "Cartridges are convenient when travelling."),
    );

    const result = attach(sidecar, rewritten);
    expect(result.sidecar.rewrites).toEqual([]);
    expect(result.sidecar.orphans).toHaveLength(1);
    expect(result.sidecar.orphans[0].list).toBe("rewrites");
    expect(result.sidecar.orphans[0].entry.anchor.text).toBe(NIB_SENTENCE);
    expect(result.resolutions[0].step).toBe(5);
    expect(
      sorensenDice(NIB_SENTENCE, "Cartridges are convenient when travelling."),
    ).toBeLessThan(DICE_THRESHOLD);
  });

  it("leaves an existing orphan alone rather than re-attaching it behind the user's back", () => {
    const { root, sidecar } = start();
    const orphaned = attach(sidecar, parse(PARAGRAPH_DOC.replace(NIB_SENTENCE, "Quite else."))).sidecar;
    expect(orphaned.orphans).toHaveLength(1);

    const back = attach(orphaned, root);
    expect(back.sidecar.rewrites).toEqual([]);
    expect(back.sidecar.orphans).toHaveLength(1);
  });

  it("refresh is attach's sidecar, and it moves pos when the document moved", () => {
    const { sidecar } = start();
    const moved = parse(`## Preface\n\nA new opening paragraph.\n\n${PARAGRAPH_DOC}`);
    expect(sidecar.rewrites[0].anchor.pos[0]).toBe(1);

    const refreshed = refresh(sidecar, moved);
    expect(refreshed).toEqual(attach(sidecar, moved).sidecar);
    expect(refreshed.rewrites[0].anchor.pos[0]).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// the duplicate limit, stated plainly (§6.2)
// ---------------------------------------------------------------------------

describe("two byte-identical sentences", () => {
  const start = (): DocumentState => {
    const root = parse(TWIN_SENTENCE_DOC);
    const twins = candidatesOf(root).filter(
      (one) => one.kind === "sentence" && one.text === TWIN_SENTENCE,
    );
    return {
      root,
      sidecar: parseSidecar({
        version: 1,
        rewrites: [
          {
            anchor: twins[0],
            variants: [{ text: "first variant", createdAt: AT }],
          },
          {
            anchor: twins[1],
            variants: [{ text: "second variant", createdAt: AT }],
          },
        ],
      }),
    };
  };

  it("are marked as duplicates so the sidebar can badge them", () => {
    const { root, sidecar } = start();
    expect(attach(sidecar, root).resolutions.map((one) => one.duplicate)).toEqual([true, true]);
  });

  it("an in-app reorder moves each variant with its logical sentence", () => {
    const { root, sidecar } = start();
    const at = sidecar.rewrites[0].anchor.pos[0];
    expect(variantAt(sidecar, [at, 0])).toBe("first variant");
    expect(variantAt(sidecar, [at, 1])).toBe("second variant");

    const next = applyReorderSentences({ root, sidecar }, paragraphId(root), [1, 0, 2]);

    // The Markdown records nothing: the two sentences are byte-identical, so the file is unchanged.
    expect(format(next.root)).toBe(format(root));
    // The sidecar is what carries the identity, and it swapped.
    expect(variantAt(next.sidecar, [at, 0])).toBe("second variant");
    expect(variantAt(next.sidecar, [at, 1])).toBe("first variant");
    expect(next.sidecar.orphans).toEqual([]);
    // …and a re-attach of the moved sidecar keeps it there.
    expect(variantAt(attach(next.sidecar, next.root).sidecar, [at, 0])).toBe("second variant");
  });

  it("an external swap of the same two sentences leaves each variant at its recorded position", () => {
    const { root, sidecar } = start();
    const at = sidecar.rewrites[0].anchor.pos[0];

    // Something that is not this app swapped them and saved; the sidecar was not told.
    const externallyEdited = reorderSentences(root, paragraphId(root), [1, 0, 2]);
    const reparsed = parse(format(externallyEdited));
    expect(format(reparsed)).toBe(format(root));

    const result = attach(sidecar, reparsed);
    expect(variantAt(result.sidecar, [at, 0])).toBe("first variant");
    expect(variantAt(result.sidecar, [at, 1])).toBe("second variant");
    expect(result.resolutions.map((one) => one.step)).toEqual([1, 1]);
  });
});

describe("two identical H2 headings", () => {
  const start = (): DocumentState => {
    const root = parse(TWIN_HEADING_DOC);
    const twins = candidatesOf(root).filter((one) => one.kind === "heading");
    expect(twins).toHaveLength(2);
    expect(twins[0].hash).toBe(twins[1].hash);
    return {
      root,
      sidecar: parseSidecar({
        version: 1,
        headings: [
          { anchor: twins[0], question: "What about steel?" },
          { anchor: twins[1], question: "What about gold?" },
        ],
      }),
    };
  };

  it("an in-app Outline move takes each question with its logical heading", () => {
    const { root, sidecar } = start();
    expect(questionAt(sidecar, [0])).toBe("What about steel?");

    const next = applyMoveSection({ root, sidecar }, 1, 0);

    expect(format(next.root)).toBe(format(parse(TWIN_HEADING_DOC_SWAPPED)));
    expect(questionAt(next.sidecar, [0])).toBe("What about gold?");
    expect(questionAt(next.sidecar, [2])).toBe("What about steel?");
    expect(next.sidecar.orphans).toEqual([]);
  });

  it("an external swap of the same two sections leaves each question at its recorded position", () => {
    const { sidecar } = start();
    const externallyEdited = parse(TWIN_HEADING_DOC_SWAPPED);

    const result = attach(sidecar, externallyEdited);
    // The headings are byte-identical, so the file carries no evidence of which one moved.
    expect(questionAt(result.sidecar, [0])).toBe("What about steel?");
    expect(questionAt(result.sidecar, [2])).toBe("What about gold?");
    expect(result.resolutions.map((one) => one.step)).toEqual([1, 1]);
    expect(result.resolutions.map((one) => one.duplicate)).toEqual([true, true]);
  });

  it("carries the anchors inside a moved section with it", () => {
    const root = parse(TWIN_HEADING_DOC);
    const paragraphs = candidatesOf(root).filter((one) => one.kind === "paragraph");
    const sidecar = parseSidecar({
      version: 1,
      coach: [
        {
          anchor: paragraphs[1],
          scope: "paragraph",
          question: "Why does spring matter?",
          askedAt: AT,
        },
      ],
    });
    expect(sidecar.coach[0].anchor.pos).toEqual([3]);

    const next = applyMoveSection({ root, sidecar }, 1, 0);
    expect(next.sidecar.coach[0].anchor.pos).toEqual([1]);
    expect(next.sidecar.coach[0].anchor.text).toBe("Gold nibs have some spring.");
  });
});

// ---------------------------------------------------------------------------
// front matter (§6.1)
// ---------------------------------------------------------------------------

const withFrontMatter = (...lines: string[]): Root =>
  parse(["---", ...lines, "---", "", "## Nibs", "", "Steel nibs are stiff.", ""].join("\n"));

describe("readFrontMatter", () => {
  it("reads a plain scalar, a single-quoted one and a double-quoted one with comments", () => {
    const root = withFrontMatter(
      "title: The Fountain Pen",
      "question: 'What should wrap the editor?' # asked in March",
      "author: \"M. Savage\"",
    );
    const front = readFrontMatter(root);
    expect(front.present).toBe(true);
    expect(front.malformed).toBe(false);
    expect(front.title).toMatchObject({
      writable: true,
      value: "The Fountain Pen",
      quote: "",
      comment: "",
      line: 0,
    });
    expect(front.question).toMatchObject({
      writable: true,
      value: "What should wrap the editor?",
      quote: "'",
      comment: " # asked in March",
      line: 1,
    });
  });

  it("resolves the escapes of both quoting styles", () => {
    const front = readFrontMatter(
      withFrontMatter("title: 'It''s here'", 'question: "A \\"quoted\\" one"'),
    );
    expect((front.title as FrontMatterField).value).toBe("It's here");
    expect((front.question as FrontMatterField).value).toBe('A "quoted" one');
  });

  it("reports a missing key as null and a document with no front matter as absent", () => {
    const front = readFrontMatter(withFrontMatter("title: A Title"));
    expect(front.question).toBeNull();

    const bare = readFrontMatter(parse("## Nibs\n"));
    expect(bare).toMatchObject({ present: false, title: null, question: null });
  });

  it.each([
    ["block-scalar", ["question: |", "  What should wrap the editor?"]],
    ["block-scalar", ["question: >-", "  What should wrap"]],
    ["flow", ["question: [one, two]"]],
    ["indicator", ["question: &anchored yes"]],
    ["multi-line", ["question: What should", "  wrap the editor?"]],
    ["duplicate", ["question: One?", "question: Two?"]],
    ["malformed", ["question: Fine?", "this line is not a mapping"]],
  ])("marks a %s app-owned key read-only", (reason, lines) => {
    const front = readFrontMatter(withFrontMatter(...lines));
    expect(front.question).toMatchObject({ writable: false, reason });
  });

  it("marks an unterminated quoted scalar read-only rather than guessing", () => {
    expect(readFrontMatter(withFrontMatter("question: 'unterminated"))).toMatchObject({
      question: { writable: false, reason: "multi-line" },
    });
    expect(readFrontMatter(withFrontMatter("question: 'closed' junk"))).toMatchObject({
      question: { writable: false, reason: "malformed" },
    });
  });

  it("ignores an app-owned key that is not top level", () => {
    const front = readFrontMatter(withFrontMatter("meta:", "  question: nested?"));
    expect(front.question).toBeNull();
  });
});

describe("writeFrontMatter", () => {
  it("leaves the block byte-identical when the topic question did not change", () => {
    const root = withFrontMatter("title: The Fountain Pen", "question: What should wrap the editor?");
    const before = yamlOf(root);

    const write = writeFrontMatter(root, { question: "What should wrap the editor?" });
    expect(write).toMatchObject({ ok: true, changed: [] });
    expect(write.root).toBe(root);
    expect(yamlOf(write.root)).toBe(before);
    expect(format(write.root)).toBe(format(root));
  });

  it("rewrites only the question line when it changed in-app", () => {
    const root = withFrontMatter(
      "title: The Fountain Pen",
      "# a standalone comment",
      "question: What should wrap the editor?",
      "tags: [pens, tools]",
    );
    const write = writeFrontMatter(root, { question: "What should hold the ink?" });
    expect(write.ok).toBe(true);

    const before = yamlOf(root).split("\n");
    const after = yamlOf(write.root).split("\n");
    expect(after).toHaveLength(before.length);
    const differing = after.filter((line, index) => line !== before[index]);
    expect(differing).toEqual(["question: What should hold the ink?"]);
  });

  it("preserves quoting style and the inline comment", () => {
    const root = withFrontMatter("question: 'What should wrap the editor?' # asked in March");
    const write = writeFrontMatter(root, { question: "What should hold the ink?" });
    expect(yamlOf(write.root)).toBe("question: 'What should hold the ink?' # asked in March");

    const doubled = withFrontMatter('question: "What now?"   # spaced');
    expect(yamlOf(writeFrontMatter(doubled, { question: "What next?" }).root)).toBe(
      'question: "What next?"   # spaced',
    );
  });

  it("escapes inside the quoting style it found", () => {
    const single = withFrontMatter("question: 'plain'");
    expect(yamlOf(writeFrontMatter(single, { question: "it's here" }).root)).toBe(
      "question: 'it''s here'",
    );
    const double = withFrontMatter('question: "plain"');
    expect(yamlOf(writeFrontMatter(double, { question: 'a "quoted" one' }).root)).toBe(
      'question: "a \\"quoted\\" one"',
    );
  });

  it("promotes a plain scalar to double quotes only when the value needs it", () => {
    const root = withFrontMatter("question: plain");
    expect(yamlOf(writeFrontMatter(root, { question: "still plain" }).root)).toBe(
      "question: still plain",
    );
    expect(yamlOf(writeFrontMatter(root, { question: "one: two" }).root)).toBe(
      'question: "one: two"',
    );
    expect(yamlOf(writeFrontMatter(root, { question: "" }).root)).toBe('question: ""');
    expect(yamlOf(writeFrontMatter(root, { question: "trailing " }).root)).toBe(
      'question: "trailing "',
    );
    expect(yamlOf(writeFrontMatter(root, { question: "hash # here" }).root)).toBe(
      'question: "hash # here"',
    );
  });

  it("writes both app-owned keys and reports exactly which ones changed", () => {
    const root = withFrontMatter("title: Old", "question: Same?");
    const write = writeFrontMatter(root, { title: "New", question: "Same?" });
    expect(write).toMatchObject({ ok: true, changed: ["title"] });
    expect(yamlOf(write.root)).toBe("title: New\nquestion: Same?");
  });

  it("appends a key the block does not carry yet", () => {
    const root = withFrontMatter("title: The Fountain Pen");
    const write = writeFrontMatter(root, { question: "What should wrap the editor?" });
    expect(yamlOf(write.root)).toBe(
      "title: The Fountain Pen\nquestion: What should wrap the editor?",
    );
  });

  it("supplies the separating space for a bare key line", () => {
    const root = withFrontMatter("question:");
    expect(yamlOf(writeFrontMatter(root, { question: "What now?" }).root)).toBe(
      "question: What now?",
    );
  });

  it.each([
    ["block-scalar", ["question: |", "  What should wrap the editor?"]],
    ["flow", ["question: {a: 1}"]],
    ["duplicate", ["question: One?", "question: Two?"]],
    ["malformed", ["question: Fine?", "this line is not a mapping"]],
  ])("returns FrontMatterUnsupported (%s) and leaves the block byte-identical", (reason, lines) => {
    const root = withFrontMatter(...lines);
    const before = yamlOf(root);

    const write = writeFrontMatter(root, { question: "Something else?" });
    expect(write).toMatchObject({
      ok: false,
      error: FRONT_MATTER_UNSUPPORTED,
      key: "question",
      reason,
    });
    expect(write.root).toBe(root);
    expect(yamlOf(write.root)).toBe(before);
    expect(format(write.root)).toBe(format(root));
  });

  it("refuses to invent a front-matter block for a document that has none", () => {
    const root = parse("## Nibs\n\nSteel nibs are stiff.\n");
    const write = writeFrontMatter(root, { question: "What now?" });
    expect(write).toMatchObject({
      ok: false,
      error: FRONT_MATTER_UNSUPPORTED,
      reason: "no-front-matter",
    });
    expect(format(write.root)).toBe(format(root));
  });

  it("writes nothing when asked for nothing", () => {
    const root = withFrontMatter("question: What now?");
    expect(writeFrontMatter(root, {})).toEqual({ ok: true, root, changed: [] });
  });

  it("refuses every requested key when one of them is unsupported", () => {
    const root = withFrontMatter("title: Fine", "question: |", "  block");
    const write = writeFrontMatter(root, { title: "Changed", question: "Changed?" });
    expect(write.ok).toBe(false);
    expect(yamlOf(write.root)).toBe("title: Fine\nquestion: |\n  block");
  });
});

describe("the front-matter mirror (§6.2)", () => {
  it("round-trips `question:` into topicQuestion", () => {
    const root = withFrontMatter(
      "title: The Fountain Pen",
      "question: What should wrap the editor?",
    );
    const mirrored = mirrorFrontMatter(emptySidecar(), root);
    expect(mirrored.topicQuestion).toBe("What should wrap the editor?");
    expect(mirrored.title).toBe("The Fountain Pen");

    // …and back out again, byte-for-byte, when the app writes it.
    const write = writeFrontMatter(root, { question: mirrored.topicQuestion as string });
    expect(write.root).toBe(root);
  });

  it("lets the sidecar win on conflict", () => {
    const root = withFrontMatter("title: From Front Matter", "question: From front matter?");
    const sidecar: Sidecar = {
      ...emptySidecar(),
      title: "From the sidecar",
      topicQuestion: "From the sidecar?",
    };
    expect(mirrorFrontMatter(sidecar, root)).toMatchObject({
      title: "From the sidecar",
      topicQuestion: "From the sidecar?",
    });
  });

  it("does not mirror a value it could not write back", () => {
    const root = withFrontMatter("question: |", "  a block scalar");
    expect(mirrorFrontMatter(emptySidecar(), root).topicQuestion).toBeNull();
  });

  it("mirrors on attach and never writes to the document on open", () => {
    const root = withFrontMatter("question: What should wrap the editor?");
    const result = attach(emptySidecar(), root);
    expect(result.sidecar.topicQuestion).toBe("What should wrap the editor?");
    expect(format(root)).toBe(format(parse(format(root))));
    expect(yamlOf(root)).toBe("question: What should wrap the editor?");
  });
});

// ---------------------------------------------------------------------------
// edges the acceptance implies but does not spell out
// ---------------------------------------------------------------------------

describe("resolution edges", () => {
  it("breaks a step-3 tie on the lowest index", () => {
    const root = parse(["Alpha. Beta.", "", "Gamma.", "", "Alpha. Delta.", ""].join("\n"));
    const alphas = candidatesOf(root).filter(
      (one) => one.kind === "sentence" && one.text === "Alpha.",
    );
    expect(alphas.map((one) => one.pos)).toEqual([
      [0, 0],
      [2, 0],
    ]);
    // Exactly one block away from each of them.
    const resolution = resolveAnchor(
      { ...anchorFor(root, "sentence", (text) => text === "Alpha."), occurrence: 9, pos: [1, 0] },
      root,
    );
    expect(resolution?.step).toBe(3);
    expect(resolution?.anchor.pos).toEqual([0, 0]);
  });

  it("picks the highest step-4 score, not the first one over the line", () => {
    const original = "The quick brown fox jumps over the lazy dog.";
    const root = parse(`## Foxes\n\n${original}\n`);
    const anchor = anchorFor(root, "sentence", (text) => text === original);

    const edited = parse(
      [
        "## Foxes",
        "",
        "The quick brown fox jumps over the lazy cat.",
        "",
        "The quick brown fox jumps over the lazy dogs.",
        "",
      ].join("\n"),
    );
    const resolution = resolveAnchor(anchor, edited);
    expect(resolution?.step).toBe(4);
    expect(resolution?.anchor.text).toBe("The quick brown fox jumps over the lazy dogs.");
    expect(resolution?.score).toBeGreaterThan(
      sorensenDice(original, "The quick brown fox jumps over the lazy cat."),
    );
  });
});

describe("in-app operations orphan an anchor they cannot place", () => {
  const stale = (root: Root, pos: number[]): Sidecar =>
    parseSidecar({
      version: 1,
      rewrites: [
        {
          anchor: { ...anchorFor(root, "sentence", (text) => text === TWIN_SENTENCE), pos },
          variants: [{ text: "stranded", createdAt: AT }],
        },
      ],
    });

  it("orphans a sentence anchor whose remembered index the reorder does not cover", () => {
    const root = parse(TWIN_SENTENCE_DOC);
    const next = applyReorderSentences(
      { root, sidecar: stale(root, [1, 7]) },
      paragraphId(root),
      [1, 0, 2],
    );
    expect(next.sidecar.rewrites).toEqual([]);
    expect(next.sidecar.orphans).toHaveLength(1);
    expect(next.sidecar.orphans[0].entry.variants[0].text).toBe("stranded");
  });

  it("orphans an anchor whose remembered block the move does not cover", () => {
    const root = parse(TWIN_HEADING_DOC);
    const sidecar = parseSidecar({
      version: 1,
      headings: [
        { anchor: { ...anchorFor(root, "heading", () => true), pos: [9] }, question: "Where?" },
      ],
    });
    const next = applyMoveSection({ root, sidecar }, 1, 0);
    expect(next.sidecar.headings).toEqual([]);
    expect(next.sidecar.orphans[0].list).toBe("headings");
  });
});

describe("front-matter edges", () => {
  it("keeps the comment of a plain scalar and the spaces before it", () => {
    const root = withFrontMatter("question: What now?   # asked in March");
    expect(readFrontMatter(root).question).toMatchObject({
      value: "What now?",
      quote: "",
      comment: "   # asked in March",
    });
    expect(yamlOf(writeFrontMatter(root, { question: "What next?" }).root)).toBe(
      "question: What next?   # asked in March",
    );
  });

  it("keeps extra spaces between the colon and the scalar", () => {
    const root = withFrontMatter("question:    spaced out");
    expect(yamlOf(writeFrontMatter(root, { question: "still spaced" }).root)).toBe(
      "question:    still spaced",
    );
  });

  it("carries an unknown double-quote escape through unchanged and refuses a dangling one", () => {
    expect(readFrontMatter(withFrontMatter('question: "a \\z b"')).question).toMatchObject({
      value: "a z b",
    });
    expect(readFrontMatter(withFrontMatter('question: "dangling \\')).question).toMatchObject({
      writable: false,
      reason: "multi-line",
    });
  });

  it("treats a block that opens with an indented line as malformed", () => {
    const front = readFrontMatter(withFrontMatter("  stray: value", "question: What now?"));
    expect(front.malformed).toBe(true);
    expect(front.question).toMatchObject({ writable: false, reason: "malformed" });
  });

  it("refuses to append into a malformed block", () => {
    const root = withFrontMatter("title: Fine", "this line is not a mapping");
    const write = writeFrontMatter(root, { question: "What now?" });
    expect(write).toMatchObject({
      ok: false,
      error: FRONT_MATTER_UNSUPPORTED,
      key: "question",
      reason: "malformed",
    });
  });

  it("writes into an empty front-matter block", () => {
    const root = parse("---\n---\n\n## Nibs\n\nSteel nibs are stiff.\n");
    expect(yamlOf(root)).toBe("");
    expect(yamlOf(writeFrontMatter(root, { question: "What now?" }).root)).toBe(
      "question: What now?",
    );
  });

  it("quotes a value that carries a newline", () => {
    const root = withFrontMatter("question: plain");
    expect(yamlOf(writeFrontMatter(root, { question: "one\ntwo" }).root)).toBe(
      'question: "one\\ntwo"',
    );
  });
});
