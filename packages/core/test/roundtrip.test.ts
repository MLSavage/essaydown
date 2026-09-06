import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Root, RootContent } from "mdast";
import { describe, expect, it } from "vitest";
import { format } from "../src/format.js";
import { parse } from "../src/parse.js";

/**
 * Round-trip invariants of PRD §6.1, asserted on every fixture of fixtures/markdown:
 *
 *   A — idempotence:            format(parse(x)) is a fixed point; formatting it again is a no-op.
 *   B — semantic preservation:  source and canonical parse to the same tree once positions are
 *                               stripped (positions differ legitimately — the canonical file has
 *                               different offsets, and the CRLF fixture different byte offsets
 *                               again — but no other field may move).
 *   C — byte fidelity:          format(parse(source)) is byte-identical to the committed
 *                               `.canonical.md` golden, the opaque set (`html`, `yaml`) survives
 *                               byte-for-byte, and line endings are normalised to LF on parse.
 *
 * One `it` per invariant per fixture, so the file runs 3 × (fixtures in the corpus) tests. The
 * fixture list is read from the directory rather than hardcoded, so a task that grows the corpus
 * grows this matrix with it (docs/lessons.md [0.4], DECISIONS #016).
 */

const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));

/** The one fixture of the corpus written with CRLF line endings (task 0.4). */
const CRLF_FIXTURE = "crlf-line-endings.md";

/** The opaque node types of PRD §6.1: their `value` is source bytes and must never be rewritten. */
const OPAQUE_TYPES = ["html", "yaml"] as const;

interface IndexEntry {
  nodeTypes: string[];
}

const sourceNames = readdirSync(FIXTURES)
  .filter((name) => name.endsWith(".md") && !name.endsWith(".canonical.md"))
  .sort();

const index = JSON.parse(readFileSync(`${FIXTURES}/index.json`, "utf8")) as Record<string, IndexEntry>;

function read(name: string): string {
  return readFileSync(`${FIXTURES}/${name}`, "utf8");
}

function canonicalNameOf(name: string): string {
  return `${name.replace(/\.md$/, "")}.canonical.md`;
}

/** A structural clone with every `position` dropped, for invariant B's comparison. */
function stripPositions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPositions);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (key !== "position") out[key] = stripPositions(inner);
    }
    return out;
  }
  return value;
}

function walk(node: Root | RootContent, visit: (n: RootContent) => void): void {
  const children = (node as { children?: RootContent[] }).children ?? [];
  for (const child of children) {
    visit(child);
    walk(child, visit);
  }
}

/** Every node `value` in the tree, in document order — text, code, html, yaml alike. */
function nodeValues(root: Root): string[] {
  const values: string[] = [];
  walk(root, (node) => {
    const { value } = node as { value?: unknown };
    if (typeof value === "string") values.push(value);
  });
  return values;
}

/** The `value` of every opaque (`html` / `yaml`) node, in document order. */
function opaqueValues(root: Root): string[] {
  const values: string[] = [];
  walk(root, (node) => {
    if ((OPAQUE_TYPES as readonly string[]).includes(node.type)) {
      values.push((node as { value: string }).value);
    }
  });
  return values;
}

describe.each(sourceNames)("round-trip invariants — %s", (name) => {
  const source = read(name);
  const canonical = read(canonicalNameOf(name));

  it("A idempotence: format(parse(x)) is a fixed point", () => {
    const once = format(parse(source));
    const twice = format(parse(once));
    expect(twice).toBe(once);
    // The committed golden is that fixed point, so re-formatting it is also a no-op.
    expect(format(parse(canonical))).toBe(canonical);
  });

  it("B semantic preservation: source and canonical parse to the same position-stripped tree", () => {
    const fromSource = stripPositions(parse(source));
    const fromCanonical = stripPositions(parse(canonical));
    expect(fromSource).toEqual(fromCanonical);
    // Guard against the comparison degenerating to two empty trees.
    expect((fromSource as { children: unknown[] }).children.length).toBeGreaterThan(0);
  });

  it("C byte fidelity: canonical bytes, opaque nodes verbatim, line endings LF", () => {
    const formatted = format(parse(source));
    expect(formatted).toBe(canonical);

    // Opaque set: `html` and `yaml` values reach the tree as source bytes, are unchanged by the
    // round trip, and appear verbatim in the output. `nodeTypes` in index.json says which
    // fixtures are supposed to have them, so the presence and the absence case are both asserted.
    const fromSource = opaqueValues(parse(source));
    const fromCanonical = opaqueValues(parse(canonical));
    const expectsOpaque = OPAQUE_TYPES.some((type) => index[name].nodeTypes.includes(type));
    expect(fromSource.length > 0).toBe(expectsOpaque);
    expect(fromSource).toEqual(fromCanonical);
    for (const value of fromSource) expect(canonical).toContain(value);

    // Line endings: parse() normalises CRLF to LF, so no node value and no formatter output ever
    // carries a CR. `crlf-line-endings.md` is the corpus's CRLF source and every other fixture is
    // not, which is what makes the normalisation assertion below bite on a real CRLF document.
    expect(source.includes("\r\n")).toBe(name === CRLF_FIXTURE);
    for (const value of nodeValues(parse(source))) expect(value).not.toContain("\r");
    expect(formatted).not.toContain("\r");
    expect(canonical).not.toContain("\r");
  });
});
