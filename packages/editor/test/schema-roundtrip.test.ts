import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Root, RootContent } from "mdast";
import { describe, expect, it } from "vitest";
import { format } from "../../core/src/format.js";
import { parse } from "../../core/src/parse.js";
import { mdastToPM, pmToMdast } from "../src/schema.js";

/**
 * Task 1.1's acceptance, over the whole corpus: the ProseMirror trip is invisible to the
 * formatter. One `it` per fixture *listed in index.json*, so the matrix grows with the index and
 * never with a literal written here; a second test asserts the index against the directory itself,
 * so the index cannot certify a coverage claim it also defines (docs/lessons.md [0.12.r2d]).
 */

const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));

const index = JSON.parse(readFileSync(`${FIXTURES}/index.json`, "utf8")) as Record<string, unknown>;
const names = Object.keys(index).sort();

function read(name: string): string {
  return readFileSync(`${FIXTURES}/${name}`, "utf8");
}

function trip(root: Root): Root {
  return pmToMdast(mdastToPM(root));
}

function collect(root: Root, type: "html" | "yaml"): string[] {
  const out: string[] = [];
  const walk = (node: RootContent | Root): void => {
    if (node.type === type) out.push(node.value);
    if ("children" in node) for (const child of node.children) walk(child as RootContent);
  };
  walk(root);
  return out;
}

describe("mdast → ProseMirror → mdast over the corpus", () => {
  it("the index lists exactly the fixture sources on disk", () => {
    const sources = readdirSync(FIXTURES)
      .filter((name) => name.endsWith(".md") && !name.endsWith(".canonical.md"))
      .sort();
    expect(names).toEqual(sources);
    expect(names.length).toBeGreaterThan(0);
  });

  // Collects what the loop below actually ran over, so the coverage assertion after it is a claim
  // about the loop's own execution, not `names.length === Object.keys(index).length` — which is
  // `x === x` under a comment claiming it pins the loop, and stays green however many `it`s the
  // loop registers (task 1.21 F9c, DECISIONS #review-1-r0).
  const tripped: string[] = [];

  for (const name of names) {
    it(`${name} formats identically after the trip`, () => {
      tripped.push(name);
      const root = parse(read(name));
      expect(format(trip(root))).toBe(format(root));
    });
  }

  it("asserts one round trip per fixture listed in the index", () => {
    // `tripped` is populated by the `it` bodies above as they run, so this only holds if every
    // fixture the loop iterated actually reached its assertion — deleting a fixture from the loop
    // (leaving the index unchanged) or skipping one of its `it`s fails here.
    expect(tripped.sort()).toEqual(names);
  });
});

describe("opaque nodes survive the trip byte-for-byte", () => {
  const RAW_HTML = "raw-html.md";

  it(`${RAW_HTML}'s html node is byte-identical after the trip`, () => {
    const root = parse(read(RAW_HTML));
    const before = collect(root, "html");
    expect(before.length).toBeGreaterThan(0); // presence: the assertion below is not vacuous
    expect(collect(trip(root), "html")).toEqual(before);
    expect(before[0]).toBe(
      '<div class="note">\n  <p>An HTML aside the app must not touch.</p>\n</div>',
    );
  });

  it("a fixture with no html node has none after the trip", () => {
    const root = parse(read("paragraph-simple.md"));
    expect(collect(root, "html")).toEqual([]);
    expect(collect(trip(root), "html")).toEqual([]);
  });

  it("every front-matter fixture's yaml block is byte-identical after the trip", () => {
    const withYaml = names.filter((name) => collect(parse(read(name)), "yaml").length > 0);
    expect(withYaml.length).toBeGreaterThan(0);
    for (const name of withYaml) {
      const root = parse(read(name));
      expect(collect(trip(root), "yaml")).toEqual(collect(root, "yaml"));
    }
  });
});
