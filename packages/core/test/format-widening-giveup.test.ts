import type { Nodes, Root } from "mdast";
import { describe, expect, it } from "vitest";
import {
  applyEdits,
  format,
  widenSplitSurrogateReferences,
  wideningGiveUps,
  type Edit,
  type RecordedChild,
  type WideningGiveUp,
} from "../src/format.js";
import { formatWithMap } from "../src/positions.js";

/**
 * The give-up paths of the per-child widening walk (task 1.65, DECISIONS #review-1-r8 N3).
 *
 * `locateChild`'s `return undefined` and `applyEdits`' overlap skip are the two places
 * `format.ts` resolved a surprise by doing less, quietly. Each guard below is enumerated from
 * that diff rather than from the acceptance sentences: the walk's contract at an unlocatable
 * child (presence and absence), the duplicate overlap that is by construction and stays silent,
 * the overlap that is not and is recorded, and the wiring that turns a recorded give-up into an
 * `unresolved` path of `formatWithMap`'s map.
 *
 * The walk is called directly here because no tree the parser can produce reaches its give-up:
 * the branch is covered by a test that asserts the behaviour, not by a mutation alone.
 */

/** 😀 as the parent writes it when it encoded only the child's first UTF-16 unit. */
const HEAD_SPLIT = "&#xD83D;\uDE00";
/** 😀 as the parent writes it when it encoded only the child's last UTF-16 unit. */
const TAIL_SPLIT = "\uD83D&#xDE00;";
/** 😀 as the parent writes it when both rewrites fired on the one two-unit child. */
const BOTH_SPLIT = "&#xD83D;&#xDE00;";
/** The one scalar all three widen to. */
const WIDE = "&#x1F600;";

const text = (value: string): RecordedChild => ({
  node: { type: "text", value } as Nodes,
  value,
});

/** A collector standing in for the recorder `installSurrogateWidening` installs on the `State`. */
function collect(): { giveUps: WideningGiveUp[]; record: (giveUp: WideningGiveUp) => void } {
  const giveUps: WideningGiveUp[] = [];
  return { giveUps, record: (giveUp) => giveUps.push(giveUp) };
}

/** Three children whose middle one the join may or may not spell as its handler returned it. */
const CHILDREN: readonly RecordedChild[] = [
  text("\u{1F600}a"),
  text("ZZZ"),
  text("b\u{1F600}"),
];
const BEFORE = `${HEAD_SPLIT}a`;
const AFTER = `b${TAIL_SPLIT}`;

describe("the widening walk's give-up at a child it cannot locate (task 1.65)", () => {
  it("records the child, leaves it and every later sibling unwidened, and returns the rest of the join unchanged", () => {
    const { giveUps, record } = collect();
    const joined = `${BEFORE}QQQ${AFTER}`;

    const out = widenSplitSurrogateReferences(joined, CHILDREN, record);

    // The give-up itself: the index and the type of the child whose bytes are none of the forms.
    expect(giveUps).toEqual([{ reason: "unlocatable-child", index: 1, type: "text" }]);
    // Presence: the child before the give-up was widened.
    expect(out.startsWith(`${WIDE}a`)).toBe(true);
    // Absence: from the give-up on, the join is returned byte for byte as the parent wrote it —
    // the unlocatable child's own bytes and the later sibling's split pair both untouched.
    expect(out.slice(`${WIDE}a`.length)).toBe(`QQQ${AFTER}`);
    expect(out).toBe(`${WIDE}aQQQ${AFTER}`);
    expect(out).not.toContain(WIDE.repeat(2));
  });

  it("gives up on nothing and widens every child when the join spells them all", () => {
    const { giveUps, record } = collect();
    const joined = `${BEFORE}ZZZ${AFTER}`;

    const out = widenSplitSurrogateReferences(joined, CHILDREN, record);

    expect(giveUps).toEqual([]);
    expect(out).toBe(`${WIDE}aZZZb${WIDE}`);
  });

  it("gives up at the first unlocatable child, so a later one is never reported", () => {
    const { giveUps, record } = collect();
    const joined = `QQQ${AFTER}`;
    const children = [text("\u{1F600}a"), text("b\u{1F600}")];

    const out = widenSplitSurrogateReferences(joined, children, record);

    expect(giveUps).toEqual([{ reason: "unlocatable-child", index: 0, type: "text" }]);
    expect(out).toBe(joined);
  });

  it("locates the eol-as-space form and gives up on nothing, so a `break` before html is repaired", () => {
    const { giveUps, record } = collect();
    // `container-phrasing.js`' fourth region wrote the break's line ending as one space; the form
    // is in the walk's enumeration, so the break is located and `repairBreakBeforeHtml` decides
    // its bytes. Drop that form from `emissionForms` and this child is unlocatable instead.
    const children: RecordedChild[] = [
      { node: { type: "break" } as Nodes, value: "\\\n" },
      { node: { type: "html", value: "<i>x" } as Nodes, value: "<i>x" },
    ];

    const out = widenSplitSurrogateReferences("\\ <i>x", children, record);

    expect(giveUps).toEqual([]);
    expect(out).toBe("\\\n<i>x");
  });

  it("gives up on a non-text child by its own type, not by `text`", () => {
    const { giveUps, record } = collect();
    const child: RecordedChild = {
      node: { type: "html", value: "<i>a" } as Nodes,
      value: "<i>a",
    };
    const joined = "<i>&#x61;";

    expect(widenSplitSurrogateReferences(joined, [child], record)).toBe(joined);
    expect(giveUps).toEqual([{ reason: "unlocatable-child", index: 0, type: "html" }]);
  });
});

describe("the widening walk's overlapping edits (task 1.65)", () => {
  it("drops the duplicate the two anchors of a one-pair slice produce, and records no give-up", () => {
    const { giveUps, record } = collect();
    // Both `SPLIT_PAIR` anchors match this slice: the head at its start, the tail at its end.
    const children = [text("\u{1F600}")];

    const out = widenSplitSurrogateReferences(BOTH_SPLIT, children, record);

    expect(out).toBe(WIDE);
    expect(giveUps).toEqual([]);
  });

  it("records an edit dropped for overlapping one already taken on different bytes", () => {
    const { giveUps, record } = collect();
    const taken: Edit = { start: 0, end: 4, replacement: "X", index: 0, type: "text" };
    const overlapping: Edit = { start: 2, end: 6, replacement: "Y", index: 1, type: "emphasis" };

    const out = applyEdits("abcdefgh", [taken, overlapping], record);

    expect(out).toBe("Xefgh");
    expect(giveUps).toEqual([{ reason: "overlapping-edit", index: 1, type: "emphasis" }]);
  });

  it("records an edit dropped for claiming one slice with other bytes than the one taken", () => {
    const { giveUps, record } = collect();
    const taken: Edit = { start: 0, end: 4, replacement: "X", index: 0, type: "text" };
    const sameSlice: Edit = { start: 0, end: 4, replacement: "Y", index: 0, type: "text" };

    expect(applyEdits("abcdefgh", [taken, sameSlice], record)).toBe("Xefgh");
    expect(giveUps).toEqual([{ reason: "overlapping-edit", index: 0, type: "text" }]);
  });

  it("reads an empty log off a `State` the walk was never installed on", () => {
    // The default `formatWithMap` falls back to for a tree that dispatches no handler at all.
    expect(wideningGiveUps({} as Parameters<typeof wideningGiveUps>[0])).toEqual([]);
  });

  it("writes every edit and records nothing when no two of them overlap", () => {
    const { giveUps, record } = collect();
    const edits: Edit[] = [
      { start: 0, end: 2, replacement: "X", index: 0, type: "text" },
      { start: 4, end: 6, replacement: "Y", index: 1, type: "text" },
    ];

    expect(applyEdits("abcdefgh", edits, record)).toBe("XcdYgh");
    expect(giveUps).toEqual([]);
    expect(applyEdits("abcdefgh", [], record)).toBe("abcdefgh");
  });
});

/**
 * The tree below is hand-built: `parse` never yields an inline `html` node ending in a letter
 * (micromark captures the tag alone, `<i>`, which ends in punctuation), and that letter is what
 * `container-phrasing.js`' third region encodes when the `delete` that follows asks for its
 * neighbour — `<i>a` in, `<i>&#x61;` out. The walk's enumeration offers a non-text child its raw
 * value alone, so this is the shape that reaches `locateChild`'s give-up through the serializer
 * rather than through a direct call.
 */
const GIVES_UP: Root = {
  type: "root",
  children: [
    {
      type: "paragraph",
      children: [
        { type: "html", value: "<i>a" },
        { type: "delete", children: [{ type: "text", value: ".b" }] },
        { type: "text", value: " z" },
      ],
    },
  ],
};

describe("formatWithMap reports the walk's give-up as an unresolved path (task 1.65)", () => {
  it("names the child the walk could not locate and every later sibling of that parent", () => {
    const { map } = formatWithMap(GIVES_UP);

    // The parent is the paragraph at path "0"; the walk gave up at its child 0, so children 0, 1
    // and 2 were all left as the parent wrote them. Children 1 and 2 *are* placed — their ranges
    // are in the map — which is exactly why the give-up has to be reported in its own right.
    expect(map.unresolved).toEqual(["0.0", "0.1", "0.2"]);
    expect(map.ranges["0.1"]).toBeDefined();
    expect(map.ranges["0.2"]).toBeDefined();
    // Each path once: the give-up does not repeat a path an unplaced node already reported.
    expect(new Set(map.unresolved).size).toBe(map.unresolved.length);
  });

  it("keeps `format`'s bytes: the walk stops and nothing after it is widened blind", () => {
    expect(format(GIVES_UP)).toBe("<i>&#x61;~~.b~~ z\n");
    expect(formatWithMap(GIVES_UP).text).toBe(format(GIVES_UP));
  });

  it("reports nothing for a tree of the same shape whose walk locates every child", () => {
    const locatable: Root = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "html", value: "<i>" },
            { type: "delete", children: [{ type: "text", value: ".b" }] },
            { type: "text", value: " z" },
          ],
        },
      ],
    };

    expect(formatWithMap(locatable).map.unresolved).toEqual([]);
  });
});
