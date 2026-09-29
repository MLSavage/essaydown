import { describe, expect, it } from "vitest";
import type { Root } from "mdast";
import { candidatesOf, emptySidecar, type Anchor, type Sidecar } from "../packages/core/src/sidecar.js";
import { parse } from "../packages/core/src/parse.js";
import { chooseSidecarForWrite } from "../apps/desktop/src/workspace/sidecar-sync.js";

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
