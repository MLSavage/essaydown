import type { Root, RootContent, Yaml } from "mdast";
import { z } from "zod";
import { blocksOf, moveSection, normalizedText } from "./blocks.js";
import { CONTENT_ID_LENGTH, contentHash } from "./hash.js";
import { reorderSentences, sentencesOf, type SegmentOptions } from "./sentences.js";

// ---------------------------------------------------------------------------
// Schema (PRD §6.2)
// ---------------------------------------------------------------------------

/** The only sidecar version v1 writes or reads. */
export const SIDECAR_VERSION = 1;

/** The three things an anchor can point at. `paragraph` exists for coach entries (§6.2). */
export const ANCHOR_KINDS = ["heading", "paragraph", "sentence"] as const;
export type AnchorKind = (typeof ANCHOR_KINDS)[number];

/** Coach scopes: `sentence` and `paragraph` only — there is no essay scope in v1 (§6.2, §5). */
export const COACH_SCOPES = ["sentence", "paragraph"] as const;
export type CoachScope = (typeof COACH_SCOPES)[number];

const hashSchema = z.string().length(CONTENT_ID_LENGTH);

/**
 * `{kind, hash, occurrence, text, sectionHash, blockHash?, pos}` (§6.2). `depth` appears on the
 * heading anchor of the §6.2 example and is carried here for every kind that has one; `pos` is
 * required by the prose (the example's heading anchor abbreviates it away) and is the item's last
 * known document position: `[topLevelBlockIndex]`, plus a sentence index for sentences.
 */
export const anchorSchema = z.object({
  kind: z.enum(ANCHOR_KINDS),
  hash: hashSchema,
  occurrence: z.number().int().min(0),
  text: z.string(),
  sectionHash: hashSchema.nullable(),
  blockHash: hashSchema.nullable().default(null),
  depth: z.number().int().min(1).max(6).nullable().default(null),
  pos: z.array(z.number().int().min(0)).min(1),
});
export type Anchor = z.infer<typeof anchorSchema>;

export const variantSchema = z.object({ text: z.string(), createdAt: z.string() });
export type Variant = z.infer<typeof variantSchema>;

export const historyEntrySchema = z.object({ text: z.string(), replacedAt: z.string() });
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

export const headingEntrySchema = z
  .object({ anchor: anchorSchema, question: z.string() })
  .refine((entry) => entry.anchor.kind === "heading", {
    error: "heading entry must carry a heading anchor",
    path: ["anchor", "kind"],
  });
export type HeadingEntry = z.infer<typeof headingEntrySchema>;

export const rewriteEntrySchema = z
  .object({
    anchor: anchorSchema,
    variants: z.array(variantSchema).default([]),
    chosen: z.number().int().min(0).nullable().default(null),
    history: z.array(historyEntrySchema).default([]),
  })
  .refine((entry) => entry.anchor.kind === "sentence", {
    error: "rewrite entry must carry a sentence anchor",
    path: ["anchor", "kind"],
  });
export type RewriteEntry = z.infer<typeof rewriteEntrySchema>;

export const coachEntrySchema = z
  .object({
    anchor: anchorSchema,
    scope: z.enum(COACH_SCOPES),
    question: z.string(),
    askedAt: z.string(),
  })
  .refine((entry) => entry.anchor.kind === entry.scope, {
    error: "coach entry anchor kind must equal its scope",
    path: ["anchor", "kind"],
  });
export type CoachEntry = z.infer<typeof coachEntrySchema>;

/** The three lists an entry can live in, and the tag an orphan records so it can go back. */
export const SIDECAR_LISTS = ["headings", "rewrites", "coach"] as const;
export type SidecarList = (typeof SIDECAR_LISTS)[number];

/**
 * An entry whose anchor no longer resolves (§6.2 step 5). It keeps the anchor it was orphaned
 * with, so the "Unattached" sidebar can show the text the user wrote it against.
 */
export const orphanSchema = z.discriminatedUnion("list", [
  z.object({ list: z.literal("headings"), entry: headingEntrySchema }),
  z.object({ list: z.literal("rewrites"), entry: rewriteEntrySchema }),
  z.object({ list: z.literal("coach"), entry: coachEntrySchema }),
]);
export type Orphan = z.infer<typeof orphanSchema>;

/**
 * The sidecar document (`<name>.essaydown.json`, §6.2).
 *
 * `title` is not in the §6.2 example but is required by its last bullet ("Front-matter
 * `title`/`question` are mirrored") and by this task's text ("front-matter mirror of
 * title/question"); the example abbreviates, the prose is normative.
 */
export const sidecarSchema = z.object({
  version: z.literal(SIDECAR_VERSION, {
    error: (issue) =>
      issue.input === undefined
        ? "sidecar version missing"
        : `sidecar version must be ${SIDECAR_VERSION}`,
  }),
  title: z.string().nullable().default(null),
  topicQuestion: z.string().nullable().default(null),
  headings: z.array(headingEntrySchema).default([]),
  rewrites: z.array(rewriteEntrySchema).default([]),
  coach: z.array(coachEntrySchema).default([]),
  orphans: z.array(orphanSchema).default([]),
});
export type Sidecar = z.infer<typeof sidecarSchema>;

/** Validate a parsed `<name>.essaydown.json`. Throws `z.ZodError`; missing keys take defaults. */
export function parseSidecar(value: unknown): Sidecar {
  return sidecarSchema.parse(value);
}

/** The sidecar a document starts with: version only, every list empty. */
export function emptySidecar(): Sidecar {
  return sidecarSchema.parse({ version: SIDECAR_VERSION });
}

// ---------------------------------------------------------------------------
// Anchor candidates
// ---------------------------------------------------------------------------

/**
 * The §6.1 normalization applied to a bare string: whitespace runs collapsed, trimmed, NFC. Runs
 * through `blocks.ts`'s `normalizedText` so the block ids and the sentence/anchor ids can never
 * drift onto two different rules.
 */
function normalize(text: string): string {
  return normalizedText({ type: "text", value: text });
}

/** Everything an anchor can point at, as the document currently holds it. */
export interface AnchorCandidate {
  readonly kind: AnchorKind;
  readonly hash: string;
  /** 0-based ordinal among candidates of the same kind sharing this hash, in document order. */
  readonly occurrence: number;
  /** Normalized text — what the hash was taken over and what step 4 scores. */
  readonly text: string;
  /** Hash of the nearest enclosing heading, or null at the top level. */
  readonly sectionHash: string | null;
  /** Hash of the enclosing paragraph, for sentences; null otherwise. */
  readonly blockHash: string | null;
  readonly depth: number | null;
  /** `[topLevelBlockIndex]`, plus the sentence index for sentences. */
  readonly pos: readonly number[];
  /** Position in document order among candidates of the same kind — the "index" ties break on. */
  readonly index: number;
}

/**
 * Every anchorable item of the document (§6.2): each top-level heading, each top-level paragraph,
 * and each sentence of each top-level paragraph. Nested paragraphs are deliberately absent — v1
 * addresses sentences only in top-level paragraphs (§6.1 Rewrite/Reorder scope).
 *
 * Occurrence ordinals for headings and paragraphs are the ones `blocksOf` computes (the §6.1
 * contentId ordinal, counted over all blocks); sentences have no §6.1 ordinal, so this counts them
 * over the sentences of the document in reading order.
 *
 * Pure: nothing is mutated, nothing is cached between calls.
 */
export function candidatesOf(root: Root, options: SegmentOptions = {}): AnchorCandidate[] {
  const topLevel = blocksOf(root).filter((block) => block.path.length === 1);

  const headings: AnchorCandidate[] = [];
  const paragraphs: AnchorCandidate[] = [];
  const sentences: AnchorCandidate[] = [];
  const sentenceOccurrences = new Map<string, number>();
  /** Open enclosing headings, shallowest first — the top is the current section. */
  const open: { hash: string; depth: number }[] = [];

  for (const block of topLevel) {
    const at = block.path[0];

    if (block.node.type === "heading") {
      while (open.length > 0 && open[open.length - 1].depth >= block.node.depth) open.pop();
      headings.push({
        kind: "heading",
        hash: block.hash,
        occurrence: block.occurrence,
        text: block.text,
        sectionHash: open.length > 0 ? open[open.length - 1].hash : null,
        blockHash: null,
        depth: block.node.depth,
        pos: [at],
        index: headings.length,
      });
      open.push({ hash: block.hash, depth: block.node.depth });
      continue;
    }

    if (block.node.type !== "paragraph") continue;
    const sectionHash = open.length > 0 ? open[open.length - 1].hash : null;
    paragraphs.push({
      kind: "paragraph",
      hash: block.hash,
      occurrence: block.occurrence,
      text: block.text,
      sectionHash,
      blockHash: null,
      depth: null,
      pos: [at],
      index: paragraphs.length,
    });

    for (const sentence of sentencesOf(block.node, { ...options, blockId: block.contentId })) {
      const text = normalize(sentence.text);
      const hash = contentHash(text);
      const occurrence = sentenceOccurrences.get(hash) ?? 0;
      sentenceOccurrences.set(hash, occurrence + 1);
      sentences.push({
        kind: "sentence",
        hash,
        occurrence,
        text,
        sectionHash,
        blockHash: block.hash,
        depth: null,
        pos: [at, sentence.index],
        index: sentences.length,
      });
    }
  }

  return [...headings, ...paragraphs, ...sentences];
}

/** The anchor a candidate is described by. */
function anchorOf(candidate: AnchorCandidate): Anchor {
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

function samePos(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** The candidate of `kind` sitting at exactly `pos`, or null if the document has nothing there. */
export function candidateAt(
  candidates: readonly AnchorCandidate[],
  kind: AnchorKind,
  pos: readonly number[],
): AnchorCandidate | null {
  return (
    candidates.find((candidate) => candidate.kind === kind && samePos(candidate.pos, pos)) ?? null
  );
}

// ---------------------------------------------------------------------------
// Sørensen–Dice (§6.2 step 4)
// ---------------------------------------------------------------------------

function bigrams(value: string): Map<string, number> {
  const counts = new Map<string, number>();
  const characters = [...value];
  for (let i = 0; i + 1 < characters.length; i += 1) {
    const gram = characters[i] + characters[i + 1];
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

/**
 * Sørensen–Dice similarity of two texts over their character bigrams, in `[0, 1]`.
 *
 * Both sides are put through the §6.1 normalization and then case-folded, because a fuzzy match
 * that a capitalisation change defeats is not fuzzy (the case fold is the extension `blocks.ts`
 * anticipates, not a second normalization rule). Texts shorter than two characters have no
 * bigrams, so they are compared for equality instead.
 */
export function sorensenDice(a: string, b: string): number {
  const left = normalize(a).toLowerCase();
  const right = normalize(b).toLowerCase();
  if ([...left].length < 2 || [...right].length < 2) return left === right ? 1 : 0;

  const leftGrams = bigrams(left);
  const rightGrams = bigrams(right);
  let shared = 0;
  let leftTotal = 0;
  for (const [gram, count] of leftGrams) {
    leftTotal += count;
    shared += Math.min(count, rightGrams.get(gram) ?? 0);
  }
  let rightTotal = 0;
  for (const count of rightGrams.values()) rightTotal += count;
  return (2 * shared) / (leftTotal + rightTotal);
}

// ---------------------------------------------------------------------------
// Resolution (§6.2, five steps)
// ---------------------------------------------------------------------------

/** The similarity step 4 accepts (§6.2: "Sørensen–Dice ≥ 0.8"). */
export const DICE_THRESHOLD = 0.8;

/** Which of the first four §6.2 steps resolved an anchor. Step 5 is the orphan list. */
export type ResolutionStep = 1 | 2 | 3 | 4;

export interface Resolution {
  readonly step: ResolutionStep;
  /** The anchor rebuilt from the document — new hash, occurrence, scope hashes and `pos`. */
  readonly anchor: Anchor;
  /** The step-4 score, null for the exact steps. */
  readonly score: number | null;
  /** Whether more than one candidate of this kind carries the resolved hash (the §6.2 badge). */
  readonly duplicate: boolean;
}

export interface ResolveOptions extends SegmentOptions {
  /** Candidates computed once by the caller; `candidatesOf(root)` when absent. */
  readonly candidates?: readonly AnchorCandidate[];
}

/** Lexicographic |Δ| between two positions, block index first (§6.2 step 3, "nearest to pos"). */
function posDistance(a: readonly number[], b: readonly number[]): number[] {
  const length = Math.max(a.length, b.length);
  const distance: number[] = [];
  for (let i = 0; i < length; i += 1) distance.push(Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  return distance;
}

function distanceIsLess(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right;
  }
  return false;
}

/**
 * Resolve one anchor against a document, in the five-step order of §6.2:
 *
 * 1. exact `hash` + `occurrence` within the same `sectionHash` (`blockHash` for sentences);
 * 2. exact `hash` + `occurrence` anywhere;
 * 3. exact `hash`, any occurrence, nearest to `pos` (ties → lowest index);
 * 4. Sørensen–Dice ≥ 0.8 among candidates of the same kind, same section first and then the whole
 *    document (ties → highest score, then lowest index);
 * 5. no match — the caller orphans the entry (`null` here).
 *
 * Pure: the document is only read.
 */
export function resolveAnchor(
  anchor: Anchor,
  root: Root,
  options: ResolveOptions = {},
): Resolution | null {
  const pool = (options.candidates ?? candidatesOf(root, options)).filter(
    (candidate) => candidate.kind === anchor.kind,
  );
  const sameHash = pool.filter((candidate) => candidate.hash === anchor.hash);
  const duplicate = sameHash.length > 1;
  const found = (step: ResolutionStep, candidate: AnchorCandidate, score: number | null) => ({
    step,
    anchor: anchorOf(candidate),
    score,
    duplicate,
  });

  // Step 1 — scoped exact match. Sentences are scoped by their paragraph, everything else by its
  // section, exactly as §6.2 words it.
  const inScope = (candidate: AnchorCandidate): boolean =>
    anchor.kind === "sentence"
      ? candidate.blockHash === anchor.blockHash
      : candidate.sectionHash === anchor.sectionHash;
  const scoped = sameHash.find(
    (candidate) => candidate.occurrence === anchor.occurrence && inScope(candidate),
  );
  if (scoped !== undefined) return found(1, scoped, null);

  // Step 2 — exact match anywhere.
  const anywhere = sameHash.find((candidate) => candidate.occurrence === anchor.occurrence);
  if (anywhere !== undefined) return found(2, anywhere, null);

  // Step 3 — same text, different ordinal: keep the one at the remembered position.
  if (sameHash.length > 0) {
    let best = sameHash[0];
    let bestDistance = posDistance(best.pos, anchor.pos);
    for (const candidate of sameHash.slice(1)) {
      const distance = posDistance(candidate.pos, anchor.pos);
      if (distanceIsLess(distance, bestDistance)) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return found(3, best, null);
  }

  // Step 4 — fuzzy, same section before the whole document.
  const scored = pool
    .map((candidate) => ({ candidate, score: sorensenDice(candidate.text, anchor.text) }))
    .filter((entry) => entry.score >= DICE_THRESHOLD);
  const sectioned = scored.filter(
    (entry) => entry.candidate.sectionHash === anchor.sectionHash,
  );
  const field = sectioned.length > 0 ? sectioned : scored;
  if (field.length > 0) {
    // Ties → highest score, then lowest index. `field` is already in index order.
    const best = field.reduce((a, b) => (b.score > a.score ? b : a));
    return found(4, best.candidate, best.score);
  }

  // Step 5.
  return null;
}

// ---------------------------------------------------------------------------
// attach / refresh
// ---------------------------------------------------------------------------

/** What `attach` did with one entry; `step: 5` means it went to `orphans`. */
export interface AttachResolution {
  readonly list: SidecarList;
  /** Index of the entry in the **input** sidecar's list. */
  readonly index: number;
  readonly step: ResolutionStep | 5;
  readonly score: number | null;
  readonly duplicate: boolean;
}

export interface AttachResult {
  readonly sidecar: Sidecar;
  readonly resolutions: readonly AttachResolution[];
}

type Entry = HeadingEntry | RewriteEntry | CoachEntry;

/**
 * Resolve every anchor of a sidecar against a document (§6.2, load time).
 *
 * Entries that resolve keep their list with a rebuilt anchor; entries that do not are appended to
 * `orphans` carrying the anchor they were written against, so the "Unattached" sidebar can show
 * the original text. Existing orphans are left alone — §6.2 gives the user the drag-or-delete
 * choice, and silently re-attaching one behind their back is not that choice.
 *
 * Front matter is mirrored into `title`/`topicQuestion` on the way (sidecar wins on conflict); the
 * document is never written to here, per §6.1 ("never on open").
 *
 * Pure: neither argument is mutated.
 */
export function attach(sidecar: Sidecar, root: Root, options: SegmentOptions = {}): AttachResult {
  const candidates = candidatesOf(root, options);
  const resolutions: AttachResolution[] = [];
  const orphans: Orphan[] = [...sidecar.orphans];

  const resolveList = <T extends Entry>(list: SidecarList, entries: readonly T[]): T[] => {
    const kept: T[] = [];
    entries.forEach((entry, index) => {
      const resolution = resolveAnchor(entry.anchor, root, { ...options, candidates });
      if (resolution === null) {
        resolutions.push({ list, index, step: 5, score: null, duplicate: false });
        orphans.push({ list, entry } as Orphan);
        return;
      }
      resolutions.push({
        list,
        index,
        step: resolution.step,
        score: resolution.score,
        duplicate: resolution.duplicate,
      });
      kept.push({ ...entry, anchor: resolution.anchor });
    });
    return kept;
  };

  const mirrored = mirrorFrontMatter(sidecar, root);
  return {
    sidecar: {
      ...mirrored,
      headings: resolveList("headings", sidecar.headings),
      rewrites: resolveList("rewrites", sidecar.rewrites),
      coach: resolveList("coach", sidecar.coach),
      orphans,
    },
    resolutions,
  };
}

/**
 * The save-time half of §6.2: `pos` "refreshed on every save". Refreshing a position means finding
 * the item again, which is the same five-step resolution `attach` runs, so this is `attach`'s
 * sidecar without the per-entry diagnostics the sidebar needs on load.
 */
export function refresh(sidecar: Sidecar, root: Root, options: SegmentOptions = {}): Sidecar {
  return attach(sidecar, root, options).sidecar;
}

// ---------------------------------------------------------------------------
// In-app operations keep anchors on their logical item (§6.2, duplicate limit)
// ---------------------------------------------------------------------------

export interface DocumentState {
  readonly root: Root;
  readonly sidecar: Sidecar;
}

/**
 * Rebuild every anchor of a sidecar at a position the caller computes, against the document that
 * an in-app operation just produced.
 *
 * This is the mechanism behind §6.2's "In-app operations update anchors live, so identity follows
 * the logical item": the operation knows which item moved where, which the Markdown itself does not
 * record when two items are byte-identical. `mapPos` returns the anchor's new position, or `null`
 * when the operation destroyed the item; anything `mapPos` sends to a position the document has no
 * candidate at is orphaned.
 *
 * Callers pass a sidecar whose positions are current, i.e. one that `attach` or `refresh` produced.
 *
 * Pure: neither argument is mutated.
 */
export function reanchor(
  sidecar: Sidecar,
  root: Root,
  mapPos: (anchor: Anchor) => readonly number[] | null,
  options: SegmentOptions = {},
): Sidecar {
  const candidates = candidatesOf(root, options);
  const orphans: Orphan[] = [...sidecar.orphans];

  const remapList = <T extends Entry>(list: SidecarList, entries: readonly T[]): T[] => {
    const kept: T[] = [];
    for (const entry of entries) {
      const pos = mapPos(entry.anchor);
      const candidate = pos === null ? null : candidateAt(candidates, entry.anchor.kind, pos);
      if (candidate === null) {
        orphans.push({ list, entry } as Orphan);
        continue;
      }
      kept.push({ ...entry, anchor: anchorOf(candidate) });
    }
    return kept;
  };

  return {
    ...sidecar,
    headings: remapList("headings", sidecar.headings),
    rewrites: remapList("rewrites", sidecar.rewrites),
    coach: remapList("coach", sidecar.coach),
    orphans,
  };
}

/**
 * `reorderSentences` (§6.1) with the sidecar carried along: each variant, question and coach entry
 * moves with its **logical** sentence, which is what makes an in-app reorder of two byte-identical
 * sentences meaningful — the resulting Markdown holds no evidence of the swap (§6.2).
 *
 * @throws the same errors as `reorderSentences` (not a top-level paragraph; `order` not a
 * permutation), before anything is changed.
 */
export function applyReorderSentences(
  state: DocumentState,
  blockId: string,
  order: readonly number[],
  options: SegmentOptions = {},
): DocumentState {
  const root = reorderSentences(state.root, blockId, order, options);
  const block = blocksOf(state.root).find((candidate) => candidate.contentId === blockId);
  // `reorderSentences` already rejected everything else, so the block exists and is top-level.
  const at = (block as NonNullable<typeof block>).path[0];

  const sidecar = reanchor(
    state.sidecar,
    root,
    (anchor) => {
      if (anchor.kind !== "sentence" || anchor.pos[0] !== at) return anchor.pos;
      // `order[p]` is the sentence that lands at position `p`, so the sentence that was at index
      // `i` is now wherever `order` names it.
      const moved = order.indexOf(anchor.pos[1]);
      return moved === -1 ? null : [at, moved];
    },
    options,
  );
  return { root, sidecar };
}

const MOVE_TAG = "__essaydownMoveIndex";

/**
 * `moveSection` (§6.1, the Outline drag of §7) with the sidecar carried along: every anchor inside
 * the moved section travels with it, and every anchor the move shifted is rebuilt at its new
 * position — so two identical H2 headings keep their own questions across an in-app move.
 *
 * The index permutation is read back out of `moveSection`'s own result (each top-level child is
 * tagged before the call and the tag is stripped after) rather than recomputed here, so the two
 * cannot drift.
 *
 * @throws the same errors as `moveSection`, before anything is changed.
 */
export function applyMoveSection(
  state: DocumentState,
  from: number,
  to: number,
  options: SegmentOptions = {},
): DocumentState {
  const tagged: Root = {
    ...state.root,
    children: state.root.children.map(
      (child, index) => ({ ...child, [MOVE_TAG]: index }) as unknown as RootContent,
    ),
  };
  const moved = moveSection(tagged, from, to);

  const oldToNew = new Map<number, number>();
  const children: RootContent[] = moved.children.map((child, index) => {
    const copy = { ...child } as RootContent & { [MOVE_TAG]?: number };
    const previous = copy[MOVE_TAG];
    if (typeof previous === "number") oldToNew.set(previous, index);
    delete copy[MOVE_TAG];
    return copy;
  });
  const root: Root = { ...moved, children };

  const sidecar = reanchor(
    state.sidecar,
    root,
    (anchor) => {
      const at = oldToNew.get(anchor.pos[0]);
      return at === undefined ? null : [at, ...anchor.pos.slice(1)];
    },
    options,
  );
  return { root, sidecar };
}

// ---------------------------------------------------------------------------
// Front matter: the two app-owned keys (§6.1)
// ---------------------------------------------------------------------------

/** The only two front-matter keys the app owns (§6.1). Every other byte is opaque. */
export const FRONT_MATTER_KEYS = ["title", "question"] as const;
export type FrontMatterKey = (typeof FRONT_MATTER_KEYS)[number];

/** The error §6.1 names for a write the supported boundary excludes. */
export const FRONT_MATTER_UNSUPPORTED = "FrontMatterUnsupported";

/**
 * Why an app-owned key is read-only. `block-scalar`, `flow`, `indicator`, `multi-line`,
 * `duplicate` and `malformed` are the §6.1 list; `no-front-matter` is the document having no yaml
 * block at all, which §6.1 does not ask the app to create.
 */
export type FrontMatterUnsupportedReason =
  | "block-scalar"
  | "flow"
  | "indicator"
  | "multi-line"
  | "duplicate"
  | "malformed"
  | "no-front-matter";

/** Quoting style of a scalar, preserved across a rewrite (§6.1). `""` is a plain scalar. */
export type FrontMatterQuote = "" | "'" | '"';

export interface FrontMatterField {
  readonly key: FrontMatterKey;
  readonly writable: true;
  /** The scalar with its quoting removed and its escapes resolved. */
  readonly value: string;
  readonly quote: FrontMatterQuote;
  /** Everything after the scalar, verbatim — the spaces and the `# comment`, or `""`. */
  readonly comment: string;
  /** 0-based line of the key inside the yaml block's value. */
  readonly line: number;
  /** The line up to the first character of the scalar, verbatim: `"question: "` and any extra space. */
  readonly prefix: string;
}

export interface FrontMatterUnsupportedField {
  readonly key: FrontMatterKey;
  readonly writable: false;
  readonly reason: FrontMatterUnsupportedReason;
  /** Best-effort text for Outline's greyed display; null when there is nothing single-line to show. */
  readonly value: string | null;
}

export type FrontMatterEntry = FrontMatterField | FrontMatterUnsupportedField;

export interface FrontMatter {
  /** Whether the document has a yaml front-matter block at all. */
  readonly present: boolean;
  /** The block's raw value, exactly as the parser captured it (`""` when absent). */
  readonly value: string;
  /** The block is not a flat line-oriented mapping, so every app-owned key is read-only (§6.1). */
  readonly malformed: boolean;
  readonly title: FrontMatterEntry | null;
  readonly question: FrontMatterEntry | null;
}

/** The document's yaml node, which `remark-frontmatter` only ever produces as the first child. */
function yamlNodeOf(root: Root): { node: Yaml; index: number } | null {
  const index = root.children.findIndex((child) => child.type === "yaml");
  return index === -1 ? null : { node: root.children[index] as Yaml, index };
}

/** `key:` or `key: rest` at column 0. A key containing `:` cannot match, and does not have to. */
const KEY_LINE = /^([^\s#][^:]*):(?:[ \t](.*))?$/u;
const BLANK_OR_COMMENT = /^\s*(?:#.*)?$/u;
const INDENTED = /^[ \t]+\S/u;

interface KeyLine {
  readonly key: string;
  /** Everything after `key:` and the one space or tab that follows it (`""` for a bare `key:`). */
  readonly raw: string;
  /** `line.length - raw.length`, i.e. where `raw` starts — `""` raw means the line ends at `key:`. */
  readonly rawStart: number;
  /** The whole line, verbatim, so a rewrite can keep every byte before the scalar. */
  readonly text: string;
  readonly line: number;
  readonly continued: boolean;
}

/** Scan the yaml block as the flat mapping §6.1's supported boundary describes. */
function scanFrontMatter(value: string): { lines: string[]; keys: KeyLine[]; malformed: boolean } {
  const lines = value === "" ? [] : value.split("\n");
  const keys: KeyLine[] = [];
  let malformed = false;

  lines.forEach((line, index) => {
    if (BLANK_OR_COMMENT.test(line)) return;
    if (INDENTED.test(line)) {
      // A continuation only makes sense under a key; anything else is not the shape we support.
      if (keys.length === 0) malformed = true;
      return;
    }
    const match = KEY_LINE.exec(line);
    if (match === null) {
      malformed = true;
      return;
    }
    const raw = match[2] ?? "";
    keys.push({
      key: match[1].trimEnd(),
      raw,
      rawStart: line.length - raw.length,
      text: line,
      line: index,
      continued: false,
    });
  });

  // A key whose next non-blank line is indented has a value this task cannot rewrite in place.
  const withContinuation = keys.map((entry) => {
    for (let i = entry.line + 1; i < lines.length; i += 1) {
      if (BLANK_OR_COMMENT.test(lines[i])) continue;
      return { ...entry, continued: INDENTED.test(lines[i]) };
    }
    return entry;
  });

  return { lines, keys: withContinuation, malformed };
}

/**
 * Split a plain scalar from the leading whitespace before it and the trailing ` # comment` after it
 * (YAML only reads a `#` as a comment when whitespace precedes it).
 */
function splitPlain(raw: string): { lead: number; value: string; comment: string } {
  const lead = raw.length - raw.trimStart().length;
  let cut = raw.length;
  for (let i = lead; i < raw.length; i += 1) {
    if (raw[i] === "#" && (i === 0 || /\s/u.test(raw[i - 1]))) {
      cut = i;
      break;
    }
  }
  let end = cut;
  while (end > lead && /\s/u.test(raw[end - 1])) end -= 1;
  return { lead, value: raw.slice(lead, end), comment: raw.slice(end) };
}

/** Read a single-quoted scalar (`''` is a literal quote), or null if it does not close on the line. */
function readSingleQuoted(raw: string): { value: string; rest: string } | null {
  let value = "";
  for (let i = 1; i < raw.length; i += 1) {
    if (raw[i] !== "'") {
      value += raw[i];
      continue;
    }
    if (raw[i + 1] === "'") {
      value += "'";
      i += 1;
      continue;
    }
    return { value, rest: raw.slice(i + 1) };
  }
  return null;
}

const DOUBLE_ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  "0": "\0",
  '"': '"',
  "\\": "\\",
  "/": "/",
};

/** Read a double-quoted scalar with backslash escapes, or null if it does not close on the line. */
function readDoubleQuoted(raw: string): { value: string; rest: string } | null {
  let value = "";
  for (let i = 1; i < raw.length; i += 1) {
    if (raw[i] === "\\") {
      const next = raw[i + 1];
      if (next === undefined) return null;
      value += DOUBLE_ESCAPES[next] ?? next;
      i += 1;
      continue;
    }
    if (raw[i] === '"') return { value, rest: raw.slice(i + 1) };
    value += raw[i];
  }
  return null;
}

/** Classify one app-owned key's line against the §6.1 supported boundary. */
function classify(key: FrontMatterKey, entry: KeyLine): FrontMatterEntry {
  const unsupported = (
    reason: FrontMatterUnsupportedReason,
    value: string | null,
  ): FrontMatterUnsupportedField => ({ key, writable: false, reason, value });

  const raw = entry.raw;
  const head = raw.trimStart()[0];
  // The block-scalar indicators are checked before the continuation, because the indented lines a
  // block scalar owns are exactly what would otherwise read as an ordinary multi-line value.
  if (head === "|" || head === ">") return unsupported("block-scalar", null);
  if (entry.continued) return unsupported("multi-line", null);
  if (head === "[" || head === "{") return unsupported("flow", raw.trim());
  if (head !== undefined && "&*!%@`".includes(head)) return unsupported("indicator", raw.trim());

  const field = (
    value: string,
    quote: FrontMatterQuote,
    lead: number,
    comment: string,
  ): FrontMatterField => ({
    key,
    writable: true,
    value,
    quote,
    comment,
    line: entry.line,
    // A bare `key:` has nothing after the colon, so the rewrite has to supply the separating space.
    prefix:
      raw === "" ? `${entry.text.slice(0, entry.rawStart)} ` : entry.text.slice(0, entry.rawStart + lead),
  });

  if (head === "'" || head === '"') {
    const lead = raw.length - raw.trimStart().length;
    const read = head === "'" ? readSingleQuoted(raw.slice(lead)) : readDoubleQuoted(raw.slice(lead));
    if (read === null) return unsupported("multi-line", null);
    if (!BLANK_OR_COMMENT.test(read.rest)) return unsupported("malformed", null);
    return field(read.value, head, lead, read.rest);
  }

  const plain = splitPlain(raw);
  return field(plain.value, "", plain.lead, plain.comment);
}

/**
 * The two app-owned keys of the document's front matter (§6.1), each `null` when the block does not
 * carry it, a writable field when it is a unique top-level single-line scalar, and a read-only
 * field with a reason otherwise.
 *
 * Pure: the document is only read.
 */
export function readFrontMatter(root: Root): FrontMatter {
  const yaml = yamlNodeOf(root);
  if (yaml === null) {
    return { present: false, value: "", malformed: false, title: null, question: null };
  }

  const { keys, malformed } = scanFrontMatter(yaml.node.value);
  const entryFor = (key: FrontMatterKey): FrontMatterEntry | null => {
    const matches = keys.filter((line) => line.key === key);
    if (matches.length === 0) return null;
    if (malformed) return { key, writable: false, reason: "malformed", value: null };
    if (matches.length > 1) {
      return { key, writable: false, reason: "duplicate", value: matches[0].raw.trim() };
    }
    return classify(key, matches[0]);
  };

  return {
    present: true,
    value: yaml.node.value,
    malformed,
    title: entryFor("title"),
    question: entryFor("question"),
  };
}

/** Whether a plain scalar would be re-read as something other than this exact string. */
function needsQuoting(value: string): boolean {
  if (value === "") return true;
  if (value !== value.trim()) return true;
  if (/[\n\r\t]/u.test(value)) return true;
  if (/(?:^|\s)#/u.test(value)) return true;
  if (/:(?:\s|$)/u.test(value)) return true;
  return "-?:,[]{}#&*!|>'\"%@`".includes(value[0]);
}

/** Serialize a value in the quoting style the line already used, promoting a plain scalar if it must. */
function serializeScalar(value: string, quote: FrontMatterQuote): string {
  if (quote === "'") return `'${value.replace(/'/gu, "''")}'`;
  if (quote === '"') return JSON.stringify(value);
  return needsQuoting(value) ? JSON.stringify(value) : value;
}

export type FrontMatterWrite =
  | { readonly ok: true; readonly root: Root; readonly changed: readonly FrontMatterKey[] }
  | {
      readonly ok: false;
      readonly error: typeof FRONT_MATTER_UNSUPPORTED;
      readonly key: FrontMatterKey;
      readonly reason: FrontMatterUnsupportedReason;
      readonly root: Root;
    };

/**
 * Write app-owned front-matter keys in place (§6.1: "only those two lines are rewritten in place
 * and every other byte of the block is preserved").
 *
 * A key whose value is already what is asked for is not rewritten at all, so a save with an
 * unchanged topic question leaves the yaml block byte-identical and invariant C still holds on it.
 * A key the supported boundary excludes returns `FrontMatterUnsupported` and **nothing** is
 * rewritten — the returned `root` is the one that came in, so the caller saves the block unchanged.
 * A key the block does not carry yet is appended as one new line; creating a front-matter block
 * where there is none is not the app's job (`no-front-matter`).
 *
 * Pure: the argument is not mutated.
 */
export function writeFrontMatter(
  root: Root,
  values: Partial<Record<FrontMatterKey, string>>,
): FrontMatterWrite {
  const requested = FRONT_MATTER_KEYS.filter((key) => values[key] !== undefined);
  if (requested.length === 0) return { ok: true, root, changed: [] };

  const yaml = yamlNodeOf(root);
  const current = readFrontMatter(root);
  if (yaml === null) {
    return {
      ok: false,
      error: FRONT_MATTER_UNSUPPORTED,
      key: requested[0],
      reason: "no-front-matter",
      root,
    };
  }
  for (const key of requested) {
    const entry = current[key];
    if (entry !== null && !entry.writable) {
      return { ok: false, error: FRONT_MATTER_UNSUPPORTED, key, reason: entry.reason, root };
    }
    if (entry === null && current.malformed) {
      return { ok: false, error: FRONT_MATTER_UNSUPPORTED, key, reason: "malformed", root };
    }
  }

  const lines = yaml.node.value === "" ? [] : yaml.node.value.split("\n");
  const changed: FrontMatterKey[] = [];
  for (const key of requested) {
    const value = values[key] as string;
    const entry = current[key] as FrontMatterField | null;
    if (entry === null) {
      lines.push(`${key}: ${serializeScalar(value, "")}`);
      changed.push(key);
      continue;
    }
    if (entry.value === value) continue;
    lines[entry.line] = `${entry.prefix}${serializeScalar(value, entry.quote)}${entry.comment}`;
    changed.push(key);
  }
  if (changed.length === 0) return { ok: true, root, changed: [] };

  const children = [...root.children];
  children[yaml.index] = { ...yaml.node, value: lines.join("\n") };
  return { ok: true, root: { ...root, children }, changed };
}

/**
 * Mirror the document's front-matter `title`/`question` into the sidecar (§6.2: "Front-matter
 * `title`/`question` are mirrored; sidecar wins on conflict"). A value the sidecar already holds is
 * kept, so only a key the sidecar has nothing for is taken from the document, and only from a
 * writable field — a value the app cannot write back is not one it claims to own.
 *
 * Pure: neither argument is mutated, and in particular the document is never written to (§6.1:
 * the mirror writes to front matter "only on such an in-app edit, never on open").
 */
export function mirrorFrontMatter(sidecar: Sidecar, root: Root): Sidecar {
  const front = readFrontMatter(root);
  const mirrored = (entry: FrontMatterEntry | null): string | null =>
    entry !== null && entry.writable ? entry.value : null;
  return {
    ...sidecar,
    title: sidecar.title ?? mirrored(front.title),
    topicQuestion: sidecar.topicQuestion ?? mirrored(front.question),
  };
}
