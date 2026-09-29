import type { Definition, Image, Link, Nodes, Root } from "mdast";
import { parse } from "./parse.js";

type Destination = Image | Link | Definition;

/** The node kinds whose `url` is a destination a rename must follow. */
const DESTINATION_TYPES = new Set(["image", "link", "definition"]);

/** Every node in pre-order, so a clone walked the same way lines up index for index. */
function preorder(node: Nodes, out: Nodes[] = []): Nodes[] {
  out.push(node);
  if ("children" in node) for (const child of node.children) preorder(child, out);
  return out;
}

/** The tree with every `position` dropped: what two parses of equivalent sources agree on. */
function shape(tree: Root): string {
  return JSON.stringify(tree, (key, value: unknown) => (key === "position" ? undefined : value));
}

/**
 * `parse` rewrites CRLF and lone CR to LF before micromark sees the source, so a node's offsets
 * index that normalised string: this is the source offset of normalised offset `offset`, so a
 * splice lands on the author's own bytes.
 */
function sourceOffset(source: string, offset: number): number {
  let at = 0;
  for (let seen = 0; seen < offset; seen += 1) at += source.startsWith("\r\n", at) ? 2 : 1;
  return at;
}

interface Splice {
  readonly at: number;
  readonly length: number;
  readonly bytes: string;
}

/** `source` with every splice (disjoint, in `source`'s own offsets) applied. */
function applySplices(source: string, splices: readonly Splice[]): string {
  let result = source;
  for (const { at, length, bytes } of [...splices].sort((x, y) => y.at - x.at)) {
    result = result.slice(0, at) + bytes + result.slice(at + length);
  }
  return result;
}

/** Every index at which `needle` starts inside `source[from, to)`, ascending. */
function occurrences(source: string, needle: string, from: number, to: number): number[] {
  const found: number[] = [];
  for (let i = source.indexOf(needle, from); i !== -1 && i + needle.length <= to; i = source.indexOf(needle, i + 1)) {
    found.push(i);
  }
  return found;
}

/**
 * Renaming a document `<old>.md` → `<new>.md` moves its `assets/<old>/` directory to
 * `assets/<new>/`; this returns `source` with the `assets/<old>/` prefix of every destination that
 * pointed into the old directory spliced to `assets/<new>/`, and every other byte identical.
 *
 * A destination is the `url` of an `image`, a `link` or a `definition` (the one a reference-style
 * image or link resolves through) that starts with `assets/<old>/` or `./assets/<old>/` in the
 * parser's own terms. Nothing else is a destination — prose, code, `html`, `yaml`, alt text, a
 * title, `../assets/<old>/`, `sub/assets/<old>/` or an absolute URL holding the same bytes are
 * authored literals (PRD §6.1) and stay byte-identical.
 *
 * The prefix is located inside each node's `position` slice and proven, not assumed: a candidate
 * occurrence of `assets/<old>/` is accepted only when
 * re-parsing the source with that one splice yields the original tree with exactly that node's
 * `url` changed, so an occurrence in alt text or a title is never taken. A bare destination the
 * new stem cannot stand in unbracketed (a space) is re-spelled `<…>` whole, under the same proof.
 * A destination spelled some other way (a character reference, an escape or a percent-encoding
 * inside the prefix) has no accepted candidate and is left as written. Each proof re-parses the
 * source with every splice accepted before it, so the returned bytes are the last proven ones.
 */
export function rewriteAssetUrls(source: string, oldStem: string, newStem: string): string {
  if (oldStem === newStem) return source;
  const oldPrefix = `assets/${oldStem}/`;
  const newPrefix = `assets/${newStem}/`;

  const tree = parse(source);
  const nodes = preorder(tree);
  // The tree the accepted splices must parse to: the original with each accepted url moved.
  const expected = structuredClone(tree);
  const expectedNodes = preorder(expected);

  const splices: Splice[] = [];
  nodes.forEach((node, index) => {
    if (!DESTINATION_TYPES.has(node.type)) return;
    const { url } = node as Destination;
    const lead = url.startsWith(oldPrefix) ? "" : url.startsWith(`./${oldPrefix}`) ? "./" : null;
    const { start, end } = node.position ?? {};
    if (lead === null || start?.offset === undefined || end?.offset === undefined) return;
    const from = sourceOffset(source, start.offset);
    const to = sourceOffset(source, end.offset);
    const target = expectedNodes[index] as Destination;
    target.url = `${lead}${newPrefix}${url.slice(lead.length + oldPrefix.length)}`;
    // The proof: every splice accepted so far plus this one parse to the original tree with
    // exactly those urls moved — nothing else changed.
    const want = shape(expected);

    for (const at of occurrences(source, oldPrefix, from, to)) {
      // The prefix alone, then — for a bare destination the new stem cannot stand in (a space,
      // say) — the whole destination re-spelled inside angle brackets.
      const tries: Splice[] = [{ at, length: oldPrefix.length, bytes: newPrefix }];
      const bare = at - lead.length;
      if (source.startsWith(url, bare) && source[bare - 1] !== "<") {
        tries.push({ at: bare, length: url.length, bytes: `<${target.url}>` });
      }
      for (const splice of tries) {
        if (shape(parse(applySplices(source, [...splices, splice]))) === want) {
          splices.push(splice);
          return;
        }
      }
    }
    target.url = url;
  });
  return applySplices(source, splices);
}
