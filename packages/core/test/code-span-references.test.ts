import type { Root } from "mdast";
import { describe, expect, it } from "vitest";
import { format } from "../src/format.js";
import { formatWithMap } from "../src/positions.js";
import { parse } from "../src/parse.js";

/*
 * Task 1.57 (DECISIONS #review-1-r7 M1 — Claude finding 1): the literal bytes `&#xD83D;&#xDE00;`
 * inside a verbatim leaf are the author's, not the serializer's. Task 1.49's third `SPLIT_PAIR`
 * form — a high-surrogate reference directly followed by a low-surrogate reference — is pure
 * ASCII, and it was applied to the whole string `containerPhrasing` returns, so it rewrote those
 * bytes to `&#x1F600;` wherever they stood: inside a code span, inside an inline `html` node,
 * inside either of them in a table cell, inside a mark and inside a link's text. Invariant B
 * fails there (the code's value changes) while A holds from the second pass, which is why only a
 * guard that reads the *node's own value* through `parse ∘ format` sees it.
 *
 * One guard per verbatim node class, each carrying the exact bytes the regex matches, and one
 * nested inside a mark and inside a link's text. Each asserts the bytes with `toBe`, the node's
 * value unchanged through `parse(format(·))`, and an empty `unresolved` in `formatWithMap` — the
 * corpus case that says every node of the tree was placed, which is the guard that the per-child
 * walk located every child rather than giving up on one.
 *
 * NOT members, and deliberately absent: a link's destination and a link's title holding those
 * bytes — the parser decodes a lone-surrogate reference there to U+FFFD before the serializer
 * runs, so no tree ever holds them (DECISIONS #review-1-r7, the reconciliation's reading).
 */

/** The first node of `type` under `root`, as the reader of a `value`-bearing leaf needs it. */
function firstValue(root: Root, type: string): string | undefined {
  let found: string | undefined;
  const walk = (node: { type: string; value?: string; children?: unknown[] }): void => {
    if (found === undefined && node.type === type && typeof node.value === "string") {
      found = node.value;
    }
    for (const child of (node.children ?? []) as (typeof node)[]) walk(child);
  };
  walk(root as unknown as { type: string; value?: string; children?: unknown[] });
  return found;
}

/**
 * The three assertions every presence guard makes on one source: the bytes are a fixed point of
 * `parse ∘ format` (`toBe`), the named leaf's own value survives the trip unchanged, and
 * `formatWithMap` leaves nothing unresolved.
 */
function expectVerbatimLeafKept(source: string, type: string, value: string): void {
  const root = parse(source);
  expect(firstValue(root, type)).toBe(value);
  const bytes = format(root);
  expect(bytes).toBe(source);
  expect(firstValue(parse(bytes), type)).toBe(value);
  expect(formatWithMap(root).map.unresolved).toEqual([]);
}

/** The pair, and its two lone twins: the bytes each of `SPLIT_PAIR`'s forms is made of. */
const PAIR = "&#xD83D;&#xDE00;";
const HIGH = "&#xD83D;";
const LOW = "&#xDE00;";

describe("literal surrogate references inside a verbatim leaf (task 1.57, M1): the widening is per child, so the leaf's own bytes are never rewritten", () => {
  describe("presence: one guard per verbatim node class, each holding the literal bytes", () => {
    it(`a code span: \`\`see \\\`${PAIR}\\\` here\`\``, () => {
      expectVerbatimLeafKept(`see \`${PAIR}\` here\n`, "inlineCode", PAIR);
    });

    it(`a code span, the lone twins: \`${HIGH}\` and \`${LOW}\` alone`, () => {
      expectVerbatimLeafKept(`see \`${HIGH}\` here\n`, "inlineCode", HIGH);
      expectVerbatimLeafKept(`see \`${LOW}\` here\n`, "inlineCode", LOW);
      expectVerbatimLeafKept(
        `\`${HIGH}\` alone and \`${LOW}\` alone\n`,
        "inlineCode",
        HIGH,
      );
    });

    it(`an inline html node: \`a <span title="${PAIR}">bb</span> cc\``, () => {
      expectVerbatimLeafKept(
        `a <span title="${PAIR}">bb</span> cc\n`,
        "html",
        `<span title="${PAIR}">`,
      );
    });

    it(`a code span inside an emphasis: \`*ab \\\`${PAIR}\\\` cd* ef\``, () => {
      expectVerbatimLeafKept(`*ab \`${PAIR}\` cd* ef\n`, "inlineCode", PAIR);
    });

    it(`a code span inside a link's text: \`[\\\`${PAIR}\\\` x](u)\``, () => {
      expectVerbatimLeafKept(`[\`${PAIR}\` x](u)\n`, "inlineCode", PAIR);
    });

    it("a table cell holding a code span", () => {
      const cell = `\`${PAIR}\``;
      const source = `| a${" ".repeat(cell.length - 1)} |\n| ${"-".repeat(cell.length)} |\n| ${cell} |\n`;
      expectVerbatimLeafKept(source, "inlineCode", PAIR);
    });
  });

  describe("absence: a text child carrying the same characters is escaped, and no form matches it", () => {
    it("`&amp;#xD83D;&amp;#xDE00;` is written `\\&#xD83D;\\&#xDE00;`, each `&` escaped by `safe()`", () => {
      const root = parse("&amp;#xD83D;&amp;#xDE00;\n");
      expect(firstValue(root, "text")).toBe(PAIR);
      const bytes = format(root);
      expect(bytes).toBe("\\&#xD83D;\\&#xDE00;\n");
      expect(bytes).not.toContain("&#x1F600;");
      expect(firstValue(parse(bytes), "text")).toBe(PAIR);
      expect(format(parse(bytes))).toBe(bytes);
      expect(formatWithMap(root).map.unresolved).toEqual([]);
    });
  });
});
