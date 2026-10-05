import { describe, expect, it } from "vitest";
import type { Root } from "mdast";
import { candidatesOf, emptySidecar, type Anchor, type Sidecar } from "../packages/core/src/sidecar.js";
import { parse } from "../packages/core/src/parse.js";
import {
  chooseSidecarForWrite,
  createSidecarBaseline,
  type SidecarBaseline,
  type SidecarOwner,
} from "../apps/desktop/src/workspace/sidecar-sync.js";

// apps/desktop/src/workspace/sidecar-sync.ts (task 2.19, DECISIONS #review-2-r0 U5): the pane
// re-reads the sidecar immediately before writing it, so an external writer's fields survive the
// next autosave instead of being overwritten by the pane's stale in-memory copy.

/** The heading anchor for the first candidate whose normalized text is `text`, as the document
 * currently holds it (mirrors packages/core/test/sidecar.test.ts's own `anchorFor`). */
function headingAnchor(root: Root, text: string): Anchor {
  const candidate = candidatesOf(root).find((one) => one.kind === "heading" && one.text === text);
  if (candidate === undefined) throw new Error(`no heading candidate for ${text}`);
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

function rawOf(sidecar: Sidecar): string {
  return JSON.stringify(sidecar);
}

const PLAIN_DOC = "Hello.\n";

describe("chooseSidecarForWrite", () => {
  it("absent → absent writes ours", () => {
    const ours: Sidecar = { ...emptySidecar(), title: "Mine" };
    const result = chooseSidecarForWrite(null, null, ours, parse(PLAIN_DOC));
    expect(result.action).toBe("write");
    expect(result.action === "write" && result.sidecar.title).toBe("Mine");
  });

  it("absent → externally created takes the disk", () => {
    const disk: Sidecar = { ...emptySidecar(), title: "Synced title", topicQuestion: "Synced question" };
    const result = chooseSidecarForWrite(null, rawOf(disk), emptySidecar(), parse(PLAIN_DOC));
    expect(result.action).toBe("write");
    expect(result.action === "write" && result.sidecar.title).toBe("Synced title");
    expect(result.action === "write" && result.sidecar.topicQuestion).toBe("Synced question");
  });

  it("present and unchanged writes ours", () => {
    const disk: Sidecar = { ...emptySidecar(), title: "Old" };
    const known = rawOf(disk);
    const ours: Sidecar = { ...emptySidecar(), title: "Mine" };
    const result = chooseSidecarForWrite(known, known, ours, parse(PLAIN_DOC));
    expect(result.action).toBe("write");
    expect(result.action === "write" && result.sidecar.title).toBe("Mine");
  });

  it("present and changed takes the disk with the new root's headings refreshed", () => {
    const rootV1 = parse("## Question\n\nBody one.\n");
    const anchor = headingAnchor(rootV1, "Question");
    const known = rawOf(emptySidecar());
    const disk: Sidecar = { ...emptySidecar(), headings: [{ anchor, question: "why?" }] };
    // A paragraph now precedes the heading: its own top-level index moves from 0 to 1, so a
    // pass-through of the disk's anchor (rather than a re-attach against this root) would leave
    // the old position instead.
    const rootV2 = parse("Intro.\n\n## Question\n\nBody one.\n");
    const result = chooseSidecarForWrite(known, rawOf(disk), emptySidecar(), rootV2);
    expect(result.action).toBe("write");
    const headings = result.action === "write" ? result.sidecar.headings : [];
    expect(headings).toHaveLength(1);
    expect(headings[0].anchor.pos).toEqual([1]);
    expect(headings[0].question).toBe("why?");
  });

  it("disk invalid skips and reports", () => {
    const result = chooseSidecarForWrite(null, "{ not json", emptySidecar(), parse(PLAIN_DOC));
    expect(result.action).toBe("skip");
    expect(result.action === "skip" && result.error).toBeInstanceOf(Error);
  });
});

// Task 2.23 (DECISIONS #review-2-r1 U5): the baseline the pane writes from moves its raw text and
// its sidecar together, so a value adopted from the disk at one save is still the source at the next.

/** The document store's part in a save (task 3.2): it owns the parsed sidecar. */
function ownerOf(start: Sidecar): SidecarOwner & { adopted: number } {
  let sidecar = start;
  return {
    adopted: 0,
    current: () => sidecar,
    adopt(next) {
      sidecar = next;
      this.adopted += 1;
    },
  };
}

/** One pane save as DocumentPane runs it: read the owner's sidecar with the root, choose against
 * the disk, write, then move the baseline; a skip writes nothing and leaves the baseline alone.
 * Returns what the disk holds afterwards. */
function save(
  baseline: SidecarBaseline,
  owner: SidecarOwner,
  diskRaw: string | null,
  root: Root,
): { disk: string | null; written: Sidecar | null } {
  const choice = baseline.choose(diskRaw, root, owner.current());
  if (choice.action === "skip") return { disk: diskRaw, written: null };
  const raw = `${JSON.stringify(choice.sidecar, null, 2)}\n`;
  baseline.wrote(raw, choice);
  return { disk: raw, written: choice.sidecar };
}

const EXTERNAL: Sidecar = { ...emptySidecar(), title: "Synced title", topicQuestion: "Synced question" };

describe("createSidecarBaseline", () => {
  it("guard 1: absent → external write → two saves keep both external values at save 2", () => {
    const owner = ownerOf(emptySidecar());
    const baseline = createSidecarBaseline(null, owner);
    const first = save(baseline, owner, rawOf(EXTERNAL), parse("Hello.X\n"));
    expect(first.written?.title).toBe("Synced title");
    const second = save(baseline, owner, first.disk, parse("Hello.XY\n"));
    expect(second.written?.title).toBe("Synced title");
    expect(second.written?.topicQuestion).toBe("Synced question");
  });

  it("guard 2: present-and-unchanged start → external change → two saves keep both external values at save 2", () => {
    const start: Sidecar = { ...emptySidecar(), title: "Old title" };
    const startRaw = rawOf(start);
    const owner = ownerOf(start);
    const baseline = createSidecarBaseline(startRaw, owner);
    // Present and unchanged: a save before the external change writes the pane's own copy.
    const zero = save(baseline, owner, startRaw, parse(PLAIN_DOC));
    expect(zero.written?.title).toBe("Old title");
    const first = save(baseline, owner, rawOf(EXTERNAL), parse("Hello.X\n"));
    expect(first.written?.title).toBe("Synced title");
    const second = save(baseline, owner, first.disk, parse("Hello.XY\n"));
    expect(second.written?.title).toBe("Synced title");
    expect(second.written?.topicQuestion).toBe("Synced question");
  });

  it("guard 3: a second external write between save 1 and save 2 is adopted at save 2", () => {
    const owner = ownerOf(emptySidecar());
    const baseline = createSidecarBaseline(null, owner);
    save(baseline, owner, rawOf(EXTERNAL), parse("Hello.X\n"));
    const later: Sidecar = { ...emptySidecar(), title: "Later title", topicQuestion: "Later question" };
    const second = save(baseline, owner, rawOf(later), parse("Hello.XY\n"));
    expect(second.written?.title).toBe("Later title");
    expect(second.written?.topicQuestion).toBe("Later question");
  });

  it("guard 4: a skip on an invalid disk leaves the owner's sidecar and the raw baseline unchanged", () => {
    const start: Sidecar = { ...emptySidecar(), title: "Old title" };
    const startRaw = rawOf(start);
    const owner = ownerOf(start);
    const baseline = createSidecarBaseline(startRaw, owner);
    const skipped = save(baseline, owner, "{ not json", parse("Hello.X\n"));
    expect(skipped.written).toBeNull();
    expect(owner.current()).toBe(start);
    expect(owner.adopted).toBe(0);
    // The raw baseline is still the old raw: the old bytes back on disk read as unchanged, so the
    // pane's own copy is written (a moved raw would read them as an external change).
    const ours: Sidecar = { ...emptySidecar(), title: "Old title", topicQuestion: "Pane only" };
    const moved = createSidecarBaseline("{ not json", ownerOf(ours));
    expect(moved.choose(startRaw, parse(PLAIN_DOC), ours)).toMatchObject({ action: "write", sidecar: { topicQuestion: null } });
    const kept = createSidecarBaseline(startRaw, ownerOf(ours));
    kept.choose("{ not json", parse(PLAIN_DOC), ours);
    expect(kept.choose(startRaw, parse(PLAIN_DOC), ours)).toMatchObject({ action: "write", sidecar: { topicQuestion: "Pane only" } });
  });

  it("guard 5: an adopted disk sidecar becomes the owner's, so a reload seeded from the owner carries the adopted title", () => {
    const owner = ownerOf(emptySidecar());
    const baseline = createSidecarBaseline(null, owner);
    const first = save(baseline, owner, rawOf(EXTERNAL), parse("Hello.X\n"));
    expect(owner.current()).toBe(first.written);
    expect(owner.current().title).toBe("Synced title");
    expect(owner.current().topicQuestion).toBe("Synced question");
  });

  it("guard 6: writing the owner's own sidecar moves the raw baseline and adopts nothing — the next choose compares against the written raw", () => {
    const ours: Sidecar = { ...emptySidecar(), title: "Ours" };
    const owner = ownerOf(ours);
    const baseline = createSidecarBaseline(null, owner);
    const first = save(baseline, owner, null, parse(PLAIN_DOC));
    expect(owner.adopted).toBe(0);
    expect(owner.current()).toBe(ours);
    // Disk equals the written raw: unchanged, so the owner's sidecar is the source again.
    const edited: Sidecar = { ...ours, title: "Edited in the app" };
    owner.adopt(edited);
    expect(baseline.choose(first.disk, parse(PLAIN_DOC), owner.current())).toMatchObject({
      action: "write",
      adopted: false,
      sidecar: { title: "Edited in the app" },
    });
  });

  it("guard 7: an in-app edit made during the write is kept over the disk sidecar the choice adopted", () => {
    const owner = ownerOf(emptySidecar());
    const baseline = createSidecarBaseline(null, owner);
    const choice = baseline.choose(rawOf(EXTERNAL), parse(PLAIN_DOC), owner.current());
    expect(choice).toMatchObject({ action: "write", adopted: true });
    const edit: Sidecar = { ...emptySidecar(), topicQuestion: "Typed during the write" };
    owner.adopt(edit);
    if (choice.action !== "write") throw new Error("unreachable");
    baseline.wrote(`${JSON.stringify(choice.sidecar)}\n`, choice);
    expect(owner.current()).toBe(edit);
  });
});
