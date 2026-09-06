import type { Heading, ListItem, Nodes, Root, RootContent, TableRow } from "mdast";
import { contentHash } from "./hash.js";

/**
 * A **Block** (PRD §6.1) is any direct child of `root`, plus each `listItem` and each `tableRow`
 * anywhere in the tree. Those three shapes are the only nodes that carry a contentId.
 */
export type BlockNode = RootContent | ListItem | TableRow;

/** A block together with the identity it is anchored by (§6.1, §6.2). */
export interface Block {
  /** The node itself — identity-equal to the node inside the `root` that was passed in. */
  readonly node: BlockNode;
  /** Child indices from `root` down to the node, so the same block can be found in a copy. */
  readonly path: readonly number[];
  /** The normalized plain text the hash is taken over. */
  readonly text: string;
  /** `fnv1a64(text)` as 13-char base-36. */
  readonly hash: string;
  /** 0-based ordinal among blocks with the same hash, in document order. */
  readonly occurrence: number;
  /** `hash + '-' + occurrence`. Never written into the Markdown; recomputed on every parse. */
  readonly contentId: string;
}

/** A **Section** (§6.1): a heading and every block up to the next heading of equal or shallower depth. */
export interface Section {
  /** The heading node that opens the section. */
  readonly heading: Heading;
  /** `heading.depth`, repeated here because it is what the section boundary is computed from. */
  readonly depth: number;
  /** Index of the heading in `root.children`. */
  readonly start: number;
  /** Index in `root.children` one past the section's last node. */
  readonly end: number;
  /** `root.children.slice(start, end)` — the heading and everything it owns. */
  readonly nodes: readonly RootContent[];
}

/**
 * The plain text of a node, before normalization: `text`/`inlineCode`/`code`/`html`/`yaml` give
 * their raw value, an `image` gives its alt text, a `break` gives a space, and anything else is the
 * concatenation of its children (nodes without children, such as `thematicBreak`, give nothing).
 */
function rawText(node: Nodes): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
    case "code":
    case "html":
    case "yaml":
      return node.value;
    case "image":
      return node.alt ?? "";
    case "break":
      return " ";
    default:
      return "children" in node ? node.children.map(rawText).join("") : "";
  }
}

/**
 * The text a block's contentId is taken over: its plain text with every run of whitespace collapsed
 * to a single space, trimmed, and NFC-normalized. Collapsing is what makes the id survive a
 * re-wrap or a re-indent of the same prose, which is the point of anchoring (§6.2).
 */
export function normalizedText(node: Nodes): string {
  return rawText(node).replace(/\s+/gu, " ").trim().normalize("NFC");
}

/**
 * Every block of the document in document order, each with its contentId (§6.1). Blocks are
 * collected pre-order, so the occurrence ordinals count duplicates in reading order.
 *
 * Pure: the returned blocks point at the caller's nodes and nothing is mutated.
 */
export function blocksOf(root: Root): Block[] {
  const found: { node: BlockNode; path: number[] }[] = [];

  const visit = (node: Nodes, path: number[], isRootChild: boolean): void => {
    if (isRootChild || node.type === "listItem" || node.type === "tableRow") {
      found.push({ node: node as BlockNode, path });
    }
    if (!("children" in node)) return;
    node.children.forEach((child, index) => visit(child, [...path, index], false));
  };

  root.children.forEach((child, index) => visit(child, [index], true));

  const seen = new Map<string, number>();
  return found.map(({ node, path }) => {
    const text = normalizedText(node);
    const hash = contentHash(text);
    const occurrence = seen.get(hash) ?? 0;
    seen.set(hash, occurrence + 1);
    return { node, path, text, hash, occurrence, contentId: `${hash}-${occurrence}` };
  });
}

/**
 * Every section of the document in document order (§6.1). Sections nest: an H2 section's `nodes`
 * contain the H3 sections that follow it, and both appear in this list.
 *
 * Pure: the returned sections point at the caller's nodes and nothing is mutated.
 */
export function sectionsOf(root: Root): Section[] {
  const sections: Section[] = [];

  root.children.forEach((node, index) => {
    if (node.type !== "heading") return;
    let end = root.children.length;
    for (let i = index + 1; i < root.children.length; i += 1) {
      const candidate = root.children[i];
      if (candidate.type === "heading" && candidate.depth <= node.depth) {
        end = i;
        break;
      }
    }
    sections.push({
      heading: node,
      depth: node.depth,
      start: index,
      end,
      nodes: root.children.slice(index, end),
    });
  });

  return sections;
}

function assertIndex(operation: string, name: string, value: number, length: number): void {
  if (!Number.isInteger(value) || value < 0 || value >= length) {
    throw new RangeError(`${operation}: ${name} ${value} is outside 0..${length - 1}`);
  }
}

/** The node that owns the last step of `path`; `root` itself for a top-level block. */
function containerOf(root: Root, path: readonly number[]): { children: BlockNode[] } {
  let node: unknown = root;
  for (const index of path.slice(0, -1)) {
    node = (node as { children: unknown[] }).children[index];
  }
  return node as { children: BlockNode[] };
}

/**
 * A copy of `root` with the block identified by `contentId` replaced by `replacement`.
 *
 * A `listItem` and a `tableRow` may only be replaced by the same type, because their parents accept
 * nothing else; every other block may become any other block type.
 *
 * @throws Error if no block carries `contentId`, or if the replacement would break its parent.
 */
export function replaceBlock(root: Root, contentId: string, replacement: BlockNode): Root {
  const block = blocksOf(root).find((candidate) => candidate.contentId === contentId);
  if (block === undefined) {
    throw new Error(`replaceBlock: no block with contentId ${contentId}`);
  }
  const constrained = block.node.type === "listItem" || block.node.type === "tableRow";
  if (constrained && replacement.type !== block.node.type) {
    throw new Error(
      `replaceBlock: a ${block.node.type} can only be replaced by a ${block.node.type}, not a ${replacement.type}`,
    );
  }

  const next = structuredClone(root);
  const container = containerOf(next, block.path);
  container.children[block.path[block.path.length - 1]] = structuredClone(replacement);
  return next;
}

/**
 * A copy of `root` with the top-level block at index `from` moved to index `to`.
 *
 * Indices are positions in `root.children` — the "top-level block index" anchors are refreshed
 * against (§6.2). Nested blocks (`listItem`, `tableRow`) are not addressable here: they cannot
 * legally become children of `root`.
 *
 * @throws RangeError if either index is not an integer inside the document.
 */
export function moveBlock(root: Root, from: number, to: number): Root {
  assertIndex("moveBlock", "from", from, root.children.length);
  assertIndex("moveBlock", "to", to, root.children.length);

  const next = structuredClone(root);
  const [moved] = next.children.splice(from, 1);
  next.children.splice(to, 0, moved);
  return next;
}

/**
 * A copy of `root` with section `from` (its heading and everything it owns, nested subsections
 * included) moved to position `to` in the section order of {@link sectionsOf}.
 *
 * Depths are not touched: dragging a section to a new nesting level is `setHeadingDepth` **and**
 * `moveSection` (§7, Outline), so that each half stays a separate undo-able intent.
 *
 * @throws RangeError if either index is outside the document, or if `to` names a section that lies
 * inside the section being moved (a section cannot be moved into itself).
 */
export function moveSection(root: Root, from: number, to: number): Root {
  const sections = sectionsOf(root);
  assertIndex("moveSection", "from", from, sections.length);
  assertIndex("moveSection", "to", to, sections.length);

  const source = sections[from];
  const target = sections[to];
  if (target.start > source.start && target.start < source.end) {
    throw new RangeError(`moveSection: section ${to} is inside section ${from}`);
  }

  const next = structuredClone(root);
  const moved = next.children.splice(source.start, source.end - source.start);
  // Moving backwards lands the section immediately before the target; moving forwards lands it
  // immediately after, and the target's end index shifts down by whatever was lifted out ahead of it.
  const insertAt = to <= from ? target.start : target.end - moved.length;
  next.children.splice(insertAt, 0, ...moved);
  return next;
}

/**
 * A copy of `root` with section `sectionIndex`'s heading set to `depth` and every heading it owns
 * re-depthed by the same delta, so the shape of the subtree is preserved: an H2 with H3 children
 * set to 3 becomes an H3 with H4 children.
 *
 * @throws RangeError if `sectionIndex` is outside the document, if `depth` is not an integer in
 * 1–6, or if the shift would push a descendant heading past depth 6.
 */
export function setHeadingDepth(root: Root, sectionIndex: number, depth: number): Root {
  const sections = sectionsOf(root);
  assertIndex("setHeadingDepth", "section", sectionIndex, sections.length);
  if (!Number.isInteger(depth) || depth < 1 || depth > 6) {
    throw new RangeError(`setHeadingDepth: depth ${depth} is outside the 1..6 range of PRD §6.1`);
  }

  const section = sections[sectionIndex];
  const delta = depth - section.depth;

  // Every heading inside a section is deeper than the section's own heading, so a shift can only
  // ever run off the bottom of the 1..6 range, never off the top.
  const headings: number[] = [];
  for (let i = section.start; i < section.end; i += 1) {
    const node = root.children[i];
    if (node.type === "heading") headings.push(i);
  }
  for (const i of headings) {
    const shifted = (root.children[i] as Heading).depth + delta;
    if (shifted > 6) {
      throw new RangeError(
        `setHeadingDepth: shifting section ${sectionIndex} by ${delta} would put a heading at depth ${shifted}`,
      );
    }
  }

  const next = structuredClone(root);
  for (const i of headings) {
    const heading = next.children[i] as Heading;
    heading.depth = (heading.depth + delta) as Heading["depth"];
  }
  return next;
}
