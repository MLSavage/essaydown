import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  fallbackSegment,
  fallbackSentences,
  segmenterSelfTest,
  SEGMENTER_CANARIES,
} from "../src/segment-fallback.js";
import { ABBREVIATIONS, segmentSentences } from "../src/sentences.js";

interface Case {
  id: string;
  rule: string;
  text: string;
  sentences: string[];
}

const casesFile = JSON.parse(
  readFileSync(fileURLToPath(new URL("./sentences.cases.json", import.meta.url)), "utf8"),
) as { _note: string; cases: Case[] };
const cases = casesFile.cases;

/**
 * The cases of sentences.cases.json the rule-based fallback is allowed to get wrong. Task 0.9's
 * acceptance allows three; the fallback needs none, so the list is empty and the assertion below
 * is an equality, not a subset check — if a later change to the rules costs a case, this list is
 * where the loss is recorded (up to three) and the journal is where it is explained.
 */
const ALLOWED_MISSES: readonly string[] = [];

/** Every case, with what the fallback made of it. */
function conformance(): { id: string; expected: string[]; actual: string[]; passed: boolean }[] {
  return cases.map((one) => {
    const actual = fallbackSentences(one.text).map((range) => range.text);
    return {
      id: one.id,
      expected: one.sentences,
      actual,
      passed: JSON.stringify(actual) === JSON.stringify(one.sentences),
    };
  });
}

describe("fallbackSentences against sentences.cases.json", () => {
  it("passes at least 27 of the 30 cases, missing exactly the cases listed as allowed", () => {
    expect(ALLOWED_MISSES.length).toBeLessThanOrEqual(3);

    const results = conformance();
    expect(results).toHaveLength(30);

    const missed = results.filter((result) => !result.passed).map((result) => result.id);
    expect(missed).toEqual([...ALLOWED_MISSES]);
    expect(results.filter((result) => result.passed)).toHaveLength(30 - ALLOWED_MISSES.length);
    expect(results.filter((result) => result.passed).length).toBeGreaterThanOrEqual(27);
  });

  it("reports the sentences of every passing case exactly, not merely the right count", () => {
    for (const result of conformance()) {
      if (ALLOWED_MISSES.includes(result.id)) continue;
      expect(result.actual, result.id).toEqual(result.expected);
    }
  });

  it("agrees with Intl.Segmenter on every case it is allowed to pass", () => {
    // Both segmenters run the same §6.1 post-filter, so this compares the boundary rules only.
    for (const one of cases) {
      if (ALLOWED_MISSES.includes(one.id)) continue;
      const intl = segmentSentences(one.text).map((range) => range.text);
      expect(fallbackSentences(one.text).map((range) => range.text), one.id).toEqual(intl);
    }
  });
});

describe("fallbackSegment", () => {
  it("returns ascending candidate starts beginning at 0", () => {
    for (const one of cases) {
      const starts = [...fallbackSegment(one.text)];
      expect(starts[0], one.id).toBe(0);
      expect(starts, one.id).toEqual([...starts].sort((a, b) => a - b));
      expect(new Set(starts).size, one.id).toBe(starts.length);
      expect(starts.every((start) => start >= 0 && start < Math.max(one.text.length, 1))).toBe(true);
    }
  });

  it("returns [0] for empty and whitespace-only text", () => {
    expect([...fallbackSegment("")]).toEqual([0]);
    expect([...fallbackSegment("   ")]).toEqual([0]);
  });

  it("breaks after each terminal punctuation mark", () => {
    for (const terminator of [".", "!", "?", "…"]) {
      expect(fallbackSentences(`One${terminator} Two.`).map((range) => range.text)).toEqual([
        `One${terminator}`,
        "Two.",
      ]);
    }
  });

  it("breaks after a run of terminal punctuation and after closing quotes and brackets", () => {
    expect(fallbackSentences("Stop!! Now.").map((range) => range.text)).toEqual(["Stop!!", "Now."]);
    for (const closer of ['"', "'", "’", "”", ")", "]", "}"]) {
      expect(
        fallbackSentences(`He said stop.${closer} Then he left.`).map((range) => range.text),
        closer,
      ).toEqual([`He said stop.${closer}`, "Then he left."]);
    }
  });

  it("requires whitespace after the terminator, so a decimal or a URL never breaks", () => {
    expect(fallbackSentences("It cost 3.50 dollars.").map((range) => range.text)).toEqual([
      "It cost 3.50 dollars.",
    ]);
    expect(fallbackSentences("Visit example.com/a.b today.").map((range) => range.text)).toEqual([
      "Visit example.com/a.b today.",
    ]);
  });

  it("requires a capital letter or a digit to open the next sentence", () => {
    expect(fallbackSentences("He waited. then he wrote.").map((range) => range.text)).toEqual([
      "He waited. then he wrote.",
    ]);
    expect(fallbackSentences("He waited. Then he wrote.").map((range) => range.text)).toEqual([
      "He waited.",
      "Then he wrote.",
    ]);
    expect(fallbackSentences("Section one. 2 remains.").map((range) => range.text)).toEqual([
      "Section one.",
      "2 remains.",
    ]);
  });

  it("opens a sentence through a leading quote or bracket", () => {
    expect(fallbackSentences('He left. "The nib is dry."').map((range) => range.text)).toEqual([
      "He left.",
      '"The nib is dry."',
    ]);
  });

  it("uses the §6.1 abbreviation list rather than a second copy of it", () => {
    // Each abbreviation followed by a capital is a candidate boundary the shared post-filter must
    // reject; the same text with an ordinary word in place of the abbreviation does break.
    for (const abbreviation of ABBREVIATIONS) {
      expect(fallbackSentences(`It was ${abbreviation} Halloway who wrote it.`).length, abbreviation)
        .toBe(1);
    }
    expect(fallbackSentences("It was mine. Halloway wrote it.")).toHaveLength(2);
  });

  it("holds initials and joins a run of them", () => {
    expect(fallbackSentences("J. R. R. Tolkien wrote it. He was a don.").map((r) => r.text)).toEqual(
      ["J. R. R. Tolkien wrote it.", "He was a don."],
    );
  });
});

describe("SEGMENTER_CANARIES", () => {
  it("is five cases, each a verbatim copy of the case of the same id in sentences.cases.json", () => {
    expect(SEGMENTER_CANARIES).toHaveLength(5);
    for (const canary of SEGMENTER_CANARIES) {
      const source = cases.find((one) => one.id === canary.id);
      expect(source, canary.id).toBeDefined();
      expect(canary.text, canary.id).toBe(source?.text);
      expect([...canary.sentences], canary.id).toEqual(source?.sentences);
    }
  });

  it("passes under both segmenters, so a runtime that falls back still segments them per §6.1", () => {
    for (const canary of SEGMENTER_CANARIES) {
      expect(segmentSentences(canary.text).map((range) => range.text), canary.id).toEqual([
        ...canary.sentences,
      ]);
      expect(fallbackSentences(canary.text).map((range) => range.text), canary.id).toEqual([
        ...canary.sentences,
      ]);
    }
  });
});

describe("segmenterSelfTest", () => {
  const realSegmenter = Intl.Segmenter;

  /** Put `value` in `Intl.Segmenter` for one test. */
  function stubSegmenter(value: unknown): void {
    (Intl as { Segmenter?: unknown }).Segmenter = value;
  }

  afterEach(() => {
    stubSegmenter(realSegmenter);
  });

  it("returns 'intl' on this runtime, which is Node >= 20 with a working Intl.Segmenter", () => {
    expect(Number(process.versions.node.split(".")[0])).toBeGreaterThanOrEqual(20);
    expect(typeof Intl.Segmenter).toBe("function");
    expect(segmenterSelfTest()).toBe("intl");
  });

  it("returns 'fallback' when Intl.Segmenter is undefined", () => {
    stubSegmenter(undefined);
    expect(segmenterSelfTest()).toBe("fallback");
  });

  it("returns 'fallback' when Intl.Segmenter exists but segments wrongly", () => {
    class EverywhereSegmenter {
      segment(text: string): { index: number; segment: string }[] {
        return [...text].map((character, index) => ({ index, segment: character }));
      }
    }
    stubSegmenter(EverywhereSegmenter);
    expect(segmenterSelfTest()).toBe("fallback");
  });

  it("returns 'fallback' when Intl.Segmenter exists but segments too coarsely", () => {
    class WholeTextSegmenter {
      segment(text: string): { index: number; segment: string }[] {
        return [{ index: 0, segment: text }];
      }
    }
    stubSegmenter(WholeTextSegmenter);
    expect(segmenterSelfTest()).toBe("fallback");
  });

  it("returns 'fallback' when Intl.Segmenter splits the right number of times in the wrong place", () => {
    class OffByThreeSegmenter {
      segment(text: string): { index: number; segment: string }[] {
        const cut = Math.max(1, text.length - 3);
        return [
          { index: 0, segment: text.slice(0, cut) },
          { index: cut, segment: text.slice(cut) },
        ];
      }
    }
    stubSegmenter(OffByThreeSegmenter);
    expect(segmenterSelfTest()).toBe("fallback");
  });

  it("returns 'fallback' when constructing Intl.Segmenter throws", () => {
    class ThrowingSegmenter {
      constructor() {
        throw new Error("no ICU sentence data");
      }
    }
    stubSegmenter(ThrowingSegmenter);
    expect(segmenterSelfTest()).toBe("fallback");
  });

  it("restores 'intl' once the real constructor is back", () => {
    stubSegmenter(undefined);
    expect(segmenterSelfTest()).toBe("fallback");
    stubSegmenter(realSegmenter);
    expect(segmenterSelfTest()).toBe("intl");
  });
});
