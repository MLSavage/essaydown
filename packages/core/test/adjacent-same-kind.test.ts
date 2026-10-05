import type {
  Delete,
  Emphasis,
  Nodes,
  Paragraph,
  Parents,
  PhrasingContent,
  Root,
  Strong,
  Text,
} from "mdast";
import { describe, expect, it } from "vitest";
import { format, mergeAdjacentDeletes, type DeleteMerge } from "../src/format.js";
import { parse } from "../src/parse.js";
import { formatWithMap, nodeAt } from "../src/positions.js";

/**
 * Task 3.13 (DECISIONS #review-1-r6 L11 and its `~~` twin, `[1.67, found outside scope]`): two
 * adjacent siblings of one attention kind, from a hand-built tree.
 *
 * At the branch base `emphasis` and `strong` pairs were already fixed points — task 1.67's rule
 * opens the second run with `_`/`__` whenever the bytes before it end in `*` beside an attention
 * sibling, which is the same-mark pair too (`*x.*_y_`) — and `delete` pairs were not
 * (`~~a.~~~~b~~` parses as one `delete` holding `a.~~~~b`). `delete` has one marker and no bytes
 * keep two flush runs apart, so `format` merges them (`mergeAdjacentDeletes`); the guards below are
 * enumerated from that diff: the copy-on-write absence case, the merge at a pair, a chain and at
 * depth, the separator that stops it, the two kinds it leaves alone, the origins it records, and
 * the give-up translation `wideningGiveUps` reads them through. Task 3.18 adds no rebuilt ancestor
 * (a stand-in per parent, the spine dispatched as itself) and the merged-away sibling's position
 * class.
 */

const text = (value: string): Text => ({ type: "text", value });
const paragraph = (...children: PhrasingContent[]): Paragraph => ({ type: "paragraph", children });
const root = (...children: Paragraph[]): Root => ({ type: "root", children });

type Kind = "emphasis" | "strong" | "delete";
const KINDS: readonly Kind[] = ["emphasis", "strong", "delete"];
const newMerge = (): DeleteMerge => ({ standIns: new Map(), origins: new Map() });
const run = (kind: Kind, ...children: PhrasingContent[]): Emphasis | Strong | Delete => ({
  type: kind,
  children,
});

/** The first run's edge-character class: punctuation, letter, astral (a non-BMP symbol and letter). */
const FIRST_RUN_EDGES: ReadonlyArray<readonly [string, string]> = [
  ["punctuation", "a."],
  ["letter", "a"],
  ["astral symbol", "a\u{1F600}"],
  ["astral letter", "a\u{1D400}"],
];

function countNodes(node: Nodes): number {
  return (
    1 + ("children" in node ? node.children.reduce((sum, child) => sum + countNodes(child), 0) : 0)
  );
}

function textOf(node: Nodes): string {
  if ("value" in node) return node.value;
  return "children" in node ? node.children.map(textOf).join("") : "";
}

describe("two adjacent same-kind siblings are a fixed point of parse ∘ format (task 3.13)", () => {
  for (const kind of KINDS) {
    for (const [edge, first] of FIRST_RUN_EDGES) {
      it(`${kind} × first run ending in ${edge}`, () => {
        const tree = root(paragraph(run(kind, text(first)), run(kind, text("b"))));
        const bytes = format(tree);
        const reparsed = parse(bytes);

        expect(format(reparsed)).toBe(bytes);
        expect(textOf(reparsed)).toBe(textOf(tree));
        if (kind === "delete") {
          // One `delete` and one `text` fewer: the merged run, its two texts joined by the parser.
          expect(countNodes(reparsed)).toBe(countNodes(tree) - 2);
          expect(bytes).toBe(`~~${first}b~~\n`);
        } else {
          expect(countNodes(reparsed)).toBe(countNodes(tree));
        }
      });
    }
  }

  it("L11's parser tree `*x.*_y_` is written as it was read", () => {
    expect(format(parse("*x.*_y_\n"))).toBe("*x.*_y_\n");
  });

  it("the `~~` twin no longer writes four flush tildes", () => {
    const tree = root(paragraph(run("delete", text("a.")), run("delete", text("b"))));
    expect(format(tree)).not.toContain("~~~~");
  });
});

describe("mergeAdjacentDeletes: one guard per branch of the diff", () => {
  it("returns the given objects when nothing is adjacent (copy on write, the absence case)", () => {
    const tree = root(
      paragraph(run("delete", text("a")), text(" "), run("delete", text("b"))),
      paragraph(run("emphasis", text("a")), run("emphasis", text("b"))),
    );
    const merge = newMerge();
    expect(mergeAdjacentDeletes(tree, merge)).toBe(tree);
    expect(merge.standIns.size).toBe(0);
    expect(merge.origins.size).toBe(0);
  });

  it("merges a pair into one `delete` in the parent's stand-in, holding both runs' own nodes", () => {
    const a = text("a.");
    const b = text("b");
    const given = paragraph(text("x "), run("delete", a), run("delete", b), text(" y"));
    const tree = root(given);
    const merge = newMerge();
    expect(mergeAdjacentDeletes(tree, merge)).toBe(tree);
    const standIn = merge.standIns.get(given)!;
    expect(standIn.children.map((child) => child.type)).toEqual(["text", "delete", "text"]);
    expect(standIn.children[0]).toBe(given.children[0]);
    expect((standIn.children[1] as Delete).children[0]).toBe(a);
    expect((standIn.children[1] as Delete).children[1]).toBe(b);
    expect(given.children).toHaveLength(4);
  });

  it("rebuilds no ancestor: a merge at depth makes one stand-in, its parent's", () => {
    const strong = run("strong", run("delete", text("a")), run("delete", text("b")));
    const given = paragraph(text("x "), strong);
    const tree = root(given);
    const merge = newMerge();
    expect(mergeAdjacentDeletes(tree, merge)).toBe(tree);
    expect([...merge.standIns.keys()]).toEqual([strong]);
    expect(tree.children[0]).toBe(given);
    expect(given.children[1]).toBe(strong);
  });

  it("merges the joined children of a merged run in their turn", () => {
    const tree = root(
      paragraph(
        run("delete", text("a"), run("delete", text("b"))),
        run("delete", run("delete", text("c")), text("d")),
      ),
    );
    const merge = newMerge();
    mergeAdjacentDeletes(tree, merge);
    const joined = merge.standIns.get(tree.children[0] as Paragraph)!.children[0] as Delete;
    const inner = merge.standIns.get(joined)!;
    expect(inner.children.map((child) => child.type)).toEqual(["text", "delete", "text"]);
    expect(merge.origins.get(inner)).toEqual([
      { parent: (tree.children[0] as Paragraph).children[0], index: 0 },
      { parent: (tree.children[0] as Paragraph).children[0], index: 1 },
      { parent: (tree.children[0] as Paragraph).children[1], index: 1 },
    ]);
  });

  it("merges a chain of three into one", () => {
    const tree = root(
      paragraph(run("delete", text("a")), run("delete", text("b")), run("delete", text("c"))),
    );
    expect(format(tree)).toBe("~~abc~~\n");
  });

  it("merges at depth, inside another mark and inside a link", () => {
    const tree = root(
      paragraph(run("strong", run("delete", text("a")), run("delete", text("b"))), text(" "), {
        type: "link",
        url: "u",
        children: [run("delete", text("c")), run("delete", text("d"))],
      }),
    );
    expect(format(tree)).toBe("**~~ab~~** [~~cd~~](u)\n");
  });

  it("leaves `emphasis` and `strong` pairs as two nodes", () => {
    for (const kind of ["emphasis", "strong"] as const) {
      const tree = root(paragraph(run(kind, text("a")), run(kind, text("b"))));
      const merge = newMerge();
      expect(mergeAdjacentDeletes(tree, merge)).toBe(tree);
      expect(merge.standIns.size).toBe(0);
    }
  });

  it("records each stand-in child's origin in the given tree, across both merged runs", () => {
    const first = run("delete", text("a"), text("b"));
    const second = run("delete", text("c"));
    const given = paragraph(text("x"), first, second, text("y"));
    const merge = newMerge();
    const standIn = mergeAdjacentDeletes(given, merge) as Paragraph;

    expect(merge.origins.get(standIn)).toEqual([
      { parent: given, index: 0 },
      { parent: given, index: 1 },
      { parent: given, index: 3 },
    ]);
    expect(merge.origins.get(standIn.children[1] as Parents)).toEqual([
      { parent: first, index: 0 },
      { parent: first, index: 1 },
      { parent: second, index: 0 },
    ]);
  });
});

describe("the position map over a merged pair (task 3.13, DECISIONS #review-1-r5 K2)", () => {
  it("places both given runs and their texts, and nothing is unresolved", () => {
    const tree = root(paragraph(run("delete", text("a.")), run("delete", text("b"))));
    const { text: bytes, map } = formatWithMap(tree);
    expect(bytes).toBe(format(tree));
    expect(map.unresolved).toEqual([]);
    for (const path of ["0.0", "0.0.0", "0.1", "0.1.0"]) expect(map.ranges[path]).toBeDefined();
    expect(map.ranges["0.0"]!.endCol).toBeLessThanOrEqual(map.ranges["0.1"]!.startCol);
  });

  it("a merged-away sibling's position class: each given `delete` is the hull of its own text", () => {
    // task 3.18 (DECISIONS #053, L3's rule): neither given `delete` is dispatched — the merged run
    // is — so each is placed as the hull of its dispatched descendants, its own text child, and the
    // opening `~~`, which no given node wrote, resolves to the paragraph.
    const tree = root(paragraph(run("delete", text("a.")), run("delete", text("b"))));
    const { map } = formatWithMap(tree);
    expect(map.unresolved).toEqual([]);
    expect(map.ranges["0.0"]).toEqual(map.ranges["0.0.0"]);
    expect(map.ranges["0.1"]).toEqual(map.ranges["0.1.0"]);
    const opening = map.ranges["0"]!;
    for (const column of [opening.startCol, opening.startCol + 1]) {
      expect(nodeAt(map, opening.startLine, column)?.path).toBe("0");
    }
    expect(nodeAt(map, opening.startLine, opening.startCol + 2)?.path).toBe("0.0.0");
  });

  it("reports a widening give-up in a stand-in at the given tree's path", () => {
    // task 1.65's GIVES_UP shape (`<i>a` before a `delete`), behind a merged pair: the give-up is
    // recorded on the paragraph's stand-in at its index 1 and must be reported at the given index 2.
    const tree = root(
      paragraph(
        run("delete", text("x")),
        run("delete", text("y")),
        { type: "html", value: "<i>a" },
        run("delete", text(".b")),
        text(" z"),
      ),
    );
    expect(formatWithMap(tree).map.unresolved).toEqual(["0.2", "0.3", "0.4"]);
  });
});
